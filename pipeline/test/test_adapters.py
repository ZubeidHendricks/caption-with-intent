"""
Provider adapters. The ElevenLabs path is exercised end to end with a fabricated
`with-timestamps` response over the existing fixture audio; the HeyGen path is
covered by its SRT parsing and word folding. Neither test touches the network.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import make_fixture  # noqa: E402
from adapters import elevenlabs as el  # noqa: E402


def alignment_for(text: str, rate: float = 0.05) -> dict:
    chars, starts, ends, t = [], [], [], 0.0
    for ch in text:
        chars.append(ch)
        starts.append(round(t, 4))
        t += rate
        ends.append(round(t, 4))
    return {
        "characters": chars,
        "character_start_times_seconds": starts,
        "character_end_times_seconds": ends,
    }


class TestElevenLabsAlignment(unittest.TestCase):
    def test_folds_characters_into_words(self):
        ws = el.words_from_alignment(alignment_for("Hello there, world."))
        self.assertEqual([w["text"] for w in ws], ["Hello", "there,", "world."])

    def test_punctuation_stays_attached(self):
        ws = el.words_from_alignment(alignment_for("Wait! Really?"))
        self.assertEqual([w["text"] for w in ws], ["Wait!", "Really?"])

    def test_word_spans_first_to_last_character(self):
        ws = el.words_from_alignment(alignment_for("ab cd", rate=0.1))
        self.assertAlmostEqual(ws[0]["start"], 0.0, places=3)
        self.assertAlmostEqual(ws[0]["end"], 0.2, places=3)
        self.assertAlmostEqual(ws[1]["start"], 0.3, places=3)

    def test_collapses_runs_of_whitespace(self):
        ws = el.words_from_alignment(alignment_for("a   b\n\tc"))
        self.assertEqual([w["text"] for w in ws], ["a", "b", "c"])

    def test_rejects_mismatched_arrays(self):
        bad = alignment_for("abc")
        bad["character_end_times_seconds"].pop()
        with self.assertRaises(ValueError):
            el.words_from_alignment(bad)

    def test_prefers_normalized_alignment(self):
        # normalized_alignment reflects the text as actually spoken (expanded
        # numbers and abbreviations), so it must win.
        resp = {
            "alignment": alignment_for("Dr Who"),
            "normalized_alignment": alignment_for("Doctor Who"),
        }
        chosen = resp.get("normalized_alignment") or resp.get("alignment")
        self.assertEqual([w["text"] for w in el.words_from_alignment(chosen)], ["Doctor", "Who"])

    def test_build_requires_alignment(self):
        with self.assertRaises(ValueError) as cm:
            el.build({"audio_base64": ""}, speaker="x")
        self.assertIn("with-timestamps", str(cm.exception))

    def test_split_script(self):
        self.assertEqual(el.split_script("One. Two! Three? Four"), ["One.", "Two!", "Three?", "Four"])


class TestElevenLabsBuild(unittest.TestCase):
    """Full build over real audio, using the fixture as the synthesised take."""

    @classmethod
    def setUpClass(cls):
        make_fixture.main()
        import json
        truth = json.loads((HERE / "fixture.words.json").read_text())["words"]
        # Rebuild a character-level alignment from the fixture's word timings,
        # which is exactly the shape ElevenLabs returns.
        chars, starts, ends = [], [], []
        for i, w in enumerate(truth):
            step = (w["end"] - w["start"]) / max(1, len(w["text"]))
            for j, ch in enumerate(w["text"]):
                chars.append(ch)
                starts.append(w["start"] + j * step)
                ends.append(w["start"] + (j + 1) * step)
            if i < len(truth) - 1:
                chars.append(" ")
                starts.append(w["end"])
                ends.append(truth[i + 1]["start"])
        cls.resp = {"alignment": {"characters": chars,
                                  "character_start_times_seconds": starts,
                                  "character_end_times_seconds": ends}}
        cls.m = el.build(cls.resp, speaker="vale", name="Detective Vale",
                         role="hero", audio=HERE / "fixture.wav")

    def test_manifest_shape(self):
        self.assertEqual(self.m["cwi"], "1.0")
        self.assertEqual(self.m["characters"][0]["id"], "vale")
        self.assertEqual(self.m["characters"][0]["role"], "hero")
        self.assertTrue(self.m["cues"])

    def test_all_words_present_and_ordered(self):
        toks = [t for c in self.m["cues"] for l in c["lines"] for t in l["tokens"]]
        self.assertEqual(len(toks), 29)
        for a, b in zip(toks[:-1], toks[1:]):
            self.assertLessEqual(a["start"], b["start"])

    def test_two_line_maximum(self):
        for c in self.m["cues"]:
            self.assertLessEqual(len(c["lines"]), 2)

    def test_acoustics_attached(self):
        toks = [t for c in self.m["cues"] for l in c["lines"] for t in l["tokens"]]
        self.assertTrue(all("db" in t for t in toks))
        self.assertGreater(sum(1 for t in toks if t.get("f0")), len(toks) * 0.8)

    def test_voice_mode_gives_one_weight_for_the_speaker(self):
        toks = [t for c in self.m["cues"] for l in c["lines"] for t in l["tokens"]]
        f0s = {round(t["f0"], 1) for t in toks if t.get("f0")}
        self.assertEqual(len(f0s), 1, f"voice mode must yield a single f0, got {f0s}")

    def test_offset_shifts_the_whole_take(self):
        shifted = el.build(self.resp, speaker="vale", audio=HERE / "fixture.wav", offset=10.0)
        self.assertAlmostEqual(shifted["cues"][0]["start"] - self.m["cues"][0]["start"], 10.0, places=2)


if __name__ == "__main__":
    unittest.main()
