"""
Prosody measurements. These must *discriminate* — a feature that returns a
plausible number for everything is worse than no feature, because it invites a
rendering decision built on noise.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import acoustics  # noqa: E402
import prosody  # noqa: E402

SR = 16000


def utterance(f0s, dur=1.2, noise=0.0, harmonics=12):
    n = int(dur * SR)
    f = np.interp(np.linspace(0, 1, n), np.linspace(0, 1, len(f0s)), f0s)
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = sum(np.sin(ph * k) / k for k in range(1, harmonics))
    x = x / np.max(np.abs(x)) * 0.3
    if noise:
        x = x + np.random.default_rng(0).normal(0, noise, x.size)
    return x.astype(np.float32)


class TestPitchFeatures(unittest.TestCase):
    def frames(self, x):
        return acoustics.analyze_frames(x, SR)

    def test_monotone_has_no_variation(self):
        f = self.frames(utterance([150, 150, 150]))
        self.assertLess(prosody.pitch_variation(f.f0, f.voiced), 0.5)

    def test_animated_delivery_shows_variation(self):
        flat = self.frames(utterance([150, 150, 150]))
        lively = self.frames(utterance([130, 190, 140, 200, 145]))
        self.assertGreater(prosody.pitch_variation(lively.f0, lively.voiced),
                           prosody.pitch_variation(flat.f0, flat.voiced) + 1.5)

    def test_contour_separates_a_question_from_a_statement(self):
        # The single most common thing text cannot carry: "you're going" and
        # "you're going?" are identical on the page.
        rising = self.frames(utterance([140, 150, 170, 200]))
        falling = self.frames(utterance([200, 170, 150, 135]))
        self.assertGreater(prosody.pitch_contour(rising.f0, rising.voiced), 2.0)
        self.assertLess(prosody.pitch_contour(falling.f0, falling.voiced), -2.0)

    def test_degrades_to_zero_rather_than_guessing(self):
        silence = np.zeros(SR, dtype=np.float32)
        f = self.frames(silence)
        self.assertEqual(prosody.pitch_variation(f.f0, f.voiced), 0.0)
        self.assertEqual(prosody.pitch_contour(f.f0, f.voiced), 0.0)


class TestVoiceQuality(unittest.TestCase):
    def test_hnr_separates_clear_from_breathy(self):
        clear = prosody.harmonics_to_noise(utterance([150]), SR, 150)
        breathy = prosody.harmonics_to_noise(utterance([150], noise=0.25), SR, 150)
        self.assertGreater(clear, 15.0)
        self.assertLess(breathy, clear - 15.0)

    def test_spectral_tilt_separates_pressed_from_relaxed(self):
        # A pressed voice puts more energy up top at the same measured loudness,
        # which the volume axis alone cannot distinguish.
        bright = prosody.spectral_tilt(utterance([150], noise=0.3), SR)
        dark = prosody.spectral_tilt(utterance([150]), SR)
        self.assertGreater(bright, dark + 3.0)

    def test_jitter_rises_with_instability(self):
        steady = acoustics.analyze_frames(utterance([150, 150]), SR)
        shaky = acoustics.analyze_frames(utterance([140, 165, 142, 168, 145, 162]), SR)
        self.assertGreaterEqual(prosody.jitter(shaky.f0, shaky.voiced),
                                prosody.jitter(steady.f0, steady.voiced))

    def test_short_or_silent_input_returns_zero(self):
        self.assertEqual(prosody.harmonics_to_noise(np.zeros(10, dtype=np.float32), SR, 150), 0.0)
        self.assertEqual(prosody.spectral_tilt(np.zeros(10, dtype=np.float32), SR), 0.0)
        self.assertEqual(prosody.harmonics_to_noise(utterance([150]), SR, 0), 0.0)


class TestSpeechRate(unittest.TestCase):
    def test_rate(self):
        self.assertAlmostEqual(prosody.speech_rate(10, 3.0), 200.0, places=1)
        self.assertEqual(prosody.speech_rate(5, 0), 0.0)


class TestCueFeatures(unittest.TestCase):
    def test_returns_every_field_and_no_nans(self):
        x = utterance([130, 180, 140], dur=2.0)
        f = acoustics.analyze_frames(x, SR)
        out = prosody.cue_features(x, SR, f, 0.1, 1.9, words=6)
        for key in ('pitchVariationSemitones', 'pitchContourSemitones', 'speechRateWpm',
                    'hnrDb', 'jitter', 'spectralTiltDbPerOctave'):
            self.assertIn(key, out)
            self.assertTrue(np.isfinite(out[key]), f'{key} is not finite')

    def test_survives_a_silent_cue(self):
        x = np.zeros(int(2 * SR), dtype=np.float32)
        f = acoustics.analyze_frames(x, SR)
        out = prosody.cue_features(x, SR, f, 0.1, 1.9, words=3)
        self.assertTrue(all(np.isfinite(v) for v in out.values()))


if __name__ == "__main__":
    unittest.main()
