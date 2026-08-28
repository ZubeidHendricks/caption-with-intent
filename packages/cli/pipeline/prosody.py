"""
Prosodic features beyond the three CWI V1.0 already uses.

WHY THIS IS MEASUREMENT AND NOT INFERENCE
-----------------------------------------
Systems like Tavus's Raven read emotion from the *speaker's face*, in real time,
and describe it in natural language. That is the right design for a
conversational agent. It is the wrong one to copy here, for a reason specific to
captioning:

    A Deaf viewer watching a film can already see the actor's face.

Telling them in type that a character "looks angry" duplicates what the picture
carries perfectly well. What the picture does NOT carry is the vocal channel —
and the highest-information case of all is where voice CONTRADICTS face:
sarcasm, suppressed anger, forced cheer, a threat delivered with a smile. That
is precisely what is lost without hearing, and precisely what a face-reading
model cannot supply.

So these are acoustic measurements, in the same spirit as the volume, pitch and
harmonics CWI already encodes. No emotion labels. Twenty years of research went
at emotion categories — Rashid, Aitken & Fels (2006) onward — and the approach
does not generalise, cannot be validated, and imposes a machine's reading of a
performance on the viewer. CWI's decision to encode measurable signal properties
instead is exactly why it is automatable at all.

A NOTE ON RESTRAINT
-------------------
The CWI team's own account of building V1.0 is that they over-indexed and pulled
back: "we learned subtlety prevents captions from becoming distracting." Five
more visual channels would repeat the mistake they already made and corrected.
Nothing here is rendered by default. It is measured, carried in the manifest,
and offered to an editor — and any decision to show it should be validated with
DHH viewers first, as the original system was.
"""
from __future__ import annotations

import numpy as np

import acoustics


def pitch_variation(f0: np.ndarray, voiced: np.ndarray) -> float:
    """
    Pitch movement across an utterance, in semitones (interquartile range).

    Flat delivery and animated delivery differ enormously here while having
    identical median pitch, so the weight axis alone cannot separate them. A
    monotone reading of a line lands near 0; an expressive one runs 4-8+.
    """
    v = f0[voiced]
    v = v[v > 0]
    if v.size < 4:
        return 0.0
    semis = 12.0 * np.log2(v / np.median(v))
    return float(np.percentile(semis, 75) - np.percentile(semis, 25))


def pitch_contour(f0: np.ndarray, voiced: np.ndarray) -> float:
    """
    Net pitch direction over the utterance, in semitones.

    Positive rises (questioning, uncertain, appealing), negative falls
    (assertive, closing, resigned). Terminal contour is one of the strongest
    grammatical cues in speech and is completely invisible in text: "you're
    going" and "you're going?" can be identical on the page.
    """
    v = f0[voiced]
    v = v[v > 0]
    if v.size < 6:
        return 0.0
    n = max(2, v.size // 3)
    start, end = np.median(v[:n]), np.median(v[-n:])
    return float(12.0 * np.log2(end / start)) if start > 0 else 0.0


def speech_rate(words: int, seconds: float) -> float:
    """Words per minute. Fast reads as urgent or anxious; slow as deliberate."""
    return float(words / seconds * 60.0) if seconds > 0 else 0.0


def harmonics_to_noise(x: np.ndarray, sr: int, f0: float) -> float:
    """
    Harmonics-to-noise ratio in dB — how much of the signal is periodic.

    Low HNR means breath and turbulence in the voice: breathiness, whisper,
    strain, tearfulness. High means a clear, well-supported tone. This separates
    "quiet because whispering" from "quiet because barely holding it together",
    which the volume axis alone flattens into the same small type.
    """
    if f0 <= 0 or x.size < int(sr / f0) * 3:
        return 0.0
    lag = int(round(sr / f0))
    a, b = x[:-lag], x[lag:]
    if a.size < 2:
        return 0.0
    denom = float(np.sqrt(np.sum(a * a) * np.sum(b * b)))
    if denom <= 0:
        return 0.0
    r = float(np.sum(a * b) / denom)
    r = min(max(r, 1e-6), 1 - 1e-6)
    return float(10.0 * np.log10(r / (1.0 - r)))


def jitter(f0: np.ndarray, voiced: np.ndarray) -> float:
    """
    Cycle-to-cycle pitch instability, as a fraction.

    Elevated jitter is heard as a tremor or a catch in the voice. It is one of
    the few acoustic correlates of distress that survives across speakers.
    """
    v = f0[voiced]
    v = v[v > 0]
    if v.size < 3:
        return 0.0
    periods = 1.0 / v
    return float(np.mean(np.abs(np.diff(periods))) / np.mean(periods))


def spectral_tilt(x: np.ndarray, sr: int) -> float:
    """
    Slope of the spectrum in dB per octave.

    Vocal effort flattens the tilt: a pressed or shouted voice puts far more
    energy in the upper harmonics than a relaxed one at the same measured
    loudness. Useful for telling a projected line from a loud one.
    """
    if x.size < 512:
        return 0.0
    win = np.hanning(x.size).astype(np.float32)
    spec = np.abs(np.fft.rfft(x * win)) + 1e-12
    freqs = np.fft.rfftfreq(x.size, 1.0 / sr)
    band = (freqs >= 100) & (freqs <= 5000)
    if band.sum() < 8:
        return 0.0
    lf = np.log2(freqs[band])
    db = 20.0 * np.log10(spec[band])
    slope, _ = np.polyfit(lf, db, 1)
    return float(slope)


def cue_features(x: np.ndarray, sr: int, frames: acoustics.Frames,
                 start: float, end: float, words: int) -> dict:
    """
    Prosody over one cue. Cue level rather than word level on purpose: contour,
    variation and rate are properties of a phrase, and estimating them per word
    reproduces exactly the estimator-noise problem that made per-word pitch
    unusable for the weight axis.
    """
    a = max(0, int(start / frames.hop_s))
    b = min(len(frames.f0), max(a + 1, int(end / frames.hop_s)))
    f0, voiced = frames.f0[a:b], frames.voiced[a:b]

    seg = x[int(start * sr):int(end * sr)]
    med_f0 = float(np.median(f0[voiced])) if voiced.any() else 0.0

    return {
        "pitchVariationSemitones": round(pitch_variation(f0, voiced), 2),
        "pitchContourSemitones": round(pitch_contour(f0, voiced), 2),
        "speechRateWpm": round(speech_rate(words, end - start), 1),
        "hnrDb": round(harmonics_to_noise(seg, sr, med_f0), 1),
        "jitter": round(jitter(f0, voiced), 4),
        "spectralTiltDbPerOctave": round(spectral_tilt(seg, sr), 2),
    }
