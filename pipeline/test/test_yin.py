"""
YIN estimation, with the octave error as the headline case.

Plain autocorrelation measured a 101 Hz voice at 162 Hz here because roughly a
third of its frames doubled. These tests pin that down so it cannot come back.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

import yin  # noqa: E402

SR = 16000


def frames_of(x: np.ndarray, n: int = 1024, hop: int = 160) -> np.ndarray:
    count = 1 + (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(count)[:, None]
    return x[idx]


def tone(f0: float, dur: float = 1.0, amps=(1.0, 0.5, 0.33, 0.25)) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    x = sum(a * np.sin(2 * np.pi * f0 * (k + 1) * t) for k, a in enumerate(amps))
    return (x / np.max(np.abs(x)) * 0.3).astype(np.float32)


def estimate(x: np.ndarray) -> float:
    f0, ap = yin.estimate(frames_of(x), SR)
    good = f0[ap < 0.3]
    return float(np.median(good)) if good.size else 0.0


class TestAccuracy(unittest.TestCase):
    def test_accurate_across_the_vocal_range(self):
        for truth in (70, 85, 95, 101, 120, 150, 175, 215, 250, 300, 400):
            est = estimate(tone(truth))
            self.assertLess(abs(est - truth) / truth, 0.02, f'{truth} Hz -> {est:.1f} Hz')

    def test_weak_fundamental_does_not_cause_doubling(self):
        # The exact trap that broke autocorrelation: 2nd harmonic 5x the
        # fundamental. A doubling estimator returns 2 * truth here.
        for truth in (85, 101, 120, 150):
            est = estimate(tone(truth, amps=(0.2, 1.0, 0.6, 0.3)))
            self.assertLess(abs(est - truth) / truth, 0.03,
                            f'{truth} Hz -> {est:.1f} Hz (doubling would give {truth * 2})')

    def test_missing_fundamental_still_resolves(self):
        # A telephone-band voice can have almost no energy at f0 itself.
        for truth in (110, 150, 200):
            est = estimate(tone(truth, amps=(0.0, 1.0, 0.7, 0.4)))
            self.assertLess(abs(est - truth) / truth, 0.03, f'{truth} Hz -> {est:.1f} Hz')

    def test_survives_added_noise(self):
        rng = np.random.default_rng(3)
        x = tone(140) + rng.normal(0, 0.03, int(SR)).astype(np.float32)
        self.assertLess(abs(estimate(x) - 140) / 140, 0.05)


class TestAperiodicity(unittest.TestCase):
    def test_periodic_input_scores_low(self):
        _, ap = yin.estimate(frames_of(tone(150)), SR)
        self.assertLess(float(np.median(ap)), 0.2)

    def test_noise_scores_high(self):
        rng = np.random.default_rng(1)
        noise = rng.normal(0, 0.2, SR).astype(np.float32)
        _, ap = yin.estimate(frames_of(noise), SR)
        # Noise must not masquerade as voiced; this is what the level gate alone
        # could not catch for a loud unvoiced consonant.
        self.assertGreater(float(np.median(ap)), 0.4)

    def test_silence_yields_no_pitch(self):
        f0, ap = yin.estimate(frames_of(np.zeros(SR, dtype=np.float32)), SR)
        self.assertEqual(int((ap < 0.3).sum()), 0)


class TestBounds(unittest.TestCase):
    def test_respects_the_configured_range(self):
        f0, _ = yin.estimate(frames_of(tone(300)), SR, f0_min=60, f0_max=200)
        self.assertTrue(np.all((f0 == 0) | ((f0 >= 60) & (f0 <= 200))))

    def test_degenerate_input_does_not_crash(self):
        f0, ap = yin.estimate(np.zeros((2, 16), dtype=np.float32), SR)
        self.assertEqual(f0.shape, (2,))
        self.assertTrue(np.all(ap <= 1.0))


if __name__ == "__main__":
    unittest.main()
