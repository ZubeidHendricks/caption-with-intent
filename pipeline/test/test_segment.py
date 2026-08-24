"""Cue segmentation and line breaking."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

import segment as seg  # noqa: E402


def words(text: str, rate: float = 0.34, speaker: str = "a", start: float = 0.0) -> list[dict]:
    out, t = [], start
    for tok in text.split():
        out.append({"text": tok, "start": round(t, 3), "end": round(t + rate * 0.85, 3), "speaker": speaker})
        t += rate
    return out


def texts(cues: list[list[dict]]) -> list[str]:
    return [" ".join(w["text"] for w in c) for c in cues]


class TestSegment(unittest.TestCase):
    def test_splits_on_speaker_change(self):
        ws = words("one two three", speaker="a") + words("four five", speaker="b", start=1.2)
        self.assertEqual(len(seg.segment(ws)), 2)

    def test_splits_on_a_long_pause(self):
        a = words("one two three")
        b = words("four five six", start=a[-1]["end"] + 2.0)
        self.assertEqual(len(seg.segment(a + b)), 2)

    def test_does_not_strand_an_article_on_a_pause(self):
        # A synthesizer pausing between "the" and its noun must not become a
        # caption break.
        a = words("Firestore holding the")
        b = words("tenant record.", start=a[-1]["end"] + 1.0)
        self.assertEqual(len(seg.segment(a + b)), 1)

    def test_prefers_a_clause_boundary_when_the_budget_runs_out(self):
        ws = words("The U R L is in the submission; you can ask it the same questions I just did.")
        cues = texts(seg.segment(ws))
        self.assertTrue(cues[0].endswith(";"), cues)

    def test_absorbs_a_one_word_stub(self):
        ws = words("The U R L is in the submission; you can ask it the same questions I just did.")
        for c in seg.segment(ws):
            self.assertGreater(len(c), 2, texts(seg.segment(ws)))

    def test_never_exceeds_the_character_budget(self):
        ws = words(" ".join(["alpha"] * 60))
        for c in seg.segment(ws):
            chars = sum(len(w["text"]) + 1 for w in c) - 1
            self.assertLessEqual(chars, seg.MAX_CHARS_PER_LINE * seg.MAX_LINES)

    def test_every_word_survives_exactly_once(self):
        ws = words("This is not a local demo. Cloud Run in us central one, Vertex AI serving Gemini, "
                   "Firestore holding the tenant record.")
        flat = [w["text"] for c in seg.segment(ws) for w in c]
        self.assertEqual(flat, [w["text"] for w in ws])

    def test_empty(self):
        self.assertEqual(seg.segment([]), [])


class TestWrap(unittest.TestCase):
    def test_short_cue_stays_one_line(self):
        self.assertEqual(len(seg.wrap(words("This is short."))), 1)

    def test_long_cue_splits_into_two(self):
        lines = seg.wrap(words("The U R L is in the submission you can ask it questions"))
        self.assertEqual(len(lines), 2)
        for line in lines:
            chars = sum(len(w["text"]) + 1 for w in line) - 1
            self.assertLessEqual(chars, seg.MAX_CHARS_PER_LINE + 8)

    def test_does_not_end_a_line_on_an_article(self):
        lines = seg.wrap(words("Firestore is holding the tenant record for every single account"))
        if len(lines) == 2:
            self.assertFalse(seg._is_sticky(lines[0][-1]),
                             " / ".join(" ".join(w["text"] for w in l) for l in lines))


class TestCueBounds(unittest.TestCase):
    def test_tail_never_overlaps_the_next_cue(self):
        a = words("one two three")
        b = words("four five six", start=a[-1]["end"] + 0.10)
        cues = [a, b]
        bounds = seg.cue_bounds(cues, tail=0.30)
        self.assertLess(bounds[0][1], bounds[1][0])

    def test_tail_applies_when_there_is_room(self):
        a = words("one two three")
        b = words("four five", start=a[-1]["end"] + 5.0)
        (_, end_a), _ = seg.cue_bounds([a, b], tail=0.30)
        self.assertAlmostEqual(end_a, a[-1]["end"] + 0.30, places=2)

    def test_end_is_never_before_the_last_word(self):
        a = words("one two")
        b = words("three", start=a[-1]["end"] + 0.001)
        for cue, (s, e) in zip([a, b], seg.cue_bounds([a, b])):
            self.assertGreaterEqual(e, cue[-1]["end"])
            self.assertLess(s, e)


if __name__ == "__main__":
    unittest.main()
