# Render conformance

The vectors in `../vectors` check *computation*: given these acoustics, what
type size. Every one of them can pass while the picture on screen is wrong —
words revealed at the wrong moment, a speaker drawn in another speaker's
colour, a line reflowing under the emphasis pop.

This checks the picture.

It does not require the renderer to be this one, or to be a browser. Your
implementation draws a scene, reports what it drew, and the checker compares
that against what the manifest says it should have drawn:

```
cwi conform-render --report my-report.json --scene dialogue-2speaker
```

With no `--report`, the checker drives the reference web renderer and holds it
to the same bar — which is how it runs in CI here, on every commit.

## Levels

"Conformant" is otherwise unfalsifiable, so there are three.

| | what it covers | why it is the floor it is |
|---|---|---|
| **A** | attribution and word-level synchronisation | the mechanic the whole design exists for; fail it and the captions actively mislead about who spoke |
| **AA** | the acoustics-to-typography mapping, within tolerance | intonation reaches the reader |
| **AAA** | no reflow, line limits, safe area, and a second non-colour attribution channel | the reading experience holds up under real playback and real vision |

Levels are cumulative: AA requires A. A check that cannot be evaluated because
the implementation did not report its inputs is *skipped*, and a skipped check
forfeits its level rather than failing it — an implementation with a static
font is not conformant at AA, but nothing it did was wrong, and it can still
certify at A.

## The checks

| id | level | spec | what it catches |
|---|---|---|---|
| R-A1 | A | 2.2 | the wrong words, or the right words in the wrong order |
| R-A2 | A | 2.2 | a word turning over at the wrong moment |
| R-A3 | A | 2.2 | a line revealed as a block instead of word by word |
| R-A4 | A | 2.1 | dialogue drawn in the wrong speaker's colour |
| R-A5 | A | 2.1 | two speakers reaching the screen indistinguishable |
| R-A6 | A | 2.2 | a reveal that exists in the implementation's state but not in the picture |
| R-B1 | AA | 2.3.4 | type size that ignores loudness |
| R-B2 | AA | 2.3.8 | a weight axis that ignores pitch |
| R-B3 | AA | 2.3.8 | a width axis that ignores timbre |
| R-C1 | AAA | 2.3.7 | an emphasis pop that reflows the line under the reader's eye |
| R-C2 | AAA | 2.4 | more lines on screen than the profile allows |
| R-C3 | AAA | 2.4 | captions running outside the safe area |
| R-C4 | AAA | WCAG 2.2 SC 1.4.1 | a pair of speakers separable only by colour |

Two of these are worth explaining, because they are the ones a careful
implementation still gets wrong.

**R-A6** exists because R-A2 reads a flag. An implementation can track the
playhead perfectly, report every `spoken` correctly, and draw every word
identically — a clean synchronisation report and nothing at all for the reader.
So R-A6 asks whether a spoken word actually *looks* different from one not yet
spoken. Difference in opacity counts; difference only in internal state does
not.

**R-C4** reads position from the caption box you reported and marks from the
`marks` you reported — deliberately not from the manifest. A renderer that
ignores the profile's positions and marks would otherwise be credited with the
attribution channels it dropped. The check is per *pair* of speakers, because
that is how WCAG 1.4.1 is assessed: two speakers sharing a slot with no mark
are separable by colour alone even in a cast where everyone else is fine.

## The report format

```jsonc
{
  "cwiRenderReport": "1.0",
  "implementation": "your-renderer 2.1",
  "scene": "dialogue-2speaker",
  "frame": { "w": 1920, "h": 1080 },
  "samples": [
    {
      "t": 0.6,                          // must match the scene's sample times
      "tokens": [
        {
          "text": "The",
          "spoken": true,                // has the playhead reached this word
          "sizePx": 54.0,                // as rendered, device pixels
          "colour": "rgb(23, 229, 23)",  // #rrggbb, #rgb, rgb() or rgba()
          "wght": 400,                   // omit if you have no variable font
          "wdth": 100,
          "leftPx": 210,                 // LAYOUT position, ignoring transforms
          "topPx": 918
        }
      ],
      "marks": ["●"],               // non-colour speaker marks drawn, if any
      "lineCount": 1,
      "box": { "left": 210, "top": 900, "width": 1400, "height": 70 }
    }
  ]
}
```

Sample at exactly the times the scene lists — `cwi render-scenes` prints them,
and the checker refuses a report that is missing any, rather than quietly
scoring what it has. Render at exactly the scene's frame size: type size is a
percentage of frame height, so a report from a different frame makes every size
check meaningless.

`leftPx` and `topPx` must be **layout** positions, not the bounding box of the
drawn glyphs. The emphasis pop scales a token about its own centre, so a popped
token's drawn rect legitimately moves while its layout box must not — reporting
the drawn rect turns every pop into a false reflow, and reporting a *stale*
layout box hides a real one.

Everything optional is optional in one direction only: omitting it forfeits the
checks that need it. Nothing is inferred from the manifest on your behalf.

## Tolerances

| | tolerance | why |
|---|---|---|
| type size | the greater of 1px and 2% | sub-pixel rounding, hinting and device-pixel-ratio all move this; 2% is far inside the steps of the 3–12% range |
| `wght` | ±10 | renderers quantise weight, and 10 is under one step |
| `wdth` | ±5 | as above |
| colour | ΔE 3 (CIE76) | roughly the just-noticeable difference: inside it is the same colour to a viewer |
| layout drift | 0.5px | anything less is rounding |

## Scenes

`cwi render-scenes` lists them with their sample times. Each is a complete
`.cwi` manifest plus the instants to sample, chosen so that a wrong
implementation is caught rather than merely likely to be caught: the dynamic
range runs from a whisper to a shout, and the multi-speaker scene has a cast
large enough that colour alone cannot separate every pair under dichromacy.

Adding a scene means adding a JSON file here. The checker derives every
expectation from the manifest, so no expected values are written by hand and a
scene cannot disagree with the spec.
