"""
Group a word stream into caption cues, and break each cue into lines.

CWI V1.0 specifies at most two lines per frame (2.4.2) and the work area they
sit in (2.4.3), but says nothing about where cues should start and end. That is
left to ordinary caption practice, which is what this module encodes — and with
CWI it matters more than usual, because the caption box hugs the text, so a
ragged break is far more visible than it is behind a fixed-width band.

The priority order when choosing where to break:
  1. a real pause in the audio
  2. a sentence end  (. ! ?)
  3. a clause end    (, ; : —)
  4. wherever the duration or character budget runs out
"""
from __future__ import annotations

import re

import script

MAX_GAP_S = 0.70
MAX_CUE_S = 6.0
MAX_CHARS_PER_LINE = 42
MAX_LINES = 2

_SENTENCE_END = re.compile(r"[.!?]['\")\]]*$")
_CLAUSE_END = re.compile(r"[,;:—–]['\")\]]*$")

# Words that should not be left dangling at the end of a cue or a line. A
# synthesizer will happily pause between "the" and the noun it introduces, and
# a purely pause-driven segmenter will faithfully reproduce that as a caption
# break — which reads as an error even though the audio really did pause there.
_STICKY = frozenset("""
a an the this that these those my your his her its our their
of to in on at by for with from into onto upon as
and or but nor so yet
is are was were be been being am
no not
""".split())


def _is_sticky(word: dict) -> bool:
    bare = re.sub(r"[^\w']", "", word["text"]).lower()
    return bare in _STICKY and not _CLAUSE_END.search(word["text"]) \
        and not _SENTENCE_END.search(word["text"])


def _chars(words: list[dict]) -> int:
    """
    Line length in display columns, not characters.

    A CJK character occupies about two Latin character widths, and combining
    marks occupy none, so counting characters makes a Japanese line roughly
    twice as wide as the limit intends and a Thai line narrower.
    """
    if not words:
        return 0
    return sum(script.display_width(w["text"]) + 1 for w in words) - 1


def segment(
    words: list[dict],
    max_gap: float = MAX_GAP_S,
    max_dur: float = MAX_CUE_S,
    max_chars: int = MAX_CHARS_PER_LINE,
    max_lines: int = MAX_LINES,
) -> list[list[dict]]:
    """
    Split `words` into cues. Words must be time-ordered and carry `speaker`.

    A cue is closed when the speaker changes, the audio pauses, or the duration
    or character budget is spent. When the budget forces a break we look back
    for the most recent sentence or clause end rather than cutting mid-phrase.
    """
    if not words:
        return []

    budget = max_chars * max_lines
    cues: list[list[dict]] = []
    cur: list[dict] = [words[0]]

    for w in words[1:]:
        # An early sentence end below closes the cue and leaves `cur` empty.
        # Every test on hand ended a line at the last word, so the loop never
        # came round again on an empty cue and this read `cur[-1]` of nothing.
        if not cur:
            cur = [w]
            continue
        prev = cur[-1]
        speaker_changed = w.get("speaker") != prev.get("speaker")
        paused = w["start"] - prev["end"] > max_gap
        too_long = w["end"] - cur[0]["start"] > max_dur
        too_wide = _chars(cur + [w]) > budget

        if speaker_changed or (paused and not _is_sticky(prev)):
            cues.append(cur)
            cur = [w]
            continue

        if too_long or too_wide:
            # Back off to the last sentence end, else the last clause end,
            # provided it does not leave a stub of a cue behind.
            split = len(cur)
            for cutoff, pattern in ((0.35, _SENTENCE_END), (0.35, _CLAUSE_END)):
                found = next(
                    (i + 1 for i in range(len(cur) - 1, -1, -1)
                     if pattern.search(cur[i]["text"]) and (i + 1) >= len(cur) * cutoff),
                    None,
                )
                if found and found < len(cur):
                    split = found
                    break
            cues.append(cur[:split])
            cur = cur[split:] + [w]
            continue

        cur.append(w)

        # An early sentence end is a good place to stop even with budget left,
        # as long as the cue is already substantial.
        if _SENTENCE_END.search(w["text"]) and _chars(cur) > budget * 0.55:
            cues.append(cur)
            cur = []

    if cur:
        cues.append(cur)
    return _absorb_stubs([c for c in cues if c], max_dur, max_chars * max_lines)


