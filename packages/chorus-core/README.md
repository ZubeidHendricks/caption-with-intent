# chorus-core

Reference implementation of the [Caption with Intention](https://www.captionwithintention.org/)
design system: palettes, acoustics-to-typography mapping, colour-vision-safe
character assignment, and validation.

**Zero dependencies.** Deliberately — this is the piece that has to survive
being vendored into a Rust compositor, a Swift player or a Skia canvas.

```bash
npm install chorus-core
```

## What it does

```js
import { assignColors, resolveToken, validate } from 'chorus-core';

// Speaker colours, following the spec's hue rules PLUS a colour-vision
// constraint the spec itself lacks. Never pick these by hand.
const { characters, warnings } = assignColors([
  { id: 'vale',  tier: 'main', role: 'hero',    rank: 0 },
  { id: 'kroft', tier: 'main', role: 'villain', rank: 1 },
]);

// Measured acoustics -> type size, weight and width.
resolveToken({ text: 'now', start: 0, end: 0.4, db: 9, f0: 100 });
// { size: 8.8, wght: 739, wdth: ... }
```

## The finding you should know about

The CWI V1.0 palette is **not colour-vision safe**. Under deuteranopia
(~6% of men, a population overlapping the Deaf and hard-of-hearing audience),
Yellow/Green, Green/Orange and Red/Orange all collapse. Give two leads Red and
Orange and an affected viewer cannot tell those characters apart — which
defeats the attribution mechanic rather than merely degrading it. `CI Main Red`
also fails WCAG AA contrast against the caption box at 3.70:1.

`assignColors()` therefore adds a colour-vision-safety search on top of the
spec's rules, drawing only from the spec's own swatches, and **warns rather than
degrading quietly** when no assignment clears the floor. A four-main-character
cast cannot clear it at all.

## Reading the spec

Weight and width describe **whose voice this is**, not how each word was
delivered — see `docs/SPEC-NOTES.md` in the repository. Only type size is
per-word. Computing all three per word renders estimator noise: one evenly-read
sentence from a single synthetic voice measured `wght` 400 to 845 word to word.

## About the design system

This package implements the [Caption with Intention](https://www.captionwithintention.org/)
design system (V1.0, 2025.1), created by FCB Chicago with the Chicago Hearing
Society. **This toolchain is MIT; the design system is not this project's to
license.** Its specification PDF is marked *All Rights Reserved* and the system
is marked ©, despite widespread "open source" framing in press coverage — there
is no licence file or repository anywhere upstream. Seek written clarification
from `requests@captionwithintention.org` before commercial deployment.

Roboto Flex, which the system requires, is separately available under the SIL
Open Font License.
