# What is ours, and what is not

This project began as a toolchain for someone else's design system and has
grown past it. That is worth being precise about, because the answer differs
part by part and the distinction is not merely legal — it decides what we can
name, change, publish and build a business on.

**This is not legal advice.** It is an accurate description of what was written
here and what was not. Confirm anything that matters with a lawyer.

## The line that matters

Copyright protects **expression**, not **ideas, methods or facts**. Mapping
loudness onto type size is an idea; nobody owns it. A specific document, a
specific set of hex values and a specific name are expression, and those belong
to whoever wrote them.

That line is why the position below holds.

## Fully ours

Every line of code in this repository, MIT licensed:

- `cwi-core` — the acoustics-to-typography mapping as *implemented*, the
  colour-vision-safe assignment search, validation
- `cwi-web` — the renderer, including the no-reflow layout approach and the
  time-derived pop
- `cwi-cli`, `cwi-mcp` — the toolchain and the agent interface
- `pipeline/` — the DSP: the YIN implementation, alignment, segmentation,
  prosody, the provider adapters
- The **`.cwi` interchange format** and its schema
- The **conformance suite** and the mutants that test it
- The **audit engine** and its mapping of caption defects onto WCAG 2.2,
  EN 301 549 and FCC 47 CFR 79.1

And the findings, which are original work:

- The V1.0 palette is not colour-vision safe: Red/Orange, Yellow/Green and
  Green/Orange collapse under deuteranopia, and CI Main Red fails WCAG AA
  contrast on the caption box
- A multi-speaker CWI track fails **WCAG 2.2 SC 1.4.1** (Use of Color, Level A),
  a criterion conventional captioning satisfies with speaker labels
- Weight and width describe *whose voice this is*, not how each word was
  delivered — measured, not inferred, from a single synthetic voice reading one
  sentence at `wght` 400 to 845 word to word
- Ordinary prosody spans ~15 dB and must be compressed, or an evenly-read line
  pulses
- The word-gap rule, absent from the spec entirely
- The prosody measurement layer, and the argument for measuring rather than
  inferring emotion

## Not ours

**Caption with Intention V1.0 (2025.1)** — the design system by FCB Chicago with
the Chicago Hearing Society. Specifically: the published document, the palette
hex values, the fixed numbers (5% baseline, 3–12% range, 160–200 Hz to weight
400, 15% pop, 90% box, two-line maximum), and the name.

Its PDF is marked *All Rights Reserved* on every page, despite widespread "open
source" framing in press coverage. There is no licence file or repository
upstream. **The PDF is deliberately excluded from this repository** — see
`.gitignore` — because redistributing it is not ours to do.

Roboto Flex is separately available under the SIL Open Font License.

## How the code keeps them separate

Profiles. `packages/cwi-core/src/profiles.ts` holds two:

**`cwi-1.0`** reproduces the published design faithfully, defects included,
because a profile claiming to be that spec must be it. Use it to author
CWI-conformant material, or to check something against the published design.

**`chorus-1.0`** is ours. It keeps the idea worth keeping — derive typography from
*measured acoustics* rather than inferred emotion, which is what makes any of
this automatable — and fixes the two defects the audit found:

| | `cwi-1.0` | `chorus-1.0` |
|---|---|---|
| worst-case ΔE, 4 speakers | 11.8 | **43.6** |
| worst-case ΔE, 6 speakers | 6.0 | **33.9** |
| colours below WCAG AA contrast | 1 | **0** |
| attribution channels | colour | colour + position + mark |
| WCAG 1.4.1, multi-speaker | **fails** | **passes** |

The `chorus-1.0` palette was **derived, not adapted**: an optimisation
maximising the smallest pairwise perceptual distance across normal vision and
all three dichromacies at once, under a WCAG AA contrast constraint. The
derivation is `scripts/derive-palette.mjs` and is reproducible. None of its
values appear in the CWI document.

Speaker identity is carried by horizontal position as well as colour, escalating
to a per-character mark once a cast outgrows the three positions — because
WCAG 1.4.1 is assessed per *pair*, and two speakers sharing a slot still rely on
colour alone.

## What this means practically

Ship `chorus-1.0` and nothing in the delivery derives from the CWI document: not
the palette, not the attribution scheme, not the name. The numbers it shares
with V1.0 — a 5% baseline, a 3–12% range — are functional parameters, and a
successor design is free to keep, retune or replace them.

Keep `cwi-1.0` supported anyway. Interoperating with the published design is
worth more than avoiding it, and being the toolchain that implements *both*
faithfully is a stronger position than implementing only one.

Before commercially deploying anything that presents itself as Caption with
Intention, or that redistributes the V1.0 palette, get written clarification
from `requests@captionwithintention.org`. Shipping `chorus-1.0` does not require
that conversation. Shipping `cwi-1.0` may.

## Naming

The design is called **Chorus**. A chorus is many voices that stay individually
distinguishable — precisely the property this adds over V1.0, where attribution
rests on a single channel and collapses whenever that channel fails.

The identifier lives in one object in `profiles.ts`, so changing it later is a
one-line edit plus its references in the docs.

If the project is ever rebranded around it, these npm names were free at the
time of writing: `chorus-captions`, `choruscaptions`, `@chorus/core`,
`chorus-core`, `chorus-web`, `chorus-mcp`. Both `chorus` and `chorus-cli` are
taken. The packages currently ship as `cwi-*`, which describes what they
implement rather than which design they prefer — defensible either way, and
worth keeping while `cwi-1.0` is a supported profile.
