# Caption with Intention — conformance suite

Language-agnostic test vectors for implementations of the CWI design system.

The point of this repository is that **the format is the product**: a platform
should be able to write its own renderer against a spec whose semantics are
pinned down, and prove it got them right. That is what these vectors are for.
They are plain JSON, so an implementation in Rust, Swift, Kotlin or a shader
language can consume them without running any JavaScript.

## Normative and informative

Every vector declares which it is, and the distinction is the whole point.

**`"normative": true`** — the expected value is fixed by *Caption with Intention,
Design System and Caption Guidelines V1.0 (2025.1)* and cited by section. An
implementation that disagrees is wrong. Examples: normal speech is 5% of frame
height (2.3.5); the size range is 3–12% (2.3.6); 160–200 Hz is Roboto Regular
400 (2.3.8); at most two lines per frame (2.4.2); music descriptors do not
animate (2.4.5).

**`"normative": false`** — the spec is silent and this is *this implementation's*
choice. An implementation may differ and still be conformant. These exist so
differences are discovered deliberately rather than by accident, and so anyone
diverging knows exactly what they are diverging from. Examples: the dB span the
size range maps onto, the shape of the pitch→weight curve between the fixed
points, word spacing, pop duration.

Generating expectations from a reference implementation and calling them
normative would prove only that the implementation agrees with itself. Where
this suite claims *normative*, the number is in the PDF.

## Running

Against the reference implementation:

```bash
chorus conform
```

Against your own JavaScript implementation — a module exporting `resolveToken`,
`assignColors` and `validate`:

```bash
chorus conform --impl ./my-implementation.js
```

For a non-JavaScript implementation, read `index.json`, execute each case, and
compare. The `tolerance` field on numeric expectations is the maximum permitted
absolute difference; anything tighter is a pass.

## Layout

```
index.json          suite metadata and the vector list
vectors/*.json      the vectors, grouped by area
```

Each vector file:

```jsonc
{
  "id": "size-baseline",
  "area": "typography",
  "spec": "2.3.5",
  "normative": true,
  "title": "Normal speech renders at the baseline size",
  "why": "...",              // what breaks for a viewer if this is wrong
  "fn": "resolveToken",      // which entry point the cases exercise
  "cases": [
    { "input": { "db": 0 }, "expect": { "size": 5 }, "tolerance": 0.001 }
  ]
}
```