def _absorb_stubs(cues: list[list[dict]], max_dur: float, budget: int,
                  stub_chars: int = 14) -> list[list[dict]]:
    """
    Fold one- or two-word leftovers back into a neighbour.

    A budget-forced break can strand a tail like "did." on its own. A cue that
    short flashes past before it can be read, and under CWI the box shrinks to
    fit it, so it reads as a glitch rather than a caption. Merge it wherever it
    still fits; leave it alone when merging would overrun the budget, since an
    over-long cue is the worse failure.
    """
    out: list[list[dict]] = []
    for cue in cues:
        is_stub = len(cue) <= 2 and _chars(cue) <= stub_chars
        if is_stub and out:
            prev = out[-1]
            same_speaker = prev[-1].get("speaker") == cue[0].get("speaker")
            merged_dur = cue[-1]["end"] - prev[0]["start"]
            # Allow a little overflow rather than leaving an orphan. Character
            # segmentation fills the budget exactly far more often than word
            # segmentation does, and a slightly long line reads better than a
            # line of two characters on its own.
            if same_speaker and merged_dur <= max_dur * 1.15 and _chars(prev + cue) <= budget * 1.15:
                out[-1] = prev + cue
                continue
        out.append(cue)
    return out


def wrap(words: list[dict], max_chars: int = MAX_CHARS_PER_LINE,
         max_lines: int = MAX_LINES) -> list[list[dict]]:
    """
    Break one cue into at most `max_lines` balanced lines.

    Balanced lines read faster than a long line over a stub, and a clause
    boundary is a better break than pure balance — so a candidate near a comma
    wins over one a couple of characters closer to the midpoint.
    """
    total = _chars(words)
    if total <= max_chars or len(words) < 2 or max_lines < 2:
        return [words]

    target = total / 2
    best_i, best_cost = 1, float("inf")
    for i in range(1, len(words)):
        # Kinsoku shori: some characters may not begin or end a line. Breaking
        # there is not merely ugly — it reads as an error to a native reader.
        prev_text, next_text = words[i - 1]["text"], words[i]["text"]
        if not script.can_break_between(prev_text[-1:], next_text[:1]):
            continue
        left = _chars(words[:i])
        cost = abs(left - target)
        if _CLAUSE_END.search(words[i - 1]["text"]):
            cost *= 0.6      # prefer breaking after a clause
        if _is_sticky(words[i - 1]):
            cost *= 2.2      # never strand an article or preposition at line end
        if cost < best_cost:
            best_i, best_cost = i, cost
    return [words[:best_i], words[best_i:]]


def cue_bounds(cues: list[list[dict]], tail: float = 0.30,
               min_gap: float = 0.04) -> list[tuple[float, float]]:
    """
    Start/end times for each cue, holding the last word on screen for `tail`
    seconds but never running into the next cue.

    Without the clamp a fixed tail overlaps the following cue whenever speech
    resumes quickly. The renderer would show both at once and the validator
    would flag it — technically legal, since simultaneous speakers are a real
    case, but here it is just an artefact of the tail.
    """
    out: list[tuple[float, float]] = []
    for i, cue in enumerate(cues):
        start = cue[0]["start"]
        end = cue[-1]["end"] + tail
        if i + 1 < len(cues):
            end = min(end, cues[i + 1][0]["start"] - min_gap)
        out.append((round(start, 3), round(max(end, cue[-1]["end"]), 3)))
    return out
