"""
End-to-end pipeline checks against a synthetic scene with known ground truth.

    python3 -m unittest discover -s pipeline/test -t .
"""
from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))   # pipeline/
sys.path.insert(0, str(HERE))          # pipeline/test/

import acoustics  # noqa: E402
import transcript as tr  # noqa: E402
import make_fixture  # noqa: E402


class TestAcoustics(unittest.TestCase):
    SR = 16000

    def _tone(self, f0: float, dur: float = 1.0, amp: float = 0.2, tilt: float = 0.7) -> np.ndarray:
        t = np.arange(int(dur * self.SR)) / self.SR
        sig = sum((tilt ** (k - 1)) * np.sin(2 * np.pi * f0 * k * t)
                  for k in range(1, 20) if f0 * k < self.SR / 2)
        return (sig / np.max(np.abs(sig)) * amp).astype(np.float32)

    def test_f0_accurate_across_the_vocal_range(self):
        # The spec cites 80-250 Hz as the typical voice; we support wider.
        for truth in (85, 95, 120, 175, 215, 250, 300):
            f = acoustics.analyze_frames(self._tone(truth), self.SR)
            est = float(np.median(f.f0[f.voiced]))
            self.assertLess(abs(est - truth) / truth, 0.02, f"{truth} Hz -> {est:.1f} Hz")

    def test_silence_is_unvoiced(self):
        x = np.zeros(self.SR, dtype=np.float32)
        f = acoustics.analyze_frames(x, self.SR)
        self.assertEqual(int(f.voiced.sum()), 0)

    def test_centroid_tracks_spectral_tilt(self):
        bright = acoustics.analyze_frames(self._tone(150, tilt=0.95), self.SR)
        dark = acoustics.analyze_frames(self._tone(150, tilt=0.4), self.SR)
        self.assertGreater(np.median(bright.centroid[bright.voiced]),
                           np.median(dark.centroid[dark.voiced]))

    def test_dialogue_reference_is_the_mode_not_the_mean(self):
        # 20 normal words at -18, 10 shouts at -6, 2 whispers at -34.
        levels = np.array([-18.0] * 20 + [-6.0] * 10 + [-34.0] * 2)
        ref = acoustics.dialogue_reference(levels)
        self.assertAlmostEqual(ref, -18.0, delta=1.6)
        # A mean sits 2.75 dB off, which would shift every caption on screen.
        self.assertGreater(abs(float(levels.mean()) - (-18.0)), 2.0)

    def test_dialogue_reference_resists_a_shout_heavy_speaker(self):
        # The bug this replaced: 'median of the upper half' anchored on shouts,
        # so normal speech came out negative and shouts came out as baseline.
        levels = np.array([-18.0] * 6 + [-9.0] * 4)
        self.assertAlmostEqual(acoustics.dialogue_reference(levels), -18.0, delta=1.6)


class TestEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        make_fixture.main()
        cls.out = HERE / "pipeline.cwi.json"
        subprocess.run(
            [sys.executable, str(HERE.parent / "analyze.py"),
             "--media", str(HERE / "fixture.wav"),
             "--transcript", str(HERE / "fixture.words.json"),
             "--out", str(cls.out)],
            check=True, capture_output=True,
        )
        cls.m = json.loads(cls.out.read_text())

    def tokens_for(self, speaker: str) -> list[dict]:
        return [t for c in self.m["cues"] if c["speaker"] == speaker
                for l in c["lines"] for t in l["tokens"]]

    def test_manifest_shape(self):
        self.assertEqual(self.m["cwi"], "1.0")
        self.assertEqual(len(self.m["characters"]), 3)
        self.assertTrue(all(len(c["lines"]) <= 2 for c in self.m["cues"]),
                        "spec 2.4.2: at most two lines per frame")

    def test_recovers_each_voice_pitch(self):
        for spk, truth in (("BASS", 95), ("MID", 175), ("HIGH", 250)):
            f0s = [t["f0"] for t in self.tokens_for(spk) if t["f0"] > 0]
            est = float(np.median(f0s))
            self.assertLess(abs(est - truth) / truth, 0.03, f"{spk}: {est:.1f} vs {truth}")

    def test_normal_speech_lands_on_the_spec_baseline(self):
        # MID's first line is at reference level, so it must read ~0 dB.
        first = self.tokens_for("MID")[:6]
        self.assertLess(abs(float(np.median([t["db"] for t in first]))), 1.5)

    def test_shout_and_whisper_are_separated(self):
        mid = self.tokens_for("MID")
        shout = [t for t in mid if t["text"] in ("Show", "me", "your", "hands")]
        self.assertGreater(float(np.median([t["db"] for t in shout])), 6.0)

        whisper = [t for t in self.tokens_for("BASS") if t["text"] in ("should", "have", "stayed")]
        self.assertLess(float(np.median([t["db"] for t in whisper])), -8.0)

    def test_off_camera_flag_survives(self):
        bass_cues = [c for c in self.m["cues"] if c["speaker"] == "BASS"]
        self.assertFalse(bass_cues[0]["onCamera"], "Kroft's first line is off-screen")
        self.assertTrue(bass_cues[-1]["onCamera"])

    def test_word_onsets_are_ordered_and_inside_their_cue(self):
        for c in self.m["cues"]:
            for line in c["lines"]:
                prev = -1.0
                for t in line["tokens"]:
                    self.assertGreaterEqual(t["start"], prev)
                    self.assertGreaterEqual(t["start"], c["start"] - 1e-6)
                    self.assertLessEqual(t["end"], c["end"] + 1e-6)
                    prev = t["start"]

    def test_cues_split_on_speaker_change(self):
        speakers = [c["speaker"] for c in self.m["cues"]]
        self.assertEqual(len(speakers), len(make_fixture.SCRIPT))
        self.assertEqual(speakers, [s for s, _, _ in make_fixture.SCRIPT])


class TestWebVtt(unittest.TestCase):
    def test_parses_speaker_tags_and_distributes_words(self):
        vtt = HERE / "sample.vtt"
        vtt.write_text(
            "WEBVTT\n\n"
            "00:00:01.000 --> 00:00:03.000\n<v Vale>You said the yard was empty\n\n"
            "00:00:03.500 --> 00:00:05.000\nKROFT: Nothing here is empty\n"
        )
        data = tr.from_webvtt(vtt)
        self.assertEqual({w["speaker"] for w in data["words"]}, {"Vale", "KROFT"})
        self.assertEqual(len(data["words"]), 10)  # 6 + 4
        for w in data["words"]:
            self.assertLess(w["start"], w["end"])
        vtt.unlink()


if __name__ == "__main__":
    unittest.main()
