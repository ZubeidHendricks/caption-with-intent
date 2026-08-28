"""
How much of this analysis can you trust on *this* film?

Everything upstream of here has been validated on synthesised speech: harmonic
stacks at known f0, isolated, silent between words, with exact ground truth.
That is the right way to test a mapping, and it says nothing about a real
soundtrack, where dialogue arrives buried under a score, cut with effects,
compressed by a broadcast chain and overlapped by a second actor.

There is no ground truth for a real film, so this does not score accuracy. It
measures whether the *conditions the mapping assumes* actually hold, and says
where they do not. The assumptions are specific and each one is checkable:

  1. The audio in a cue's window is predominantly voiced speech. If it is
     mostly score, then loudness and pitch describe the composer's work and the
     typography is confidently rendering the wrong thing.
  2. There is dynamic range to map. Broadcast compression flattens exactly the
     variation the design encodes; if every word lands within a decibel of the
     reference, the type size is constant and conveys nothing.
  3. Pitch estimates within one voice cluster. A speaker whose f0 jumps an
     octave between cues is being misread, usually by music in the window.
  4. One speaker at a time. Overlapping dialogue breaks the segmentation
     assumption outright.
  5. Cues are readable at all — reading rate within the range subtitling has
     used for decades.

The output is a per-cue confidence and a set of findings, so a production knows
which lines to trust and whether the film needs a dialogue stem rather than a
mix. Reporting "78% of cues are music-dominated, go get the stem" is worth more
than a number that looks like accuracy and is not.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np

from acoustics import SAMPLE_RATE, decode_to_wav, read_wav, analyze_frames, Frames

# --- thresholds -------------------------------------------------------------
# Each is a judgement call, stated rather than tuned until the answer looked
# nice. They mark where a reading stops being worth acting on, not where it
# becomes exactly wrong.

#: d' from YIN above which a frame is not periodic enough to call speech.
APERIODIC_MAX = 0.45
#: Fraction of a cue's frames that must be voiced for its pitch to mean anything.
VOICED_MIN = 0.35
#: Spectral flatness above which a window looks more like noise or dense mix
#: than speech. Speech is peaky: harmonics with gaps between them.
FLATNESS_MAX = 0.35
#: Speech should stand above the surrounding floor. Below this the "dialogue"
#: level is mostly whatever else is in the mix.
SNR_MIN_DB = 6.0
#: Total spread of mapped type size, in percent of frame height, below which the
#: intonation layer is not conveying anything a viewer could notice.
SIZE_SPREAD_MIN = 0.8
#: Characters per second. Above this a cue cannot be read in the time it is up.
READING_RATE_MAX = 21.0
#: Within one speaker, the ratio between the 90th and 10th percentile f0 that
#: indicates octave errors rather than expressive range.
F0_RATIO_MAX = 1.9
#: Longest provisional cue. Beyond this a span is a scene, not an utterance.
MAX_PROVISIONAL_S = 8.0
#: The floor needs something to measure. Below this share of the film outside
#: any cue, there is no "between the dialogue" left to characterise.
FLOOR_MIN_SHARE = 0.15


def size_from_db(db: float) -> float:
    """
    Type size for a relative level, in percent of frame height.

    The constants are the spec's own — 5% baseline, 3-12% range, 18 dB of quiet
    below and 12 dB of loud above, with a +/-6 dB knee mapping to +/-0.6% so
    that ordinary conversational variation does not make a line pulse. This
    mirrors sizeFromDb in packages/core/src/mapping.ts, which the conformance
    vectors pin against the published spec; both read the same numbers from the
    same document rather than from each other.

    Only used here to answer one question: after mapping, is there any visible
    difference in size across this film at all?
    """
    baseline, lo, hi = 5.0, 3.0, 12.0
    quiet, loud, knee, knee_size = 18.0, 12.0, 6.0, 0.6
    if abs(db) <= knee:
        return baseline + (db / knee) * knee_size
    if db > 0:
        t = (db - knee) / max(loud - knee, 1e-9)
        return min(hi, baseline + knee_size + t * (hi - baseline - knee_size))
    t = (-db - knee) / max(quiet - knee, 1e-9)
    return max(lo, baseline - knee_size - t * (baseline - knee_size - lo))


@dataclass
class CueReport:
    id: str
    start: float
    end: float
    speaker: str | None
    kind: str
    text: str
    voiced_ratio: float
    aperiodicity: float
    flatness: float
    snr_db: float | None
    reading_rate: float
    #: 0-1. Not a probability: a blunt statement of how many assumptions held.
    confidence: float
    flags: list[str] = field(default_factory=list)


@dataclass
class FilmReport:
    media: str
    #: True when cues were segmented from the audio because no manifest was
    #: given. The acoustic findings hold; anything about text does not.
    provisional: bool
    manifest: str
    duration_s: float
    cues: int
    dialogue_cues: int
    speech_coverage: float
    trustworthy: int
    suspect: int
    size_spread_pct: float
    overlaps: list[str]
    findings: list[str]
    per_cue: list[dict]
    verdict: str


def spectral_flatness(x: np.ndarray, sr: int, n: int = 1024) -> float:
    """
    Geometric mean over arithmetic mean of the power spectrum.

    Near 0 for a harmonic sound with clear peaks and gaps — speech, a solo
    instrument. Near 1 for noise or a dense mix where energy is spread evenly.
    It is the cheapest reliable way to ask "is this one voice or is this a
    wall of sound", and it needs no model.
    """
    if len(x) < n:
        x = np.pad(x, (0, n - len(x)))
    win = np.hanning(n).astype(np.float32)
    out = []
    for i in range(0, len(x) - n + 1, n // 2):
        spec = np.abs(np.fft.rfft(x[i:i + n] * win)) ** 2 + 1e-12
        out.append(float(np.exp(np.mean(np.log(spec))) / np.mean(spec)))
    return float(np.median(out)) if out else 1.0


def _floor_db(frames: Frames, spans: list[tuple[float, float]]) -> float | None:
    """
    Level of everything that is not a cue: room tone, score, effects.

    This is the reference speech has to stand above. Taking the 10th percentile
    of the whole film instead would find the quietest moment of silence, which
    flatters every mix ever made.
    """
    mask = np.ones(len(frames.rms_db), dtype=bool)
    for s, e in spans:
        i0 = max(0, int(s / frames.hop_s))
        i1 = min(len(mask), int(e / frames.hop_s) + 1)
        mask[i0:i1] = False
    off = frames.rms_db[mask]
    # With almost everything inside a cue there is no floor to speak of, and
    # the median of what little remains can sit *above* the dialogue — which
    # then reports as negative signal-to-noise and reads like a damning fact
    # about the film. It is not: it is the measurement having nothing to stand
    # on. Return None and let the caller drop the check.
    if len(off) < FLOOR_MIN_SHARE * len(mask):
        return None
    return float(np.median(off))


def provisional_cues(frames: Frames, min_s: float = 0.35, gap_s: float = 0.35) -> list[dict]:
    """
    Segment by voicing when there is no transcript yet.

    The point of this harness is to tell you whether a soundtrack is worth
    transcribing before you pay to transcribe it, and that answer cannot
    require a transcript. Voiced runs are not cues — they ignore who is
    speaking and they will happily bracket a sung note — but the acoustic
    questions being asked here are about windows of audio, not about words.

    Reported as `provisional` so nothing downstream mistakes these for
    editorial decisions.
    """
    voiced = frames.voiced
    spans, start = [], None
    for i, v in enumerate(voiced):
        if v and start is None:
            start = i
        elif not v and start is not None:
            spans.append((start, i))
            start = None
    if start is not None:
        spans.append((start, len(voiced)))

    # Bridge short unvoiced gaps: stops and fricatives inside a word are not
    # voiced, so raw runs shatter every utterance into syllables.
    merged: list[list[int]] = []
    for a, b in spans:
        if merged and (a - merged[-1][1]) * frames.hop_s < gap_s:
            merged[-1][1] = b
        else:
            merged.append([a, b])

    # Cap the length. Bridging gaps will happily weld a whole scene into one
    # span, and a 60-second "utterance" measures the segmenter rather than the
    # film — every statistic over it is an average of speech, score and silence.
    capped: list[tuple[int, int]] = []
    max_frames = int(MAX_PROVISIONAL_S / frames.hop_s)
    for a, b in merged:
        while b - a > max_frames:
            capped.append((a, a + max_frames))
            a += max_frames
        capped.append((a, b))

    return [
        {"id": f"p{i:04d}", "start": round(a * frames.hop_s, 3),
         "end": round(b * frames.hop_s, 3), "kind": "dialogue",
         "speaker": None, "provisional": True, "lines": []}
        for i, (a, b) in enumerate(capped)
        if (b - a) * frames.hop_s >= min_s
    ]


def evaluate(media: Path, manifest: dict, workdir: Path | None = None) -> FilmReport:
    tmp = (workdir or media.parent) / (media.stem + ".eval.wav")
    wav = decode_to_wav(media, tmp) if media.suffix.lower() != ".wav" else media
    x, sr = read_wav(wav)
    frames = analyze_frames(x, sr)
    duration = len(x) / sr

    cues = manifest.get("cues", [])
    provisional = not cues
    if provisional:
        cues = provisional_cues(frames)
    spans = [(c["start"], c["end"]) for c in cues]
    floor = _floor_db(frames, spans)

    per_cue: list[CueReport] = []
    for i, cue in enumerate(cues):
        s, e = float(cue["start"]), float(cue["end"])
        i0, i1 = int(s / frames.hop_s), min(len(frames.rms_db), int(e / frames.hop_s) + 1)
        if i1 <= i0:
            continue
        seg = x[int(s * sr):int(e * sr)]
        text = " ".join(t["text"] for l in cue.get("lines", []) for t in l.get("tokens", []))

        voiced = frames.voiced[i0:i1]
        voiced_ratio = float(np.mean(voiced)) if len(voiced) else 0.0
        aper = getattr(frames, "aperiodicity", None)
        aperiodicity = (float(np.median(aper[i0:i1])) if aper is not None and len(aper[i0:i1])
                        else float("nan"))
        flatness = spectral_flatness(seg, sr) if len(seg) else 1.0
        level = float(np.percentile(frames.rms_db[i0:i1], 75))
        snr = None if floor is None else level - floor
        dur = max(e - s, 1e-6)
        rate = len(text) / dur

        flags: list[str] = []
        kind = cue.get("kind", "dialogue")
        if kind == "dialogue":
            if voiced_ratio < VOICED_MIN:
                flags.append(f"only {voiced_ratio:.0%} voiced — pitch and weight are guesses")
            if flatness > FLATNESS_MAX:
                flags.append(f"spectrally flat ({flatness:.2f}) — dense mix or noise, not a clear voice")
            if snr is not None and snr < SNR_MIN_DB:
                flags.append(f"only {snr:.1f} dB above the surrounding mix — level reflects the bed")
            if not math.isnan(aperiodicity) and aperiodicity > APERIODIC_MAX:
                flags.append(f"aperiodic ({aperiodicity:.2f}) — f0 unreliable here")
            if text and rate > READING_RATE_MAX:
                flags.append(f"{rate:.0f} characters/second — too fast to read")

        # Confidence is the share of the checks that a dialogue cue passed. Four
        # acoustic checks; the reading rate is a caption defect, not an analysis
        # one, so it does not reduce trust in the measurement.
        # One fewer check to fail when the floor could not be measured.
        acoustic = 4 if floor is not None else 3
        failed = len([f for f in flags if "characters/second" not in f])
        confidence = 1.0 if kind != "dialogue" else max(0.0, (acoustic - failed) / acoustic)

        per_cue.append(CueReport(
            id=str(cue.get("id", i)), start=s, end=e, speaker=cue.get("speaker"),
            kind=kind, text=text[:80], voiced_ratio=round(voiced_ratio, 3),
            aperiodicity=None if math.isnan(aperiodicity) else round(aperiodicity, 3),
            flatness=round(flatness, 3),
            snr_db=None if snr is None else round(snr, 1),
            reading_rate=round(rate, 1), confidence=round(confidence, 2), flags=flags,
        ))

    findings: list[str] = []
    dialogue = [c for c in per_cue if c.kind == "dialogue"]

    # --- is there dynamic range left to map? ---
    dbs = [t.get("db") for c in cues for l in c.get("lines", [])
           for t in l.get("tokens", []) if t.get("db") is not None]
    size_spread = 0.0
    if dbs:
        sizes = [size_from_db(d) for d in dbs]
        size_spread = max(sizes) - min(sizes)
        if size_spread < SIZE_SPREAD_MIN:
            findings.append(
                f"Type size spans only {size_spread:.2f}% of frame height across the whole film. "
                "The soundtrack is compressed flat, so the volume layer conveys nothing — "
                "every word will render at essentially the same size.")

    # --- do speakers hold a consistent pitch? ---
    by_speaker: dict[str, list[float]] = {}
    for c in cues:
        sp = c.get("speaker")
        if not sp:
            continue
        for l in c.get("lines", []):
            for t in l.get("tokens", []):
                if t.get("f0"):
                    by_speaker.setdefault(sp, []).append(float(t["f0"]))
    for sp, f0s in by_speaker.items():
        if len(f0s) < 4:
            continue
        hi, lo = np.percentile(f0s, 90), np.percentile(f0s, 10)
        if lo > 0 and hi / lo > F0_RATIO_MAX:
            findings.append(
                f"{sp}: pitch spans {lo:.0f}-{hi:.0f} Hz, a ratio of {hi / lo:.1f}. "
                "Wider than a voice moves; likely octave errors or music in the window, "
                "which would put this character's weight all over the place.")

    # --- one speaker at a time? ---
    overlaps = []
    for a, b in zip(cues, cues[1:]):
        if b["start"] < a["end"] - 0.05 and a.get("speaker") and b.get("speaker") \
                and a["speaker"] != b["speaker"]:
            overlaps.append(f'{a.get("id", "?")} and {b.get("id", "?")} at {b["start"]:.1f}s')
    if overlaps:
        findings.append(
            f"{len(overlaps)} places where two speakers overlap. Segmentation assumes one "
            "voice at a time, so both readings there describe the sum of two people.")

    if provisional:
        findings.insert(0,
            "Cues were segmented from the audio because no manifest was given, so these "
            "are windows of voiced audio rather than utterances. The acoustic readings "
            "are real; anything implying who spoke or what was said is not.")
        coverage = sum(c.end - c.start for c in per_cue) / duration if duration else 0
        if coverage > 0.6:
            findings.append(
                f"{coverage:.0%} of the runtime landed inside a provisional cue. Voicing "
                "detection is bracketing music and effects as speech, so the per-cue "
                "numbers below describe the segmenter as much as the film. Supply a "
                "manifest for a reading that means anything about the dialogue.")
    if floor is None:
        findings.append(
            "No usable floor between the cues, so the signal-to-mix check was skipped "
            "rather than guessed. Every cue is scored out of the remaining three checks.")

    suspect = [c for c in dialogue if c.confidence < 0.75]
    if dialogue and len(suspect) / len(dialogue) > 0.3:
        findings.append(
            f"{len(suspect)} of {len(dialogue)} dialogue cues fail an acoustic assumption. "
            "This is a mixed soundtrack, not a dialogue stem. Analyse the stem if you have "
            "one; the typography here is partly describing music.")

    speech = sum(c.end - c.start for c in dialogue)
    trustworthy = len([c for c in dialogue if c.confidence >= 0.75])

    if not dialogue:
        verdict = "no dialogue cues to evaluate"
    elif len(suspect) / len(dialogue) > 0.5:
        verdict = "unreliable — most cues violate the assumptions the mapping rests on"
    elif findings:
        verdict = "usable with caveats — see findings"
    else:
        verdict = "the assumptions hold across this film"

    return FilmReport(
        media=str(media), provisional=provisional,
        manifest=manifest.get("meta", {}).get("title", ""),
        duration_s=round(duration, 2), cues=len(cues), dialogue_cues=len(dialogue),
        speech_coverage=round(speech / duration, 3) if duration else 0.0,
        trustworthy=trustworthy, suspect=len(suspect),
        size_spread_pct=round(size_spread, 2), overlaps=overlaps,
        findings=findings, per_cue=[asdict(c) for c in per_cue], verdict=verdict,
    )


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: evaluate.py <media> <manifest.cwi.json> [--json]", flush=True)
        return 2
    media, mpath = Path(argv[1]), Path(argv[2])
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    report = evaluate(media, manifest)
    print(json.dumps(asdict(report), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    import sys
    raise SystemExit(main(sys.argv))
