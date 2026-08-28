"""
Script and writing-system handling.

Everything else in this pipeline quietly assumes English, and three separate
things break on contact with anything else:

  1. Scripts written without word spaces — Japanese, Chinese, Thai, Khmer, Lao
     — collapse to a single whitespace token. A 30-character Japanese sentence
     becomes one "word", so the whole line flips colour at once. That is not a
     degraded version of word-level synchronisation; it is its total absence,
     and synchronisation is the mechanic the design exists for.

  2. Right-to-left scripts — Arabic, Hebrew, Persian, Urdu — tokenise fine but
     are laid out left-to-right, so the reveal runs backwards through the line.

  3. Line length is counted in characters. A CJK character occupies roughly two
     Latin character widths, so a 42-character limit produces lines about twice
     as wide as intended.

A NOTE ON WHAT THIS DOES NOT DO

Correct word segmentation for Thai, Khmer and Lao needs a dictionary; correct
Japanese segmentation needs a morphological analyser. Neither ships here. What
captions actually need is not linguistic words but *reveal units* and *legal
break points*, and for these scripts the character is a defensible reveal unit —
it is what karaoke subtitling has always used. Line breaking applies kinsoku
rules for CJK and is approximate for Thai. Where a production needs
dictionary-accurate breaks, segment upstream and pass the tokens in.
"""
from __future__ import annotations

import unicodedata

# --------------------------------------------------------------------------
# Script detection
# --------------------------------------------------------------------------

_RTL_RANGES = [
    (0x0590, 0x05FF),  # Hebrew
    (0x0600, 0x06FF),  # Arabic
    (0x0700, 0x074F),  # Syriac
    (0x0750, 0x077F),  # Arabic Supplement
    (0x0780, 0x07BF),  # Thaana
    (0x08A0, 0x08FF),  # Arabic Extended-A
    (0xFB1D, 0xFDFF),  # Hebrew/Arabic presentation forms
    (0xFE70, 0xFEFF),  # Arabic presentation forms-B
]

# Scripts that do not put spaces between words.
_UNSPACED_RANGES = [
    (0x2E80, 0x2FFF),  # CJK radicals, Kangxi
    (0x3040, 0x30FF),  # Hiragana, Katakana
    (0x3400, 0x4DBF),  # CJK Extension A
    (0x4E00, 0x9FFF),  # CJK Unified Ideographs
    (0xF900, 0xFAFF),  # CJK Compatibility Ideographs
    (0xAC00, 0xD7AF),  # Hangul syllables (spaced in practice, but breakable)
    (0x0E00, 0x0E7F),  # Thai
    (0x0E80, 0x0EFF),  # Lao
    (0x1780, 0x17FF),  # Khmer
    (0x1000, 0x109F),  # Myanmar
]


def _in(ch: str, ranges) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in ranges)


def is_rtl_char(ch: str) -> bool:
    return _in(ch, _RTL_RANGES)


def is_unspaced_char(ch: str) -> bool:
    return _in(ch, _UNSPACED_RANGES)


def direction(text: str) -> str:
    """
    'rtl' or 'ltr' for a run of text.

    Decided by which strong-direction characters dominate, ignoring digits and
    punctuation, which are direction-neutral and would otherwise let a single
    Latin brand name flip an Arabic line.
    """
    rtl = sum(1 for c in text if is_rtl_char(c))
    ltr = sum(1 for c in text
              if c.isalpha() and not is_rtl_char(c) and not is_unspaced_char(c))
    return 'rtl' if rtl > ltr else 'ltr'


def needs_character_segmentation(text: str) -> bool:
    """True when the text is mostly written without word spaces."""
    letters = [c for c in text if not c.isspace() and not unicodedata.category(c).startswith('P')]
    if not letters:
        return False
    return sum(1 for c in letters if is_unspaced_char(c)) > len(letters) / 2


# --------------------------------------------------------------------------
# Display width
# --------------------------------------------------------------------------

def char_width(ch: str) -> int:
    """
    Display columns for one character: 2 for East Asian Wide and Fullwidth,
    0 for combining marks, 1 otherwise.

    Counting characters instead makes a CJK line about twice as wide as
    intended, because the limit was calibrated on Latin text.
    """
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1


def display_width(text: str) -> int:
    return sum(char_width(c) for c in text)


# --------------------------------------------------------------------------
# Character segmentation with kinsoku
# --------------------------------------------------------------------------

# Kinsoku shori: characters that may not begin a line (they cling to what
# precedes them) and characters that may not end one.
_NO_LINE_START = set('、。，．：；？！ー〜’”）〕］｝〉》」』】,.:;?!%）]}｣､')
_NO_LINE_END = set('（〔［｛〈《「『【([{｢')


def can_break_between(a: str, b: str) -> bool:
    """May a line break fall between these two characters?"""
    if not a or not b:
        return False
    if b in _NO_LINE_START:
        return False
    if a in _NO_LINE_END:
        return False
    return True


def grapheme_clusters(text: str) -> list[str]:
    """
    Split into user-perceived characters.

    A base character plus its combining marks must stay together — splitting a
    Thai vowel from its consonant renders as a visibly broken glyph, not merely
    an odd break.
    """
    out: list[str] = []
    for ch in text:
        if out and unicodedata.combining(ch):
            out[-1] += ch
        else:
            out.append(ch)
    return out


def segment_characters(text: str, start: float, end: float) -> list[dict]:
    """
    Split an unspaced run into per-character reveal units, timed proportionally.

    The character is the reveal unit karaoke subtitling has always used for
    these scripts, and it restores the word-level synchronisation that
    whitespace tokenisation destroys.
    """
    clusters = [c for c in grapheme_clusters(text) if not c.isspace()]
    if not clusters:
        return []
    span = max(end - start, 1e-6)
    widths = [max(display_width(c), 1) for c in clusters]
    total = sum(widths)
    out: list[dict] = []
    cursor = start
    for c, w in zip(clusters, widths):
        dur = span * (w / total)
        out.append({'text': c, 'start': round(cursor, 3), 'end': round(cursor + dur, 3)})
        cursor += dur
    return out


def retokenize(words: list[dict]) -> list[dict]:
    """
    Re-split any token that is really a whole unspaced phrase.

    Applied after alignment, so the timings being subdivided are measured ones
    rather than guesses.
    """
    out: list[dict] = []
    for w in words:
        if needs_character_segmentation(w['text']) and len(w['text'].strip()) > 1:
            for part in segment_characters(w['text'], w['start'], w['end']):
                out.append({**w, **part})
        else:
            out.append(w)
    return out
