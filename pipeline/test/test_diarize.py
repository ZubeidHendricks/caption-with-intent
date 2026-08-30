"""
Speaker separation, and the limits of doing it from pitch and timbre.

These tests exist mostly to pin down what this can and cannot do, because the
temptation with diarization is to report a number and move on. Two fixtures:
three voices an octave apart, which it should get right, and a narrator against
an on-camera voice at *identical* pitch, which it should not be trusted on.
"""
from __future__ import annotations

import itertools
import json
import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import diarize as D  # noqa: E402
import make_fixture  # noqa: E402
import make_narration  # noqa: E402


def agreement(wav: Path, words_json: Path) -> tuple[int, float]:
    """Speakers found, and best-case agreement with the true labelling."""
    data = json.loads(words_json.read_text())
    truth = [w["speaker"] for w in data["words"]]
    words = [{k: v for k, v in w.items() if k != "speaker"} for w in data["words"]]
    speakers = D.diarize_by_voice(wav, words)
    got = [w["speaker"] for w in words]

    # Cluster ids are arbitrary, so score under the best possible mapping.
    left, right = sorted(set(got)), sorted(set(truth))
    src, dst = (left, right) if len(left) <= len(right) else (right, left)
    best = 0.0
    for perm in itertools.permutations(dst, len(src)):
        m = dict(zip(src, perm))
        hits = sum(1 for g, t in zip(got, truth)
                   if (m.get(g) == t if len(left) <= len(right) else m.get(t) == g))
        best = max(best, hits / len(truth))
    return len(speakers), best


class TestChoosingK(unittest.TestCase):
    def test_never_one_cluster_per_point(self):
        """
        The bug this replaced: the old criterion asked whether an extra cluster
        reduced within-cluster spread, and spread reaches exactly zero when
        every point is its own cluster. So on a four-utterance scene it chose
        four speakers, each a single point, and two — the right answer — was
        never considered.
        """
        x = np.array([[0.0, 0.0], [0.1, 0.1], [3.0, 3.0], [3.1, 3.1]])
        k, _ = D.choose_k(x)
        self.assertLessEqual(k, len(x) // 2)
        self.assertEqual(k, 2)

    def test_a_single_voice_is_not_split(self):
        rng = np.random.default_rng(3)
        x = rng.normal(0, 0.05, (12, 2))          # one tight blob
        k, _ = D.choose_k(x)
        self.assertEqual(k, 1, "noise around one voice is not two people")

    def test_silhouette_does_not_reward_singletons(self):
        x = np.array([[0.0, 0.0], [0.1, 0.0], [5.0, 5.0], [5.1, 5.0]])
        two = D.silhouette(x, np.array([0, 0, 1, 1]), 2)
        each = D.silhouette(x, np.array([0, 1, 2, 3]), 4)
        self.assertGreater(two, each)


class TestOnRecordings(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (HERE / "fixture.wav").exists():
            make_fixture.main()
        if not (HERE / "narration.wav").exists():
            make_narration.main()

    def test_voices_at_different_pitches_are_separated(self):
        found, acc = agreement(HERE / "fixture.wav", HERE / "fixture.words.json")
        self.assertEqual(found, 3, "three voices an octave apart")
        self.assertGreaterEqual(acc, 0.95, f"agreement was {acc:.0%}")

    def test_a_narrator_at_the_same_pitch_is_approximate_at_best(self):
        """
        The case a viewer notices immediately — narration and an on-camera voice
        in one colour — and the case this method is weakest on. Both voices here
        are the same harmonic stack at the same f0 by construction, so only the
        channel differs. It gets the count right and misplaces some words.

        The bound is deliberately loose. Asserting a precise figure here would
        be pinning a number that has no business being stable, and asserting a
        high one would be claiming a reliability this does not have.
        """
        found, acc = agreement(HERE / "narration.wav", HERE / "narration.words.json")
        self.assertEqual(found, 2, "it should at least notice there are two")
        self.assertGreater(acc, 0.6, f"agreement was {acc:.0%}")
        self.assertLess(acc, 1.0, "if this ever hits 100% the fixture stopped being hard")


if __name__ == "__main__":
    unittest.main()
