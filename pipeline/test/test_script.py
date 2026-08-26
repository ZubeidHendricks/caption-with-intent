"""
Writing systems other than English.

Everything else in this pipeline assumed English, and three separate things
broke: unspaced scripts collapsed to one token per phrase, right-to-left
scripts were laid out left to right, and line length was counted in characters
when a CJK character is two columns wide.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

import script  # noqa: E402
import segment as seg  # noqa: E402

EN = 'The gate opened from the inside.'
AR = 'البوابة فتحت من الداخل.'
HE = 'השער נפתח מבפנים.'
JA = 'ゲートは内側から開いた。'
ZH = '大门是从里面打开的。'
TH = 'ประตูถูกเปิดจากด้านใน'


class TestDirection(unittest.TestCase):
    def test_detects_rtl_scripts(self):
        self.assertEqual(script.direction(AR), 'rtl')
        self.assertEqual(script.direction(HE), 'rtl')

    def test_detects_ltr_scripts(self):
        for t in (EN, JA, ZH, TH):
            self.assertEqual(script.direction(t), 'ltr', t)

    def test_a_latin_brand_name_does_not_flip_an_arabic_line(self):
        # Direction is decided by the dominant strong-direction characters, not
        # by the presence of any Latin at all.
        self.assertEqual(script.direction('البوابة فتحت Netflix من الداخل.'), 'rtl')

    def test_digits_and_punctuation_are_neutral(self):
        self.assertEqual(script.direction('123 ... !!!'), 'ltr')


class TestDisplayWidth(unittest.TestCase):
    def test_cjk_counts_double(self):
        # Counting characters makes a Japanese line about twice as wide as the
        # limit intends.
        self.assertEqual(script.display_width('大门'), 4)
        self.assertEqual(script.display_width('ab'), 2)

    def test_combining_marks_count_zero(self):
        base = 'e'
        combined = 'é'          # e + combining acute
        self.assertEqual(script.display_width(base), script.display_width(combined))

    def test_thai_marks_do_not_inflate_width(self):
        self.assertLess(script.display_width(TH), len(TH))


class TestSegmentation(unittest.TestCase):
    def test_unspaced_scripts_are_detected(self):
        for t in (JA, ZH, TH):
            self.assertTrue(script.needs_character_segmentation(t), t)
        for t in (EN, AR, HE):
            self.assertFalse(script.needs_character_segmentation(t), t)

    def test_a_japanese_phrase_becomes_many_reveal_units(self):
        # The failure this exists for: whitespace tokenisation gives ONE token
        # for the whole sentence, so the entire line flips colour at once and
        # word-level synchronisation does not exist.
        self.assertEqual(len(JA.split()), 1)
        units = script.retokenize([{'text': JA, 'start': 0.0, 'end': 3.0}])
        self.assertGreaterEqual(len(units), 10)

    def test_reveal_units_are_ordered_and_span_the_original(self):
        units = script.retokenize([{'text': JA, 'start': 1.0, 'end': 4.0}])
        self.assertAlmostEqual(units[0]['start'], 1.0, places=2)
        self.assertAlmostEqual(units[-1]['end'], 4.0, places=2)
        for a, b in zip(units, units[1:]):
            self.assertLessEqual(a['end'], b['start'] + 1e-6)

    def test_spaced_scripts_are_left_alone(self):
        words = [{'text': w, 'start': i, 'end': i + 0.5} for i, w in enumerate(EN.split())]
        self.assertEqual(len(script.retokenize(words)), len(words))

    def test_combining_marks_stay_with_their_base(self):
        # Splitting a Thai vowel from its consonant renders as a broken glyph.
        units = script.retokenize([{'text': TH, 'start': 0, 'end': 2}])
        for u in units:
            self.assertFalse(u['text'][0] and script.grapheme_clusters(u['text'])[1:],
                             f'unit {u["text"]!r} contains more than one cluster')


class TestKinsoku(unittest.TestCase):
    def test_a_line_may_not_begin_with_closing_punctuation(self):
        self.assertFalse(script.can_break_between('た', '。'))
        self.assertFalse(script.can_break_between('a', '、'))

    def test_a_line_may_not_end_with_an_opening_bracket(self):
        self.assertFalse(script.can_break_between('「', 'あ'))

    def test_ordinary_pairs_may_break(self):
        self.assertTrue(script.can_break_between('あ', 'い'))


class TestLineBreaking(unittest.TestCase):
    def wrap(self, text):
        units = script.retokenize([{'text': text, 'start': 0, 'end': 4, 'speaker': 'a'}])
        cues = seg.segment(units)
        return [l for c in cues for l in seg.wrap(c)]

    def test_japanese_wraps_by_display_width(self):
        lines = self.wrap(JA * 3)
        for l in lines:
            self.assertLessEqual(seg._chars(l), seg.MAX_CHARS_PER_LINE + 4,
                                 ''.join(w['text'] for w in l))

    def test_no_orphan_lines(self):
        # Character segmentation fills the budget exactly far more often than
        # word segmentation, so orphans were common before stub absorption.
        for text in (JA * 2, TH * 2):
            for l in self.wrap(text):
                self.assertGreater(seg._chars(l), 3, ''.join(w['text'] for w in l))

    def test_lines_never_start_with_forbidden_punctuation(self):
        for l in self.wrap(JA * 3):
            first = l[0]['text'][0]
            self.assertNotIn(first, '、。，．：；？！',
                             f'line starts with {first!r}')


if __name__ == '__main__':
    unittest.main()
