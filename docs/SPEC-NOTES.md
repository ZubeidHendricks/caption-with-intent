# Implementation notes against CWI V1.0

Every value the Caption with Intention design system fixes is used verbatim. This file records the places where the spec is silent or ambiguous and this implementation had to decide, so the decisions are auditable and overridable. All of them are exposed as `CwiOptions`.

## Values taken verbatim from the spec

| Quantity | Value | Spec |
|---|---|---|
| Main character colours | 6 swatches | 2.1.1 |
| Supporting colours | 12 swatches | 2.1.2 |
| Minor characters | wheel-centre pastels, S 30% / B 90%, 24 hues | 2.1.4 |
| Off-camera | italic/oblique | 2.1.5 |
| Read-ahead text | white, 90% opacity | 2.2.1 |
| Colour flip | on the word's first phoneme | 2.2.2 |
| Word-onset pop | +15% scale | 2.2.3 |
| Typeface | Roboto Flex | 2.3.1 |
| Type size unit | % of frame height | 2.3.4 |
| Baseline size | 5% | 2.3.5 |
| Size range | 3% – 12% | 2.3.6 |
| Neutral pitch band | 160–200 Hz → `wght` 400 | 2.3.8 |
| Voice range cited | 80–250 Hz | 2.3.8 |
| Caption box | 90% black | 2.4.1 |
| Max lines per frame | 2 | 2.4.2 |
| Work area | lower 20%, margins 5 / 2.5 / 5 / 7.5% | 2.4.3 |
| Sound effects | white, in `[ ]`, animated | 2.4.4 |
| Music | white, flanked by ♪, **not** animated | 2.4.5 |
| Editorial exception | animation-only for B&W/period titles | 3.1 |

## Decisions the spec left open

**Volume → dB range.** The spec maps 3–12% of frame height onto a volume axis but never states the dB span, nor what the 5% baseline is anchored to. We anchor `db` to *the speaker's own normal speaking level* (a modal estimator over their per-word levels, `pipeline/acoustics.py:dialogue_reference`), and default to −18 dB reaching the floor and +12 dB reaching the ceiling. Per-speaker anchoring keeps a quiet scene and a loud scene both readable and stops a soft-spoken actor being permanently captioned at 3%.

**Pitch → weight curve.** The spec fixes the 160–200 Hz plateau at 400 and gives a direction, not a function. We interpolate in log-frequency (the perceptually correct domain) from 80 Hz → `wght` 900 down to 400 Hz → `wght` 100, with the specified plateau between. The upper bound is extended past the spec's cited 250 Hz because children's and many women's voices exceed it.

**Harmonics → width.** The spec's own chart is ambiguous here: its axis runs 1000 → 100 against widths 150 → 25, which reads opposite to its prose ("a voice rich in *lower* harmonics feels fuller and warmer, corresponding to a wider typeface"). **We follow the prose**, mapping spectral centroid 500 Hz → `wdth` 151 and 3500 Hz → `wdth` 25, log-interpolated. Flagged for upstream clarification.

**Word spacing — absent entirely.** The spec fixes size, weight and width per word but says nothing about the gap between words, and a variable font's natural space advance is calibrated for regular weight. At `wght` 900 / `wdth` 122 — which the system asks for whenever a low, resonant voice speaks — adjacent words visibly weld together, and obliqued off-camera text is worse because the lean carries the last glyph into the space. `wordGap()` in `@corerus/chorus-core` scales the gap with weight and width, plus 15% when slanted. This is a real omission in V1.0, not a rendering detail.

**Layout must not reflow.** Nothing in the spec addresses the interaction between per-word sizing and the +15% pop. Naively animating `font-size` reflows the whole line on every word. The renderer lays each line out **once** at each word's volume-derived size — so the white read-ahead text already occupies final geometry — and animates the pop with `transform` only.

**Pop duration.** Not specified. Default 180 ms, ease-out-back. Respects `prefers-reduced-motion`.

