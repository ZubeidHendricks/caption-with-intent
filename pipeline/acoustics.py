"""
Per-word acoustic feature extraction for Caption with Intention.

This is the layer that makes CWI automatable. The design system encodes
*measurable signal properties* — amplitude, fundamental frequency, harmonic
distribution — not interpreted emotion categories. So this module does not need
a model; it needs DSP. That is a large part of why the system is tractable.

Deliberately numpy + stdlib only: no librosa, no torch. The heavy models
(ASR, diarization, active-speaker detection) live behind adapters in
transcript.py, so this stage stays fast, deterministic and testable.
"""
from __future__ import annotations

import math
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

import yin

SAMPLE_RATE = 16000


# --------------------------------------------------------------------------
# Audio loading
# --------------------------------------------------------------------------

def decode_to_wav(media: Path, out: Path, sr: int = SAMPLE_RATE) -> Path:
    """Decode any media file to 16-bit mono PCM at `sr` via ffmpeg."""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(media),
         "-ac", "1", "-ar", str(sr), "-c:a", "pcm_s16le", str(out)],
        check=True,
    )
    return out


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    """Read a 16-bit PCM WAV into float32 in [-1, 1]."""
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"expected 16-bit PCM, got {w.getsampwidth() * 8}-bit")
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    with wave.open(str(path), "rb") as w:
        ch = w.getnchannels()
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


# --------------------------------------------------------------------------
# Frame-level features
# --------------------------------------------------------------------------

@dataclass
class Frames:
    rms_db: np.ndarray      # dBFS per frame
    f0: np.ndarray          # Hz per frame, 0.0 where unvoiced
    centroid: np.ndarray    # Hz per frame
    hop_s: float
    voiced: np.ndarray      # bool per frame


