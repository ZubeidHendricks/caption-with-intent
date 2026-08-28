"""
Align a KNOWN word sequence to clean single-speaker audio.

This is the piece that makes the synthetic-speech path work. When a machine
generated the speech you already have the exact text and you know who is
speaking, so open-vocabulary ASR is the wrong tool — it can only introduce
errors into something you already know. What you still need is word ONSETS,
because spec 2.2.2 requires the colour to flip on a word's first phoneme.

Clean TTS audio makes that tractable without a forced-alignment model: there is
no music, no room, no overlapping speakers, so energy-based voice activity
detection finds utterance boundaries reliably. The remaining problem is
distributing a known word sequence across the detected segments, which is a
small dynamic program.

Accuracy degrades on noisy, mixed, or multi-speaker audio. For recorded film use
wav2vec2 forced alignment via `transcript.from_whisperx` instead.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

import acoustics


@dataclass
class Segment:
    start: float
    end: float

    @property
    def dur(self) -> float:
        return self.end - self.start


# --------------------------------------------------------------------------
# Voice activity detection
# --------------------------------------------------------------------------

def detect_speech(
    frames: acoustics.Frames,
    min_speech_s: float = 0.045,
    max_gap_s: float = 0.055,
    rel_threshold_db: float = 22.0,
    silence_floor_db: float = -60.0,
) -> list[Segment]:
    """
    Find speech segments from frame energy.

    The threshold floats relative to the loudest frame rather than sitting at a
    fixed dBFS, so it survives whatever level the provider rendered at — but it
    is clamped by an absolute floor, without which silence reads as speech.
    Gap-filling before minimum-duration pruning matters: stop consonants create
    20-40 ms of near-silence *inside* a word, and pruning first would split
    "stopped" into two segments.
    """
    db = frames.rms_db
    if db.size == 0:
        return []
    peak = float(db.max())
    # A purely relative threshold has nothing to anchor to on a silent or muted
    # track: every frame then sits above it and the whole buffer reads as one
    # long utterance. Gate on an absolute floor first.
    if peak < silence_floor_db:
        return []
    thresh = max(peak - rel_threshold_db, silence_floor_db)
    active = db > thresh

    hop = frames.hop_s
    gap_frames = max(1, int(round(max_gap_s / hop)))
    min_frames = max(1, int(round(min_speech_s / hop)))

    # Close short gaps.
    idx = np.flatnonzero(active)
    if idx.size == 0:
        return []
    filled = active.copy()
    for a, b in zip(idx[:-1], idx[1:]):
        if 1 < b - a <= gap_frames + 1:
            filled[a:b] = True

    # Extract runs, dropping ones too short to be speech.
    segs: list[Segment] = []
    run_start = None
    for i, on in enumerate(filled):
        if on and run_start is None:
            run_start = i
        elif not on and run_start is not None:
            if i - run_start >= min_frames:
                segs.append(Segment(run_start * hop, i * hop))
            run_start = None
    if run_start is not None and len(filled) - run_start >= min_frames:
        segs.append(Segment(run_start * hop, len(filled) * hop))
    return segs


# --------------------------------------------------------------------------
# Duration model
# --------------------------------------------------------------------------

_VOWELS = re.compile(r"[aeiouy]+", re.I)


def syllables(word: str) -> int:
    """Cheap syllable count. Good enough to weight relative word durations."""
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return 1
    n = len(_VOWELS.findall(w))
    if w.endswith("e") and n > 1 and not w.endswith(("le", "ee", "ye")):
        n -= 1
    return max(1, n)


def predicted_duration(word: str) -> float:
    """
    Relative duration weight for a word. Syllable count dominates; character
    count breaks ties between same-syllable words ('strength' vs 'a').
    """
    return 0.13 + 0.11 * syllables(word) + 0.012 * len(re.sub(r"[^\w]", "", word))


# --------------------------------------------------------------------------
# Alignment
# --------------------------------------------------------------------------

def _merge_to(segs: list[Segment], target: int) -> list[Segment]:
    """Merge across the smallest gaps until at most `target` segments remain."""
    segs = list(segs)
    while len(segs) > target:
        gaps = [(segs[i + 1].start - segs[i].end, i) for i in range(len(segs) - 1)]
        _, i = min(gaps)
        segs[i:i + 2] = [Segment(segs[i].start, segs[i + 1].end)]
    return segs


def _partition(words: list[str], segs: list[Segment]) -> list[list[str]]:
    """
    Split `words` into len(segs) contiguous non-empty groups, minimising the
    mismatch between each group's predicted duration and its segment's actual
    duration. Straightforward DP — the sequences here are cue-sized.
    """
    W, S = len(words), len(segs)
    if S == 1:
        return [words]
    weights = [predicted_duration(w) for w in words]
    prefix = np.concatenate([[0.0], np.cumsum(weights)])
    total_w = prefix[-1] or 1.0
    total_d = sum(s.dur for s in segs) or 1.0

    INF = float("inf")
    cost = np.full((S + 1, W + 1), INF)
    back = np.zeros((S + 1, W + 1), dtype=int)
    cost[0][0] = 0.0

    for s in range(1, S + 1):
        # Each group needs >= 1 word, and enough words must remain for the rest.
        for w in range(s, W - (S - s) + 1):
            want = segs[s - 1].dur / total_d
            for k in range(s - 1, w):
                if cost[s - 1][k] == INF:
                    continue
                got = (prefix[w] - prefix[k]) / total_w
                c = cost[s - 1][k] + (want - got) ** 2
                if c < cost[s][w]:
                    cost[s][w] = c
                    back[s][w] = k

    groups: list[list[str]] = []
    w = W
    for s in range(S, 0, -1):
        k = back[s][w]
        groups.append(words[k:w])
        w = k
    return groups[::-1]


def align_utterances(
    utterances: list[tuple[list[str], np.ndarray, float]],
    sr: int,
) -> list[dict]:
    """
    Align a list of `(words, audio, offset)` utterances independently.

    THIS is the entry point for the synthetic-speech path, and the distinction
    matters a great deal. Aligning a whole multi-line take in one pass makes the
    partition global: one bad segment boundary misassigns a group and every
    word after it shifts, so median error stays low while p90 blows out past a
    second. Per utterance the problem is bounded — a mistake cannot escape its
    own line — which is also exactly how the audio arrives when you called the
    synthesizer once per line.
    """
    out: list[dict] = []
    for words, audio, offset in utterances:
        out.extend(align(words, audio, sr, offset))
    return out


def align(words: list[str], x: np.ndarray, sr: int, offset: float = 0.0) -> list[dict]:
    """
    Return `[{text, start, end}]` for `words` over audio `x`.

    `offset` is added to every timestamp, for placing one utterance inside a
    longer timeline.

    Call this per utterance, not across a whole take — see `align_utterances`.
    """
    if not words:
        return []
    frames = acoustics.analyze_frames(x, sr)
    segs = detect_speech(frames)

    if not segs:
        # Nothing detected — spread evenly rather than dropping the line.
        total = len(x) / sr
        step = total / len(words)
        return [{"text": w, "start": offset + i * step, "end": offset + (i + 1) * step}
                for i, w in enumerate(words)]

    if len(segs) > len(words):
        segs = _merge_to(segs, len(words))

    out: list[dict] = []
    for group, seg in zip(_partition(words, segs), segs):
        weights = np.array([predicted_duration(w) for w in group])
        bounds = seg.start + seg.dur * np.concatenate([[0.0], np.cumsum(weights / weights.sum())])
        bounds = _snap_to_minima(bounds, frames, seg)
        for i, w in enumerate(group):
            out.append({"text": w, "start": offset + float(bounds[i]), "end": offset + float(bounds[i + 1])})
    return out


def _snap_to_minima(
    bounds: np.ndarray,
    frames: acoustics.Frames,
    seg: Segment,
    search_s: float = 0.045,
) -> np.ndarray:
    """
    Pull each internal word boundary to the quietest nearby frame.

    The duration model gets a word's *share* of a segment roughly right, but the
    exact onset lands wherever the arithmetic falls. Real word boundaries sit in
    energy dips, so a short local search recovers most of the difference — and
    it costs nothing, since the frame energies are already computed.

    Only internal boundaries move; the segment's own edges come from voice
    activity detection and are already the best estimate available.
    """
    if len(bounds) <= 2:
        return bounds
    hop = frames.hop_s
    db = frames.rms_db
    radius = max(1, int(round(search_s / hop)))
    snapped = bounds.copy()

    for i in range(1, len(bounds) - 1):
        centre = int(round(bounds[i] / hop))
        lo = max(int(round(seg.start / hop)) + 1, centre - radius)
        hi = min(int(round(seg.end / hop)) - 1, centre + radius)
        if hi <= lo:
            continue
        window = db[lo:hi + 1]
        if window.size == 0:
            continue
        candidate = (lo + int(np.argmin(window))) * hop
        # Never let snapping reorder boundaries.
        if snapped[i - 1] < candidate < bounds[i + 1]:
            snapped[i] = candidate
    return snapped