**Reading rate.** Not constrained by CWI, though conventional caption standards do constrain it. The validator warns above ~240 wpm.

**Cue segmentation and line breaking.** Not specified. We split on speaker change, pauses > 0.7 s and duration > 6 s, and balance the two lines. Conventional practice; all configurable.

**Are weight and width per word, or per voice?** The single most consequential ambiguity in V1.0, and the one that most changes what the system looks like on screen.

Section 2.3 maps volume to size, pitch to weight and harmonics to width, and it is natural to read all three as per-word. Section 2.3.8 does not say that. It talks about *"voices"* — "voices vary greatly in pitch and harmonic structure" — and every worked example contrasts one character against another rather than one word against the next. Volume is unambiguously dynamic ("louder voices and sounds are represented with larger, taller type", and the *Glengarry Glen Ross* example sizes words differently inside one line). Weight and width read as descriptions of *whose voice this is*.

Real audio settles it. Per-word f0 on a short function word ("is", "in", "the") or a spelled letter ("U", "R", "L") comes from a handful of voiced frames and is mostly estimator noise. Mapped onto a 500-unit weight span, one evenly-read sentence from a *single synthetic voice* lurched between `wght` 400 and 845 word to word — measured, not hypothesised. The intonation layer was conveying estimator variance rather than delivery.

So `acoustics.stabilize()` defaults to `mode="voice"`: weight and width identify the character and hold steady across their dialogue, while size still moves per word with volume. `mode="word"` keeps per-word prosody, blended toward the speaker's median by measurement confidence and clamped to ±12%; use it on clean dialogue stems when you want prosody visible. `mode="raw"` is diagnostics only.

**Ordinary prosody is not deliberate volume.** Related, and also measured: word-level loudness in normal speech spans roughly 15 dB from stress alone. Mapped linearly onto the spec's 3–12% range, an evenly-read line pulses distractingly. `sizeFromDb` therefore applies a soft knee — level changes within ±6 dB of the speaker's reference compress into ±0.6% of frame height, and only larger excursions expand toward the floor and ceiling. This keeps the size axis carrying what the spec describes it carrying, a character shouting or whispering, rather than the amplitude dip on an unstressed syllable.

**Cue segmentation, line breaking, and word onsets.** All absent from V1.0. `segment.py` breaks on speaker change, pause, and duration or character budget, preferring sentence then clause boundaries, and refuses to strand an article or preposition at the end of a cue or line — a synthesizer will happily pause between "the" and its noun, and a purely pause-driven segmenter reproduces that as a caption break. Stub cues of one or two words are absorbed into a neighbour. Cue tails are clamped so they never overlap the next cue.

**Spectral centroid, calibrated.** The analyzer measures centroid over *voiced* frames only, deliberately excluding unvoiced consonants so they cannot drag the estimate. That runs well below a full-band speech centroid — a real low male voice measured 695 Hz — so `centroidRange` defaults to `[700, 1700]` rather than the full-band figures a naive reading would suggest. Measured across 17 real voices — synthesised and rendered — whose voiced-frame centroids ran 770–1569 Hz. An earlier `[450, 2000]` guess, taken from one voice, was too wide: every real voice landed mid-axis and the width axis carried almost no information. The calibrated range spends ~80% of the axis on the observed population.

**Emotion is not encoded, and that is the point.** CWI V1.0 carries volume, pitch and harmonics, and nothing that names a feeling. It is tempting to add emotion — conversational-video systems like Tavus's Raven read it from the speaker's face in real time and describe it in natural language — but copying that here would be a mistake for a reason specific to captioning: **a Deaf viewer watching a film can already see the actor's face.** Rendering "angry" in type duplicates what the picture carries perfectly well.

What the picture does not carry is the vocal channel, and the highest-information case is where voice *contradicts* face — sarcasm, suppressed anger, forced cheer, a threat delivered with a smile. That is exactly what is lost without hearing, and exactly what a face-reading model cannot supply.