def _frame(x: np.ndarray, n: int, hop: int) -> np.ndarray:
    if len(x) < n:
        x = np.pad(x, (0, n - len(x)))
    count = 1 + (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(count)[:, None]
    return x[idx]


def analyze_frames(
    x: np.ndarray,
    sr: int = SAMPLE_RATE,
    win_s: float = 0.040,
    hop_s: float = 0.010,
    f0_min: float = 60.0,
    f0_max: float = 500.0,
) -> Frames:
    """
    Frame-level RMS, fundamental frequency and spectral centroid.

    F0 uses YIN (de Cheveigne & Kawahara, 2002), which resists the octave errors
    that plain autocorrelation is prone to. Accurate to ~0.01% on synthetic
    tones even when the fundamental is deliberately weaker than its second
    harmonic. See yin.py. It is not as robust as CREPE or pYIN on noisy mixes, but
    it is deterministic, dependency-free, and accurate enough for a mapping
    whose output is a font weight. Swap in a better estimator behind the same
    interface when dialogue stems are unavailable and the mix is dense.
    """
    n = int(round(win_s * sr))
    hop = int(round(hop_s * sr))
    F = _frame(x, n, hop)
    win = np.hanning(n).astype(np.float32)

    # --- RMS ---
    rms = np.sqrt(np.mean(F ** 2, axis=1) + 1e-12)
    rms_db = 20.0 * np.log10(np.maximum(rms, 1e-9))

    # --- Spectral centroid ---
    spec = np.abs(np.fft.rfft(F * win, axis=1))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    mag = spec.sum(axis=1) + 1e-12
    centroid = (spec * freqs[None, :]).sum(axis=1) / mag

    # --- F0 via YIN ---
    # Plain autocorrelation peaks at every multiple of the true period, so a
    # strong second harmonic drags the estimate to double the true pitch. YIN's
    # cumulative mean normalisation plus a first-below-threshold search fixes
    # that structurally; see yin.py.
    f0, aperiodicity = yin.estimate(F, sr, f0_min=f0_min, f0_max=f0_max)

    # Voicing: a clear periodic peak, and not silence. The level gate is set
    # relative to the loudest frame plus an absolute floor — anchoring it to a
    # low percentile fails on steady signals, where every frame sits at the
    # same level and the gate rises above the signal itself.
    # Voicing combines periodicity with level. Aperiodicity is the better of the
    # two signals — a loud unvoiced consonant is still unvoiced — but a level
    # gate is still needed to reject periodic room tone in the gaps.
    gate = max(float(rms_db.max()) - 40.0, -55.0)
    voiced = (aperiodicity < 0.45) & (rms_db > gate) & (f0 >= f0_min) & (f0 <= f0_max)
    f0 = np.where(voiced, f0, 0.0)

    f0 = np.where(voiced, f0, 0.0)
    return Frames(rms_db=rms_db, f0=f0, centroid=centroid, hop_s=hop_s, voiced=voiced)


# --------------------------------------------------------------------------
# Word-level aggregation
# --------------------------------------------------------------------------

def _slice(frames: Frames, start: float, end: float) -> slice:
    a = max(0, int(math.floor(start / frames.hop_s)))
    b = min(len(frames.rms_db), max(a + 1, int(math.ceil(end / frames.hop_s))))
    return slice(a, b)


def word_features(frames: Frames, start: float, end: float) -> dict:
    """
    Aggregate frame features over one word.

    Loudness uses a high percentile rather than the mean: a word's perceived
    volume tracks its peak vowel, not the average across its silences and stops.
    Pitch and centroid use the median over *voiced* frames only, so unvoiced
    consonants do not drag the estimate.
    """
    sl = _slice(frames, start, end)
    rms = frames.rms_db[sl]
    if rms.size == 0:
        return {"db_abs": -60.0, "f0": 0.0, "centroid": 0.0, "voiced_ratio": 0.0}

    voiced = frames.voiced[sl]
    f0v = frames.f0[sl][voiced]
    cenv = frames.centroid[sl][voiced] if voiced.any() else frames.centroid[sl]

    return {
        "db_abs": float(np.percentile(rms, 90)),
        "f0": float(np.median(f0v)) if f0v.size else 0.0,
        "centroid": float(np.median(cenv)) if cenv.size else 0.0,
        "voiced_ratio": float(voiced.mean()),
    }


def dialogue_reference(levels: np.ndarray, bin_db: float = 3.0) -> float:
    """
    Estimate a speaker's normal speaking level from their per-word levels.

    Not a mean, and not "the median of the upper half" — both get pulled toward
    whichever tail is busier, so a character who shouts a lot ends up with their
    shouts treated as normal and their ordinary lines captioned as if quiet.

    Instead take the mode: histogram the levels in ~3 dB bins, find the bin
    holding the most words, and return the median within it. Dialogue is
    strongly unimodal around a speaker's habitual level, with shouts and
    whispers as sparse tails, so the mode is the level we actually want.
    """
    if levels.size == 0:
        return 0.0
    if levels.size < 4:
        return float(np.median(levels))
    lo, hi = float(levels.min()), float(levels.max())
    if hi - lo < bin_db:
        return float(np.median(levels))
    edges = np.arange(lo, hi + bin_db, bin_db)
    counts, edges = np.histogram(levels, bins=edges)
    b = int(np.argmax(counts))

    # The mode is only trustworthy when the modal bin actually holds a decent
    # share of the words. On a short cue list it can land on a sparse bin well
    # away from the centre, which then reads as "this speaker normally talks at
    # that level" and oversizes every other caption. Fall back to the median.
    support = counts[b] / levels.size
    if counts[b] < 4 or support < 0.15:
        return float(np.median(levels))

    inside = levels[(levels >= edges[b]) & (levels <= edges[b + 1])]
    return float(np.median(inside)) if inside.size else float(np.median(levels))


def stabilize(words: list[dict], mode: str = "voice", max_deviation: float = 0.12) -> None:
    """
    Resolve per-word pitch and centroid into the values the typography should
    actually use, in place.

    A NOTE ON READING THE SPEC. CWI V1.0 maps volume to type size, pitch to
    weight and harmonics to width, and it is tempting to compute all three per
    word. Section 2.3.8 does not say that: it talks about "voices", and the
    worked examples contrast one character against another. Volume is
    explicitly dynamic ("louder voices and sounds are represented with larger
    type"), but weight and width read as descriptions of *whose voice this is*.

    That reading is also the only one that survives contact with real audio.
    Per-word f0 on short function words ("is", "in", "the") or spelled letters
    ("U", "R", "L") is estimated from a handful of voiced frames and is mostly
    noise. Mapped onto a 500-unit weight span, one evenly read sentence from a
    single synthetic voice lurches between `wght` 400 and 845 word to word. The
    intonation layer then conveys estimator variance rather than delivery.

    Modes:
      "voice"  (default) every word takes the speaker's characteristic value.
               Weight and width identify the character; size still moves per
               word with volume. Steady, and faithful to 2.3.8.
      "word"   per-word values, blended toward the speaker's median by
               measurement confidence and clamped to +/- `max_deviation`.
               Use when you want prosody visible and have clean dialogue stems.
      "raw"    no correction. Diagnostics only; expect visible jitter.
    """
    if mode == "raw":
        return

    usable = [w for w in words if w.get("f0", 0) > 0 and w.get("voiced_ratio", 0) > 0.35]
    if not usable:
        return

    ref_f0 = float(np.median([w["f0"] for w in usable]))
    centroids = [w["centroid"] for w in usable if w.get("centroid", 0) > 0]
    ref_cen = float(np.median(centroids)) if centroids else 0.0

    for w in words:
        if mode == "voice":
            w["f0"] = ref_f0
            if ref_cen:
                w["centroid"] = ref_cen
            continue

        # mode == "word"
        conf = min(1.0, max(0.0, (w.get("voiced_ratio", 0.0) - 0.15) / 0.45))
        for key, ref in (("f0", ref_f0), ("centroid", ref_cen)):
            if not ref:
                continue
            val = w.get(key, 0.0)
            if not val:
                w[key] = ref
                continue
            blended = conf * val + (1.0 - conf) * ref
            lo, hi = ref * (1.0 - max_deviation), ref * (1.0 + max_deviation)
            w[key] = float(min(max(blended, lo), hi))


def to_relative_db(words: list[dict], key: str = "db_abs") -> None:
    """
    Convert absolute dBFS to the level *relative to this speaker's normal
    speaking voice*, in place, writing a `db` field.

    This resolves a real gap in the CWI spec: it maps volume onto type size
    3-12% but never says what the 5% baseline is anchored to. Anchoring per
    speaker means a quiet scene and a loud scene both read correctly, and a
    soft-spoken actor is not permanently captioned at 3%.
    """
    if not words:
        return
    levels = np.array([w[key] for w in words], dtype=np.float64)
    ref = dialogue_reference(levels)
    for w in words:
        rel = float(w[key]) - ref
        # A word measured over few voiced frames has an unreliable level — a
        # slightly loose alignment boundary drags silence into the window. Pull
        # those toward the reference rather than captioning them as quiet.
        conf = min(1.0, max(0.0, (w.get("voiced_ratio", 1.0) - 0.15) / 0.45))
        w["db"] = round(rel * conf, 2)
