"""
Does the trust harness actually detect the things a real soundtrack does?

There is no real film here, so this cannot prove the pipeline works on one. What
it can prove is the more useful half: that when the conditions the mapping
assumes are violated, the harness *says so* rather than reporting confident
numbers. Each test takes the clean synthetic fixture and breaks exactly one
assumption in the way a real mix breaks it.

A detector that has only ever been run on clean input is not a detector.
"""
from __future__ import annotations

import json
import unittest
import wave
from pathlib import Path

import numpy as np

import evaluate
from evaluate import evaluate as run_eval, size_from_db, spectral_flatness

HERE = Path(__file__).parent
FIXTURE = HERE / "fixture.wav"
MANIFEST = HERE / "fixture.cwi.json"


def load() -> tuple[np.ndarray, int, dict]:
    with wave.open(str(FIXTURE), "rb") as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    return x, sr, json.loads(MANIFEST.read_text(encoding="utf-8"))


def write(x: np.ndarray, sr: int, path: Path) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    return path


class TestSizeMapping(unittest.TestCase):
    """The one piece of spec arithmetic duplicated on this side of the fence."""

    def test_baseline_and_bounds_match_the_spec(self):
        self.assertAlmostEqual(size_from_db(0.0), 5.0, places=6)
        self.assertAlmostEqual(size_from_db(12.0), 12.0, places=6)
        self.assertAlmostEqual(size_from_db(-18.0), 3.0, places=6)

    def test_the_knee_keeps_ordinary_speech_still(self):
        # +/-6 dB of conversational variation must not visibly pulse the line.
        self.assertLess(abs(size_from_db(6.0) - 5.0), 0.61)
        self.assertLess(abs(size_from_db(-6.0) - 5.0), 0.61)

    def test_monotonic(self):
        xs = [size_from_db(d) for d in range(-24, 16)]
        self.assertEqual(xs, sorted(xs))


class TestFlatness(unittest.TestCase):
    def test_a_tone_is_peaky_and_noise_is_flat(self):
        sr = 16000
        t = np.arange(sr) / sr
        tone = np.sin(2 * np.pi * 200 * t).astype(np.float32)
        noise = np.random.default_rng(0).normal(0, 0.3, sr).astype(np.float32)
        self.assertLess(spectral_flatness(tone, sr), 0.01)
        self.assertGreater(spectral_flatness(noise, sr), 0.3)


class TestDetection(unittest.TestCase):
    """Break one assumption at a time; the harness must name the one broken."""

    def setUp(self):
        self.x, self.sr, self.manifest = load()
        self.tmp = HERE / "_eval_tmp.wav"

    def tearDown(self):
        self.tmp.unlink(missing_ok=True)

    def test_the_clean_fixture_passes(self):
        # The control. If this ever fails the thresholds have drifted into
        # flagging correct input, which is worse than missing bad input.
        r = run_eval(FIXTURE, self.manifest, workdir=HERE)
        self.assertEqual(r.suspect, 0, r.findings)
        self.assertEqual(r.verdict, "the assumptions hold across this film")

    def test_a_music_bed_is_detected(self):
        # A scored scene: broadband music under the dialogue at a level a mixer
        # would consider tasteful. The words are still audible; the *analysis*
        # is no longer measuring only the voice.
        rng = np.random.default_rng(1)
        n = len(self.x)
        t = np.arange(n) / self.sr
        # Chords plus a noise floor: harmonically dense, unlike a single voice.
        bed = sum(np.sin(2 * np.pi * f * t) for f in (110, 165, 220, 277, 330))
        bed = (bed / 5 + rng.normal(0, 0.35, n)) * 0.30
        r = run_eval(write(self.x + bed.astype(np.float32), self.sr, self.tmp),
                     self.manifest, workdir=HERE)
        self.assertGreater(r.suspect, 0, "a music bed must reduce confidence")
        flags = [f for c in r.per_cue for f in c["flags"]]
        self.assertTrue(any("flat" in f or "above the surrounding mix" in f for f in flags),
                        f"expected a mix-related flag, got {flags}")

    def test_broadcast_compression_is_detected(self):
        # The failure nobody notices: the words are perfectly clear, every
        # reading is "accurate", and the design conveys nothing because there
        # is no dynamic range left to map.
        flat = dict(self.manifest)
        flat["cues"] = [
            {**c, "lines": [{"tokens": [{**t, "db": 0.2 if t.get("db", 0) > 0 else -0.2}
                                        for t in l["tokens"]]} for l in c["lines"]]}
            for c in self.manifest["cues"]
        ]
        r = run_eval(FIXTURE, flat, workdir=HERE)
        self.assertLess(r.size_spread_pct, evaluate.SIZE_SPREAD_MIN)
        self.assertTrue(any("compressed flat" in f for f in r.findings), r.findings)

    def test_octave_errors_in_one_voice_are_detected(self):
        # A speaker read an octave high in half their lines puts that
        # character's font weight all over the place, and nothing else notices.
        broken = dict(self.manifest)
        cues = []
        for i, c in enumerate(self.manifest["cues"]):
            mult = 2.0 if i % 2 else 1.0
            cues.append({**c, "lines": [
                {"tokens": [{**t, "f0": (t.get("f0") or 150) * mult} for t in l["tokens"]]}
                for l in c["lines"]]})
        broken["cues"] = cues
        r = run_eval(FIXTURE, broken, workdir=HERE)
        self.assertTrue(any("octave errors" in f for f in r.findings), r.findings)

    def test_overlapping_speakers_are_detected(self):
        # Segmentation assumes one voice at a time. Two people talking over
        # each other produces readings that describe their sum.
        m = dict(self.manifest)
        cues = [dict(c) for c in self.manifest["cues"]]
        cues[1]["start"] = cues[0]["end"] - 0.6      # genuine overlap
        m["cues"] = cues
        r = run_eval(FIXTURE, m, workdir=HERE)
        self.assertTrue(r.overlaps, "an overlap must be reported")
        self.assertTrue(any("overlap" in f for f in r.findings), r.findings)

    def test_unreadable_cues_are_flagged_without_lowering_trust(self):
        # A cue too fast to read is a caption defect, not a measurement problem.
        # It must be reported, and it must not make the acoustics look wrong.
        m = dict(self.manifest)
        cues = [dict(c) for c in self.manifest["cues"]]
        cues[0] = {**cues[0], "end": cues[0]["start"] + 0.4}
        m["cues"] = cues
        r = run_eval(FIXTURE, m, workdir=HERE)
        first = r.per_cue[0]
        self.assertTrue(any("characters/second" in f for f in first["flags"]), first["flags"])
        self.assertEqual(first["confidence"], 1.0,
                         "reading rate is a caption defect, not an analysis one")

    def test_a_mostly_bad_film_is_called_unreliable(self):
        # The verdict has to be usable by someone who will not read the detail.
        rng = np.random.default_rng(2)
        noise = rng.normal(0, 0.25, len(self.x)).astype(np.float32)
        r = run_eval(write(self.x * 0.15 + noise, self.sr, self.tmp),
                     self.manifest, workdir=HERE)
        self.assertIn("unreliable", r.verdict)


if __name__ == "__main__":
    unittest.main()