`pipeline/prosody.py` therefore measures six further acoustic properties per cue — pitch variation, pitch contour, speech rate, harmonics-to-noise ratio, jitter and spectral tilt — and renders none of them. Two of these close real gaps: contour separates a question from a statement, which text cannot do at all ("you're going" / "you're going?"), and HNR separates *quiet because whispering* from *quiet because barely holding together*, which the size axis alone flattens into identical small type.

They stay unrendered deliberately. The CWI team's own account of building V1.0 is that they over-indexed and pulled back — "we learned subtlety prevents captions from becoming distracting" — and adding five more visual channels would repeat a mistake they already made and corrected. Any decision to surface these should be validated with DHH viewers first, as the original system was.

**Writing systems other than English — absent from the spec entirely.** CWI V1.0 is specified, illustrated and validated in English, and three things break on contact with anything else.

*Scripts written without word spaces.* Chinese, Japanese, Thai, Khmer and Lao arrive from any whitespace tokeniser as a single token per phrase — a 30-character Japanese sentence is one "word". The whole line then flips colour at once, which is not a degraded version of word-level synchronisation but its total absence, and synchronisation is the mechanic the design exists for. `pipeline/script.py` re-splits these into per-character reveal units, timed proportionally to display width. The character is what karaoke subtitling has always used as a reveal unit for these scripts.

*Right-to-left scripts.* Arabic, Hebrew, Persian and Urdu tokenise on spaces perfectly well but were laid out left to right, so the reveal ran backwards through the line. The analyzer now detects direction from the dialogue and the renderer sets it on the caption root. Position, being a spatial attribution cue rather than a textual one, deliberately does not mirror.

*Line length in characters.* A CJK character occupies about two Latin character widths and a combining mark none, so a 42-character limit produced Japanese lines roughly twice as wide as intended and Thai lines narrower. Length is now measured in display columns, and line breaking applies kinsoku shori — the rules preventing a line from beginning with closing punctuation or ending with an opening bracket, which read as errors to a native reader rather than merely as odd breaks.

Word gaps are suppressed between two unspaced-script characters. Without that, per-character segmentation renders a Japanese line as spaced-out individual glyphs.

What this does *not* do: correct word segmentation for Thai, Khmer and Lao needs a dictionary, and Japanese needs a morphological analyser. Neither ships here. Reveal units and legal break points are what captions need, and those are handled; where a production needs dictionary-accurate breaks, segment upstream and pass the tokens in.

**Vertical video — the spec assumes a landscape frame without saying so.** Type
size is defined as a percentage of frame *height* (2.3.4), which is the right
invariant for a design that must survive being watched on a phone and in a
cinema. It quietly assumes the frame is wider than it is tall. On a 9:16 video
the height is the long dimension, so the 5% baseline produces type roughly
twice as large relative to the available width, and a two-line cue set `nowrap`
simply runs off the side of the picture.

Since most captioned video today is vertical, this implementation scales an
overflowing cue down by a single factor until it fits the safe area. One factor
for the whole cue, not per word: the volume mapping is *relative* — a shout is
larger than the speech around it — and a uniform scale preserves every one of
those relationships. Re-fitting word by word would flatten exactly the
differences the design exists to show. A cue that already fits is untouched, so
nothing changes for landscape material.

The alternative reading is that type size should be a percentage of the frame's
*smaller* dimension. That is arguably more faithful to the intent and would
change every size on every landscape frame, so it is not what this does.

**Colour-vision safety — a gap, not an ambiguity.** See `ARCHITECTURE.md` §4. The V1.0 palette has pairs that collapse under all three dichromacies, and the spec sets no contrast floor. `assignColors()` adds a CVD-safety constraint on top of the spec's rules, using only the spec's own swatches.

**Colour stability across a series.** Not addressed. A character's colour should be identical in every episode. Pin `characters[].color` in a show-level manifest and reuse it rather than re-running assignment per episode.
