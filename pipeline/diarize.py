"""
Who is speaking, from how the voice sounds.

Speech recognition gives words, not people. That gap matters more here than in
most caption pipelines: colour, screen position and per-character marks all
answer "who is talking", so a transcript with one speaker produces captions
where the entire attribution layer is inert — technically correct, and conveying
nothing the design exists to convey.

The usual answer is pyannote, which is genuinely better than this and costs a
Hugging Face account, an accepted licence, a token and a model download. That is
a reasonable thing to require of a studio and an unreasonable thing to require
of someone trying the tool for the first time. So this separates voices using
the acoustics the pipeline already measures for typography.

**What it can and cannot do, plainly.** It clusters utterances by pitch and
timbre. Two speakers an octave apart separate reliably. Two speakers of similar
range separate poorly, and two performances by the same actor will not separate
at all. It has no idea of identity across a cut, no idea who is on camera, and
it will merge a whisper and a shout from one person less often than it should.

It is the difference between attribution being approximate and being absent.
When the recording justifies better, install pyannote and use the WhisperX path;
the manifest shape is identical either way.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from acoustics import SAMPLE_RATE, decode_to_wav, read_wav, analyze_frames

#: Longest pause inside one person's turn. Beyond this, assume a new utterance.
TURN_GAP_S = 0.55
#: Utterances shorter than this carry too little voiced audio to characterise.
MIN_UTTERANCE_S = 0.35
#: Most speakers a scene is assumed to have. Beyond a handful, the features
#: here cannot tell people apart and more clusters would be invented detail.
MAX_SPEAKERS = 4
#: An extra cluster must reduce within-cluster spread by at least this share to
#: be believed. Without it, k-means will always "improve" and every scene ends
#: up with the maximum number of speakers.
MIN_IMPROVEMENT = 0.22


def utterances(words: list[dict], gap: float = TURN_GAP_S) -> list[list[int]]:
    """Group word indices into runs separated by a pause."""
    if not words:
        return []
    groups, cur = [], [0]
    for i in range(1, len(words)):
        if words[i]["start"] - words[i - 1]["end"] > gap:
            groups.append(cur)
            cur = [i]
        else:
            cur.append(i)
    groups.append(cur)
    return groups


def _features(frames, start: float, end: float) -> np.ndarray | None:
    """
    Median log-pitch and log-centroid over the voiced frames of a span.

    Logs because both quantities are perceived multiplicatively: the distance
    from 100 to 200 Hz is the distance from 200 to 400, and a linear scale would
    let one loud low voice dominate every clustering decision.
    """
    i0 = max(0, int(start / frames.hop_s))
    i1 = min(len(frames.f0), int(end / frames.hop_s) + 1)
    if i1 <= i0:
        return None
    voiced = frames.voiced[i0:i1]
    if voiced.sum() < 3:
        return None
    f0 = frames.f0[i0:i1][voiced]
    centroid = frames.centroid[i0:i1][voiced]
    f0 = f0[f0 > 0]
    if len(f0) < 3:
        return None
    return np.array([
        np.log(np.median(f0)),
        np.log(max(np.median(centroid), 1.0)),
    ], dtype=np.float64)


def _kmeans(x: np.ndarray, k: int, seed: int = 0, iters: int = 60) -> tuple[np.ndarray, float]:
    """
    Minimal k-means. Returns labels and the within-cluster sum of squares.

    Seeded deterministically: a caption pass that assigned different speakers on
    a second run over the same file would be worse than useless to an editor.
    """
    rng = np.random.default_rng(seed)
    # k-means++ style seeding, which matters at k=2 on bimodal data where
    # random seeding regularly puts both centres in the same cluster.
    centres = [x[rng.integers(len(x))]]
    for _ in range(1, k):
        d = np.min([np.sum((x - c) ** 2, axis=1) for c in centres], axis=0)
        total = d.sum()
        probs = d / total if total > 0 else None
        centres.append(x[rng.choice(len(x), p=probs)])
    c = np.array(centres)

    labels = np.zeros(len(x), dtype=int)
    for _ in range(iters):
        d = ((x[:, None, :] - c[None, :, :]) ** 2).sum(axis=2)
        new = d.argmin(axis=1)
        if np.array_equal(new, labels):
            break
        labels = new
        for j in range(k):
            if (labels == j).any():
                c[j] = x[labels == j].mean(axis=0)
    wss = float(sum(((x[labels == j] - c[j]) ** 2).sum() for j in range(k)))
    return labels, wss


def choose_k(x: np.ndarray, max_k: int = MAX_SPEAKERS) -> tuple[int, np.ndarray]:
    """
    How many voices are in this scene?

    Runs k-means for each k and keeps the largest one that still bought a
    meaningful reduction in spread. Guessing high is the more damaging error:
    inventing a speaker splits one actor across two colours mid-scene, which
    reads as a continuity error rather than as a caption defect.
    """
    if len(x) < 2:
        return 1, np.zeros(len(x), dtype=int)

    best_k, best_labels = 1, np.zeros(len(x), dtype=int)
    _, base = _kmeans(x, 1)
    prev = base
    for k in range(2, min(max_k, len(x)) + 1):
        labels, wss = _kmeans(x, k)
        if prev <= 0 or (prev - wss) / prev < MIN_IMPROVEMENT:
            break
        best_k, best_labels, prev = k, labels, wss
    return best_k, best_labels


#: Below this ratio between cluster centres, in log-f0 units, the "speakers" are
#: closer together than one person's own speech varies. Measured on real
#: material: two voices in the demo scene sit 4% apart in median pitch, which is
#: inside a single speaker's range. Splitting there invents people.
MIN_SEPARATION = 0.18          # ~1.20x in f0, or an equivalent timbre distance


def separation(x: np.ndarray, labels: np.ndarray, k: int) -> float:
    """
    Smallest distance between any two cluster centres, in standardised units.

    Reported rather than hidden because it is the number that decides whether
    the answer means anything. Clusters always exist; whether they correspond to
    people is a different question, and this is the closest thing available to
    an answer.
    """
    centres = [x[labels == j].mean(axis=0) for j in range(k) if (labels == j).any()]
    if len(centres) < 2:
        return float("inf")
    return float(min(
        np.linalg.norm(centres[i] - centres[j])
        for i in range(len(centres)) for j in range(i + 1, len(centres))
    ))


def diarize_by_voice(media: Path, words: list[dict]) -> dict:
    """
    Label `words` in place with speaker ids, and return the speaker table.

    Clusters whole pause-separated utterances, then refuses the result if the
    clusters are closer together than one voice varies on its own.

    Two approaches were tried before this one and both are worth recording.
    Clustering utterances alone merges two actors who trade lines without a
    pause, which is most of drama. Clustering word by word fixes that and
    introduces something worse: the speaker colour changes mid-phrase, which the
    word-level reveal makes maximally visible.

    Neither is the real problem. Measuring the demo scene against its own ground
    truth, two of its four speakers sit 4% apart in median pitch — inside the
    range a single person moves through in one sentence. Pitch and timbre cannot
    separate them, and no clustering of those features will. Proper diarization
    uses embeddings trained to discriminate speakers, which is why they exist.

    So this reports one speaker rather than four wrong ones when the voices are
    not far enough apart to tell. A caption track that says "I could not tell
    these people apart" is usable. One that confidently colours two characters
    as each other is not, and looks identical to a correct one.
    """
    media = Path(media)
    wav = media
    if media.suffix.lower() != ".wav":
        wav = decode_to_wav(media, media.with_suffix(".diarize.wav"))
    x, sr = read_wav(wav)
    frames = analyze_frames(x, sr)

    groups = utterances(words)
    feats, usable = [], []
    for g in groups:
        start, end = words[g[0]]["start"], words[g[-1]]["end"]
        if end - start < MIN_UTTERANCE_S:
            continue
        f = _features(frames, start, end)
        if f is not None:
            feats.append(f)
            usable.append(g)

    def single(reason: str) -> dict:
        for w in words:
            w["speaker"] = "S0"
        return {"S0": {"name": "Speaker 1", "diarization": reason}}

    if len(feats) < 3:
        return single("too little speech to separate voices")

    x_f = np.array(feats)
    mu, sigma = x_f.mean(axis=0), x_f.std(axis=0)
    sigma[sigma < 1e-6] = 1.0
    z = (x_f - mu) / sigma

    k, labels = choose_k(z)
    if k < 2:
        return single("one voice found")

    sep = separation(z, labels, k)
    if sep < MIN_SEPARATION * 4:      # in standardised units
        return single(
            f"voices were {sep:.2f} apart in standardised pitch and timbre, which is "
            f"inside one speaker's own range — they cannot be told apart this way")

    order = np.argsort([x_f[labels == j, 0].mean() for j in range(k)])
    rank = {int(old): new for new, old in enumerate(order)}
    for g, lab in zip(usable, labels):
        sid = f"S{rank[int(lab)]}"
        for i in g:
            words[i]["speaker"] = sid

    last = "S0"
    for w in words:
        if not w.get("speaker"):
            w["speaker"] = last
        last = w["speaker"]

    used = sorted({w["speaker"] for w in words})
    return {
        sid: {"name": f"Speaker {int(sid[1:]) + 1}",
              "diarization": f"separated acoustically, margin {sep:.2f} — verify these"}
        for sid in used
    }
