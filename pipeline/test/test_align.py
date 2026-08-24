"""
Alignment accuracy against the synthetic fixture's ground-truth onsets.

Caveat worth stating: the fixture is harmonic tones with hard amplitude
envelopes, not speech. These numbers bound the *algorithm*, not real-world TTS
accuracy. Where a provider returns its own alignment (ElevenLabs does), use
that instead — it is exact and this module is unnecessary.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import acoustics  # noqa: E402
import align  # noqa: E402
import make_fixture  # noqa: E402


def utterances(words: list[dict]) -> list[list[dict]]:
    """Split on speaker change or a long pause — one TTS call per utterance."""
    out, cur = [], [words[0]]
    for w in words[1:]:
        if w["speaker"] != cur[-1]["speaker"] or w["start"] - cur[-1]["end"] > 0.4:
            out.append(cur)
            cur = []
        cur.append(w)
    out.append(cur)
    return out


class TestSyllables(unittest.TestCase):
    def test_counts(self):
        for word, n in [("a", 1), ("the", 1), ("empty", 2), ("Detective", 3),
                        ("unbelievable", 5), ("stayed", 1), ("strength", 1)]:
            self.assertEqual(align.syllables(word), n, word)

    def test_duration_is_monotonic_in_syllables(self):
        self.assertLess(align.predicted_duration("a"), align.predicted_duration("empty"))
        self.assertLess(align.predicted_duration("empty"), align.predicted_duration("unbelievable"))


class TestVad(unittest.TestCase):
    def test_silence_yields_no_segments(self):
        x = np.zeros(16000, dtype=np.float32)
        self.assertEqual(align.detect_speech(acoustics.analyze_frames(x, 16000)), [])

    def test_finds_the_right_number_of_bursts(self):
        sr = 16000
        x = np.zeros(int(3.0 * sr), dtype=np.float32)
        t = np.arange(int(0.30 * sr)) / sr
        tone = (np.sin(2 * np.pi * 150 * t) * 0.3).astype(np.float32)
        for start in (0.4, 1.2, 2.0):
            i = int(start * sr)
            x[i:i + len(tone)] += tone
        segs = align.detect_speech(acoustics.analyze_frames(x, sr))
        self.assertEqual(len(segs), 3)
        for seg, start in zip(segs, (0.4, 1.2, 2.0)):
            self.assertLess(abs(seg.start - start), 0.05)


class TestAlignment(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        make_fixture.main()
        cls.truth = json.loads((HERE / "fixture.words.json").read_text())["words"]
        cls.x, cls.sr = acoustics.read_wav(HERE / "fixture.wav")

    def aligned(self) -> list[dict]:
        pack = []
        for u in utterances(self.truth):
            a, b = u[0]["start"] - 0.12, u[-1]["end"] + 0.12
            pack.append(([w["text"] for w in u], self.x[int(a * self.sr):int(b * self.sr)], a))
        return align.align_utterances(pack, self.sr)

    def test_returns_every_word_in_order(self):
        got = self.aligned()
        self.assertEqual([g["text"] for g in got], [t["text"] for t in self.truth])
        for g in got:
            self.assertLess(g["start"], g["end"])
        for a, b in zip(got[:-1], got[1:]):
            self.assertLessEqual(a["start"], b["start"])

    def test_onset_accuracy(self):
        err = np.array([abs(g["start"] - t["start"]) for g, t in zip(self.aligned(), self.truth)])
        self.assertLess(float(np.median(err)), 0.060, f"median {np.median(err) * 1000:.0f}ms")
        self.assertLess(float(np.percentile(err, 90)), 0.110, f"p90 {np.percentile(err, 90) * 1000:.0f}ms")
        self.assertGreater(float((err < 0.100).mean()), 0.90)

    def test_per_utterance_bounds_the_error(self):
        """
        A whole-take alignment lets one bad boundary cascade. Per utterance the
        damage is contained — this is the reason align_utterances exists.
        """
        whole = align.align([w["text"] for w in self.truth], self.x, self.sr)
        whole_err = np.array([abs(g["start"] - t["start"]) for g, t in zip(whole, self.truth)])
        per_err = np.array([abs(g["start"] - t["start"]) for g, t in zip(self.aligned(), self.truth)])
        self.assertLess(per_err.max(), whole_err.max())

    def test_empty_input(self):
        self.assertEqual(align.align([], self.x, self.sr), [])


if __name__ == "__main__":
    unittest.main()
