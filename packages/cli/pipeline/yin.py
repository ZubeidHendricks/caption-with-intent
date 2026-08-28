"""
YIN fundamental frequency estimation.

Replaces plain autocorrelation, which has one dominant failure mode: it peaks at
every multiple of the true period, so a strong second harmonic pulls the
estimate to double the true pitch. That is not hypothetical here — a 101 Hz
voice measured 162 Hz, because roughly a third of its frames doubled.

A post-hoc "is there a comparable peak at twice the lag" correction was tried
first and rejected: it over-corrected higher voices into sub-octave errors and
did not fix the doubling it targeted.

YIN (de Cheveigné & Kawahara, 2002) fixes it structurally rather than by
patching. Two steps do the work:

  1. The cumulative mean normalised difference divides d(tau) by the running
     mean of all shorter lags. Harmonic dips sit at multiples of the true
     period, so by the time you reach them the running mean has already been
     dragged down by the true dip — which suppresses them relative to it.

  2. Take the FIRST lag below an absolute threshold, not the global minimum.
     The fundamental is the shortest period that explains the signal; any
     harmonic dip is a longer lag, and any sub-harmonic a shorter one that
     fails the threshold. Choosing "first below threshold" is the whole octave
     fix, and it is why patching a global-minimum search could never work.

numpy only, vectorised over frames.
"""
from __future__ import annotations

import numpy as np


def _difference(frames: np.ndarray, max_lag: int) -> np.ndarray:
    """
    YIN's squared difference d(tau), for every frame at once.

        d(tau) = sum_j (x[j] - x[j+tau])^2
               = pow(0..W) + pow(tau..tau+W) - 2 * r(tau)

    Computed from power prefix sums and an FFT autocorrelation so the whole
    thing stays O(n log n) rather than O(n * max_lag).
    """
    n_frames, w = frames.shape
    window = w - max_lag

    power = np.concatenate([np.zeros((n_frames, 1)), np.cumsum(frames ** 2, axis=1)], axis=1)
    first = (power[:, window:window + 1] - power[:, 0:1])                      # constant per frame
    shifted = power[:, np.arange(max_lag) + window] - power[:, np.arange(max_lag)]

    # r(tau) must sum over exactly the same j range as the power terms, i.e.
    # cross-correlate x[0:window] against x[0:window+max_lag]. Autocorrelating
    # the whole frame instead sums over more j at short lags than at long ones,
    # which tilts d(tau) and biases every estimate a few percent high.
    a = frames[:, :window]
    b = frames[:, :window + max_lag]
    nfft = 1 << int(np.ceil(np.log2(window + max_lag)))
    corr = np.fft.irfft(
        np.fft.rfft(b, n=nfft, axis=1) * np.conj(np.fft.rfft(a, n=nfft, axis=1)),
        n=nfft, axis=1,
    )[:, :max_lag]

    return np.maximum(first + shifted - 2 * corr, 0.0)


def _cumulative_mean(d: np.ndarray) -> np.ndarray:
    """d'(tau): divide by the running mean of all shorter lags. d'(0) := 1."""
    n_frames, max_lag = d.shape
    out = np.ones_like(d)
    if max_lag < 2:
        return out
    taus = np.arange(1, max_lag)
    running = np.cumsum(d[:, 1:], axis=1) / taus
    out[:, 1:] = d[:, 1:] / np.maximum(running, 1e-12)
    return out


def _first_below(dp: np.ndarray, threshold: float, lag_min: int, lag_max: int) -> np.ndarray:
    """
    Smallest lag in range whose d' falls below `threshold`, else the range's
    global minimum. Returns -1 where the frame has no usable candidate.
    """
    band = dp[:, lag_min:lag_max]
    below = band < threshold

    # argmax on a boolean gives the first True; guard the all-False rows.
    first = np.argmax(below, axis=1)
    has = below.any(axis=1)

    # Walk each accepted candidate down to the actual local minimum: the first
    # crossing is on the shoulder of the dip, not its floor.
    for i in np.flatnonzero(has):
        j = first[i]
        while j + 1 < band.shape[1] and band[i, j + 1] < band[i, j]:
            j += 1
        first[i] = j

    fallback = np.argmin(band, axis=1)
    return np.where(has, first, fallback) + lag_min


def _parabolic(dp: np.ndarray, lags: np.ndarray) -> np.ndarray:
    """Sub-sample refinement of each chosen lag."""
    n_frames, max_lag = dp.shape
    idx = np.arange(n_frames)
    lo = dp[idx, np.clip(lags - 1, 0, max_lag - 1)]
    mid = dp[idx, np.clip(lags, 0, max_lag - 1)]
    hi = dp[idx, np.clip(lags + 1, 0, max_lag - 1)]
    denom = lo - 2 * mid + hi
    shift = np.where(np.abs(denom) > 1e-12, 0.5 * (lo - hi) / np.where(np.abs(denom) > 1e-12, denom, 1.0), 0.0)
    return lags + np.clip(shift, -1.0, 1.0)


def estimate(
    frames: np.ndarray,
    sr: int,
    f0_min: float = 60.0,
    f0_max: float = 500.0,
    threshold: float = 0.15,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Estimate f0 per frame.

    Returns `(f0, aperiodicity)`. Aperiodicity is d' at the chosen lag: 0 is a
    perfectly periodic frame, 1 is noise. Callers use it as a voicing
    confidence — it is a better signal than raw energy, because a loud unvoiced
    consonant is still unvoiced.
    """
    max_lag = min(int(sr / f0_min) + 2, frames.shape[1] // 2)
    lag_min = max(2, int(sr / f0_max))
    if max_lag <= lag_min + 2:
        z = np.zeros(frames.shape[0])
        return z, np.ones_like(z)

    centred = frames - frames.mean(axis=1, keepdims=True)
    dp = _cumulative_mean(_difference(centred, max_lag))

    # Silence is degenerate: d(tau) is identically zero, so d'(tau) is 0/0 and
    # the frame reads as *perfectly periodic* rather than as no signal at all.
    # Without this, gaps between words come back confidently voiced and get a
    # pitch. Energy is the only thing that can distinguish the two cases.
    energy = np.mean(centred ** 2, axis=1)
    silent = energy < 1e-9

    lags = _first_below(dp, threshold, lag_min, max_lag)
    refined = _parabolic(dp, lags)

    f0 = np.where(refined > 0, sr / np.maximum(refined, 1e-9), 0.0)
    aperiodicity = dp[np.arange(len(lags)), np.clip(lags, 0, dp.shape[1] - 1)]

    outside = (f0 < f0_min) | (f0 > f0_max) | silent
    f0 = np.where(outside, 0.0, f0)
    aperiodicity = np.where(outside, 1.0, aperiodicity)
    return f0, np.clip(aperiodicity, 0.0, 1.0)
