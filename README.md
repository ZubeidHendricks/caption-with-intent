# caption-with-intent

An open toolchain for the [Caption with Intention](https://www.captionwithintention.org/) design system — the caption format FCB Chicago built with the Chicago Hearing Society to give Deaf and Hard of Hearing audiences speaker attribution, word-level synchronization, and vocal intonation.

CWI V1.0 ships as a PDF, an After Effects template, and a font. This repo adds the parts needed to run it at scale: **an interchange format, a reference implementation of the spec's math, a web renderer, and an analyzer that derives the whole thing from audio.**

Read `RESEARCH.md` for what the system is, `ARCHITECTURE.md` for how to automate and distribute it, `docs/SPEC-NOTES.md` for every place this implementation had to decide something the spec left open, and **`docs/OWNERSHIP.md`** for what in here is ours and what is not.

## Two designs

The toolchain implements caption *profiles*, and ships two.

**`cwi-1.0`** reproduces Caption with Intention V1.0 faithfully — including two
accessibility defects this project found in it.

**`chorus-1.0`** is this project's own design — *Chorus*, because a chorus is
many voices that stay individually distinguishable, which is exactly what it
adds. It keeps the idea worth keeping, deriving typography from measured
acoustics rather than inferred emotion, and fixes both defects:

| | `cwi-1.0` | `chorus-1.0` |
|---|---|---|
| worst-case ΔE, 4 speakers | 11.8 | **43.6** |
| worst-case ΔE, 6 speakers | 6.0 | **33.9** |
| colours below WCAG AA contrast | 1 | **0** |
| attribution | colour only | colour + position + mark |
| WCAG 1.4.1, multi-speaker | **fails** | **passes** |

The `chorus-1.0` palette was derived by optimisation, not adapted — maximising the
smallest pairwise perceptual distance across normal vision and all three
dichromacies at once, under a contrast constraint. See
`scripts/derive-palette.mjs`.

```jsonc
{ "cwi": "1.0", "profile": "chorus-1.0", ... }
```

## Layout

```
spec/cwi-manifest.schema.json   the .cwi interchange format
conformance/                    language-agnostic vectors + mutants that test them
  render/                       scenes + the report contract for renderers
packages/core                   @corerus/chorus-core — spec math: palettes, acoustics→type, assignment (0 deps)
packages/web                    @corerus/chorus-web — DOM + variable-font renderer, drives off any <video>
packages/cli                    @corerus/chorus-cli — the `chorus` command + shared operations layer
packages/mcp                    @corerus/chorus-mcp — MCP server, the same operations for agents
pipeline/                       media → .cwi  (numpy DSP, no models required)
  acoustics.py                    per-word loudness, pitch, spectral centroid
  align.py                        known text → word onsets on clean speech
  script.py                       writing systems: RTL, unspaced scripts, widths
  segment.py                      cue segmentation and line breaking
  analyze.py                      recorded film: media + transcript → manifest
  build_scene.py                  merge single-speaker renders onto one timeline
  compose_scene.py                composite them into ONE frame, all speakers visible
  adapters/heygen.py              HeyGen render + SRT → manifest
  adapters/elevenlabs.py          with-timestamps response → manifest
apps/demo                       live renderer with CVD simulation and a validation panel
```

## Install

The packages are published unscoped:

| Package | What it is |
|---|---|
| [`@corerus/chorus-core`](packages/core) | Spec math: palettes, acoustics→type, assignment, validation. Zero deps. |
| [`@corerus/chorus-web`](packages/web) | DOM + variable-font renderer |
| [`@corerus/chorus-cli`](packages/cli) | The `chorus` command |
| [`@corerus/chorus-mcp`](packages/mcp) | MCP server, for agents |

```bash
npm install -g @corerus/chorus-cli      # the toolchain, as `chorus`
npm install @corerus/chorus-core @corerus/chorus-web    # to build against
```

Requirements vary by command — run `chorus doctor` to see what this machine has:

| Command | Needs |
|---|---|
| everything else | Node 18+ |
| `analyze`, `scene` | Python 3 with numpy, and ffmpeg on PATH |
| `render`, `deliver` | ffmpeg, plus **Node 20+** and a headless browser (`playwright-core`) |

The Python pipeline ships inside `@corerus/chorus-cli`; set `CWI_PYTHON` to choose an
interpreter. Playwright enforces its Node 20 floor by exiting the process rather
than throwing, so the browser-backed commands check the version before importing
it and report a clear message on Node 18.

`render` and `preview` fetch Roboto Flex from Google Fonts and **refuse to draw
in a substitute face** — the variable axes carry the intonation layer, so a
fallback silently discards half the design. That makes a slow font fetch a
failed render rather than a degraded one, so the wait is 45 seconds and
`CWI_FONT_TIMEOUT_MS` overrides it. Self-host the font for anything running
unattended.

## Working on this repo

```bash
npm install
npm run setup:py       # venv + numpy for the pipeline
npm run build
```

### Make an app

```bash
npx @corerus/chorus-cli init my-captions     # scaffold a runnable Vite app
cd my-captions && npm install && npm run dev
```

### Ship it

No caption decoder anywhere can render CWI — not WebVTT, SRT, CEA-608/708 or
IMSC1/TTML2, and no platform's caption engine including YouTube's. Spec 3.2 says
so and prescribes burned-in open captions until decoders catch up. So delivery
means burning the captions into the picture:

```bash
chorus deliver captions.cwi.json --video scene.mp4 --target youtube --out ./upload
```

That produces a directory with three things:

```
upload/video.mp4       captions burned in, encoded for the target
upload/captions.vtt    the conventional sidecar — ship this too
upload/DELIVERY.txt    what to do with them
```

**Both files matter.** Closed captioning is legally mandated (FCC/CVAA in the
US, the European Accessibility Act since June 2025) and spec 3.4 is explicit
that CWI is *additive* — "in addition to the regulated and mandated use of the
Closed Captions system". The sidecar is also what makes dialogue searchable and
translatable. Ship only the burned video and you have an illegal file; ship only
the sidecar and you have lost the design.

Targets: `youtube`, `web`, `cinema` (a DCP source master — see
`chorus targets`). Encoding presets are listed by `chorus presets`.

The captions are captured offscreen from the same renderer the preview uses, so
a burned-in master and the preview agree frame for frame. Rendering needs
ffmpeg and a headless browser (`npm i playwright-core`), and it is slow — it
captures every frame where a caption is on screen.

### Or just look at a manifest

```bash
npx @corerus/chorus-cli preview captions.cwi.json --video scene.mp4
```

`preview` needs no scaffolding and no build step. It serves a player with the
cast list, live validation, and a colour-vision simulator, using the packages'
own ESM over an import map — so what you preview is the published renderer,
not a copy of it.

### The command

```
chorus doctor                          check what is available on this machine
chorus init [dir]                      scaffold a runnable app
chorus preview <manifest> [--video f]  open a player for any manifest
chorus deliver <manifest> --target youtube
                                    burned video + sidecar, ready to upload
chorus render <manifest> --video f     just burn captions into the video
chorus targets / chorus presets           delivery targets and encoding presets
chorus analyze <media> --vtt f         media + captions -> manifest
chorus scene <spec.json> --out f       multi-speaker scene from provider renders
chorus assign <manifest>               assign character colours (CVD-safe)
chorus validate <manifest>             structural + accessibility audit
chorus audit <manifest> --out r.html   compliance report (WCAG / EN 301 549 / FCC)
chorus study <a> <b> --video f         A/B attribution study with viewers
chorus study-report <results.jsonl>    accuracy per design, with intervals
chorus stats <manifest>                per-character screen time
chorus export <manifest> --format vtt  emit a delivery format (vtt | ass)
chorus conform [--impl f]              run the conformance suite
chorus palette                         audit the spec's own palette
chorus type --db 6 --f0 110            what typography an acoustic reading yields
```

Every command takes `--json` for machine-readable output. `validate` exits
non-zero on errors, so it drops straight into CI.

### For agents — MCP

The same operations are exposed over MCP, so an agent gets identical behaviour
to a person. `.mcp.json` in the repo root registers it; or:

```bash
claude mcp add chorus -- node "$PWD/packages/mcp/dist/server.js"
```

Sixteen tools: `cwi_validate`, `cwi_assign_colors`, `cwi_stats`,
`cwi_palette_audit`, `cwi_resolve_typography`, `cwi_export`, `cwi_analyze`,
`cwi_build_scene`, `cwi_render`, `cwi_deliver`, `cwi_conform`,
`cwi_conform_render`, `cwi_audit`, `cwi_init_app`, `cwi_preview`,
`cwi_preview_stop`.
Each returns a one-line summary plus structured JSON, and lossy exports report
what they dropped rather than pretending to be complete.

### The reference demo

```bash
npm run dev            # http://localhost:5178
```

Analyze a clip you already have word timings for:

```bash
./.venv/bin/python pipeline/analyze.py --media clip.mp4 --transcript words.json --out clip.cwi.json
node packages/cli/dist/cli.js assign   clip.cwi.json
node packages/cli/dist/cli.js validate clip.cwi.json
```

Or start from a caption file (word timings are approximated — see `transcript.py`):

```bash
./.venv/bin/python pipeline/analyze.py --media clip.mp4 --vtt captions.vtt --out clip.cwi.json
```

Full ASR + diarization needs `pip install whisperx`:

```bash
./.venv/bin/python pipeline/analyze.py --media clip.mp4 --whisperx --hf-token $HF_TOKEN --out clip.cwi.json
```

### Synthetic speech — the easy path

When a machine generated the speech, most of the pipeline collapses: you already know the text and the speaker, and the audio is clean and isolated.

```bash
# HeyGen: signed URLs from the API or MCP tools, or local files
./.venv/bin/python pipeline/from_provider.py heygen \
    --video render.mp4 --srt render.srt \
    --speaker kroft --name "Kroft" --out kroft.cwi.json

# one render is one speaker; merge them onto a shared timeline
./.venv/bin/python pipeline/from_provider.py merge \
    vale.cwi.json kroft.cwi.json --offsets 0 12.4 --out scene.cwi.json
```

ElevenLabs returns character-level alignment, so onsets are exact and no estimation is involved at all — see `pipeline/adapters/elevenlabs.py`.

## Audit the spec's palette

```bash
node packages/cli/dist/cli.js palette
```

```
normal        all pairs distinguishable
protanopia    Yellow/Green ΔE6.0
deuteranopia  Yellow/Green ΔE18.0  Green/Orange ΔE10.7  Red/Orange ΔE14.1
tritanopia    Green/Blue ΔE11.8
```

CWI V1.0 tells speakers apart by hue alone. Give two leads Red and Orange and a deuteranopic viewer cannot tell them apart — which defeats the attribution mechanic rather than merely degrading it. `chorus assign` avoids colliding pairs by default while drawing only from the spec's own swatches. Toggle it in the demo to watch the difference.

## Regenerating the demo media

Two things are deliberately **not** in this repository:

- **`Caption-With-Intention_Design-System_V1.0.pdf`** — the upstream spec, marked
  *All Rights Reserved* on every page. It is not ours to redistribute. Download
  it from [captionwithintention.org](https://www.captionwithintention.org/).
- **`apps/demo/public/heygen.mp4`** — a personal HeyGen render. The demo's
  "HeyGen render" source will show captions without picture until you supply
  your own; the console says so rather than showing an unexplained black frame.

The synthetic scene regenerates from source:

```bash
npm run sample -w @corerus/chorus-demo     # rebuilds sample.cwi.json
```

`scene.mp4` and `control-room.mp4` are small enough to be committed, so the
demo runs from a clean clone.

## Validating with viewers

Every design decision here traces to the spec, to a measurement, or to an
argument. **None of it has been in front of Deaf or hard of hearing viewers**,
which is the real ceiling on all of it — and it is how V1.0 was validated, with
community sessions and per-variant voting, which is why V1.0 is as restrained as
it is.

```bash
chorus study control-room.cwi.json chorus-room.cwi.json --video scene.mp4
chorus study-report study-results.jsonl
```

The central claim of caption attribution is objectively testable: shown a line,
can a viewer say who spoke it? That has a right answer, so accuracy is a number
rather than an opinion. Participants see the same dialogue under each design and
name the speaker.

```
  variant          trials  accuracy        95% CI        median
  chorus-1.0          98    92.9%    86–96  %    1645ms
  cwi-1.0             98    71.4%    62–79  %    2058ms
```

What the harness does to stay honest:

- **The answer key never leaves the server.** A participant cannot read it out
  of the page, and neither can a developer.
- **No feedback after a trial** — telling someone they were right teaches them
  the cast and inflates every later answer.
- **Trial order is per-participant and interleaved**, not blocked, so fatigue
  and learning do not land on whichever design came last.
- **Wilson intervals**, because the normal approximation produces nonsense at
  the sample sizes a caption study actually reaches.
- **It refuses to call a winner** below about a dozen participants, and says so
  rather than printing a comparison that looks conclusive.
- Response time is recorded: a design read accurately but slowly is not
  equivalent to one read accurately and immediately.

The instrument needs no audio and is fully keyboard operable, because its
participants are the people it is asking about.

## Auditing a title

`validate` asks whether a manifest is well-formed. `audit` asks a different
question: against the criteria a broadcaster is actually held to, what is wrong
with this caption track and what should be done about it.

```bash
chorus audit captions.cwi.json --duration 1847 --out report.html
```

It checks **WCAG 2.2**, **EN 301 549** (the standard the European Accessibility
Act references), **FCC 47 CFR 79.1** caption-quality rules, and CWI V1.0 itself.
The report is dated, identified by the SHA-256 of the exact manifest audited,
and self-contained — no fonts, no scripts, no network — because compliance
artifacts get archived and opened years later. It exits non-zero on failures, so
it drops into CI.

### The finding that matters

**A CWI track with more than one speaker fails WCAG 2.2 SC 1.4.1 (Use of Color,
Level A).** The criterion is that colour must not be *the only* visual means of
distinguishing an element. CWI attributes speakers by hue (2.1) and defines no
non-colour cue for identity, so the base design cannot satisfy it.

Conventional captioning *does* satisfy it — a speaker label, or `>>` on a
speaker change, carries identity without colour. So this is a regression against
ordinary practice on this specific point, not merely a gap in a new system. It
compounds the colour-vision problem: the palette has pairs that collapse under
common dichromacies, and there is no second channel to fall back on.

The audit names remediations in order of how little they disturb the design:
place each speaker's captions consistently left/centre/right; prefix a label on
speaker change; give each character a small persistent glyph. Off-camera italics
(2.1.5) is a non-colour cue but marks *where* a voice is, not *whose* it is.

### What it will not do

It will not tell you that you are compliant, and says so on every rendering.
Accuracy against the spoken audio, and whether captions obscure important
picture, are not decidable from a manifest — those criteria are reported as
**needs review** rather than quietly passing. A green report that hid an
unanswerable question would be worse than no report.

## Whether to trust the analysis of a given film

Everything in the pipeline was validated on synthesised speech: harmonic stacks
at known pitch, isolated, silent between words, with exact ground truth. That
is the right way to test a mapping and it says nothing about a real soundtrack,
where dialogue arrives under a score, cut with effects, compressed by a
broadcast chain and overlapped by a second actor.

There is no ground truth for a real film, so this does not score accuracy. It
checks whether the conditions the mapping *assumes* actually hold:

```bash
chorus evaluate film.mp4 film.cwi.json
```

```
  2/6 dialogue cues trustworthy (33%) · 15.2s · 82% speech
  type size spans 5.33% of frame height

  ! 4 of 6 dialogue cues fail an acoustic assumption. This is a mixed
    soundtrack, not a dialogue stem. Analyse the stem if you have one; the
    typography here is partly describing music.

  least trustworthy cues
  0.25 0.5s MID        You said the yard was empty
         only 0% voiced — pitch and weight are guesses
         only 1.1 dB above the surrounding mix — level reflects the bed
         aperiodic (0.76) — f0 unreliable here
```

It exits non-zero when most cues are untrustworthy, so it belongs in a pipeline
step rather than in a warning nobody reads.

What it checks, and why each one matters:

| assumption | what breaks it | consequence if unchecked |
|---|---|---|
| the window is voiced speech | a scored scene | size and weight describe the composer's work |
| there is dynamic range to map | broadcast compression | every word renders the same size; the layer conveys nothing |
| pitch clusters within a voice | octave errors, music | one character's weight moves at random |
| one speaker at a time | overlapping dialogue | both readings describe the sum of two people |
| cues are readable | over-dense subtitling | flagged, but does not reduce trust — a caption defect, not a measurement one |

**A detector only ever run on clean input is not a detector**, so the tests take
the clean fixture and break one assumption at a time in the way a real mix
breaks it — a music bed under the dialogue, a flattened dynamic range, an
octave error in half of one speaker's lines, a genuine overlap — and assert
that the harness names the one that broke and stays quiet otherwise.

This does not make the pipeline work on a real film. It makes the pipeline
*say* when it doesn't.

### The first real film

Run against four minutes of *Night of the Living Dead* (1968, public domain),
with no transcript, so cues were segmented from voicing alone. The first thing
it reported was that it could not be trusted:

```
! Cues were segmented from the audio because no manifest was given, so these
  are windows of voiced audio rather than utterances.
! 88% of the runtime landed inside a provisional cue. Voicing detection is
  bracketing music and effects as speech, so the per-cue numbers describe the
  segmenter as much as the film.
! No usable floor between the cues, so the signal-to-mix check was skipped
  rather than guessed.
```

That is the harness working. An earlier version returned a confident
"unreliable — most cues violate the assumptions", which was a statement about
its own segmentation, not about the film: it had merged a full minute into one
"utterance" and computed *negative* signal-to-noise, which is impossible unless
the floor estimate has nothing to stand on. Both are guarded now.

What survives without a transcript is the dynamic-range question, which needs no
cues at all:

| | *Night of the Living Dead* | synthetic fixture |
|---|---|---|
| middle 90% of voiced speech | **2.06%** of frame height | 7.26% |
| full range including tails | 3.00–8.34% | 3.00–10.26% |
| median aperiodicity, voiced | 0.203 | 0.003 |

So on real material, ordinary dialogue moves within about **two percent of
frame height** — roughly 4% to 6% — and the spec's 3–12% range is reached only
by the extreme tails. The synthetic fixture exercises three times that spread,
which is precisely why it never raised the question.

Whether a 2% swing is perceptible to a viewer is not something this repo can
answer by measurement; it is what the DHH study is for. **One four-minute
segment of one 1968 mono film with an optical soundtrack is not evidence about
cinema in general** — that format is narrow by construction, and a modern
mix would differ. It is one real data point where there were none.


## Switching subtitle language while you watch

Loudness, pitch and timbre are properties of the actor's performance. Who spoke
is a property of the scene. Neither changes because the viewer changed reading
language — so a manifest carries **one timing-and-acoustics backbone and any
number of text tracks over it**, and the typography a viewer sees is derived
from the original delivery in every language.

```bash
chorus add-language film.cwi.json --lang de --from german.srt
chorus add-language film.cwi.json --lang ja --from japanese.srt
chorus add-language film.cwi.json --lang ar --from arabic.srt
chorus languages film.cwi.json
```

```
  en-US  11/11 cues 100%  (the film)
  de     11/11 cues 100%
  ja     11/11 cues 100%
  ar     11/11 cues 100%
```

In the player it is one call, and it holds the playhead:

```js
renderer.languages()        // ['en-US', 'de', 'ja', 'ar']
renderer.setLanguage('ja')  // same instant, same speaker colours, new words
```

Translation is **not** done here. Every film already has professionally
translated subtitles, and they are better than anything generated on the spot.
What those files lack is everything this design conveys: no speaker, no
acoustics, no word-level timing. So `add-language` takes the words from the
translation and everything else from the analysed soundtrack. A viewer
switching to Japanese gets Japanese text revealing per character, laid out for
its own script, sized and weighted by the original actor's shout.

Cues are matched by **time overlap, not by index**, because subtitle files are
segmented for reading comfort rather than by utterance — one line becomes two,
two become one, and index matching drifts the entire film after the first
disagreement. A file from a different cut therefore matches nothing and says
so, instead of attaching plausibly and being wrong for two hours.

One honest limit, documented in `languages.ts` rather than buried: a translated
word has no onset on the soundtrack, because it is not a word anyone spoke.
Target words are distributed across the *utterance* by display width and
inherit the acoustics of whatever was being said at that moment. The reveal
stays in step with the voice phrase by phrase, and no claim is made that word 4
of the German is word 4 of the English.

## Conformance

The thesis of this repo is that **the format is the product** — a platform
should write its own renderer against semantics that are pinned down. That is
only credible if an implementation can prove it got them right.

```bash
chorus conform                        # the reference implementation
chorus conform --impl ./mine.js       # yours
```

`conformance/` holds the vectors as plain JSON, so an implementation in Rust,
Swift or a shader language can consume them without running any JavaScript.

Each vector declares whether it is **normative** — the value is fixed by the
published spec and cited by section, so disagreeing is being wrong — or
**informative**, meaning the spec is silent and this is merely *our* choice, so
an implementation may differ and still conform. Generating expectations from a
reference implementation and calling them normative would prove only that it
agrees with itself; where this suite says normative, the number is in the PDF.

The suite is itself tested. `conformance/mutants/` holds implementations each
carrying one realistic bug — an inverted pitch-to-weight curve, a validator
blind to unattributed dialogue, two characters sharing a colour — and the test
suite asserts every one is caught. A conformance suite only ever run against a
correct implementation proves nothing.

### What was actually drawn

Those vectors check computation. All of them can pass while the picture is
wrong: words revealed at the wrong moment, a speaker drawn in another's colour,
the line reflowing under the emphasis pop. So there is a second suite for the
picture.

```bash
chorus render-scenes                     # the scenes, and the instants to sample
chorus conform-render                    # drives the reference web renderer
chorus conform-render --report mine.json # anything else that can draw a manifest
```

An implementation reports what it drew — one record per token per sampled
instant — and the checker compares that against what the manifest says it
should have drawn. A Swift player, a shader, an NLE plugin and a web renderer
all emit the same report, and the checker never learns which produced it.

Three levels, because "conformant" is otherwise unfalsifiable. **A** is
attribution and word-level synchronisation, the mechanic the design exists for.
**AA** adds the acoustics-to-typography mapping within tolerance. **AAA** adds
layout discipline — no reflow, line limits, safe area, and a second non-colour
attribution channel where the profile provides one. A check whose inputs an
implementation did not report is skipped, and a skipped check forfeits its
level rather than failing it: a renderer with a static font is not AA, but
nothing it did was wrong and it can still certify at A.

The reference renderer runs this in CI on every commit, at Level AAA on every
scene. `conformance/render/README.md` is the contract.

## Publishing

Metadata lives in one place so four package.json files cannot drift apart:

```bash
node scripts/release/stamp.mjs --repo https://github.com/you/your-repo
npm run version:set 0.2.0
npm run release:check          # refuses to publish something broken
git tag v0.2.0 && git push --tags
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which tests on Node
18/20/22, verifies the tag matches the package version, runs the preflight, and
publishes with npm provenance. It needs an `NPM_TOKEN` secret.

Provenance attests that a tarball was built from a specific commit, and that
attestation is only verifiable if the commit is publicly readable — npm refuses
to generate it from a private repository. The workflow therefore reads the
repository's visibility at release time rather than hard-coding the flag, so a
release cannot fail over it in either direction: provenance is attached while
this repo is public, and publishing still works if it is ever closed again.

A `bin` path should not start with `./`. npm reports it during publish as an
error it "removed", which reads like the command is gone, and then quietly
auto-corrects the path in the registry metadata — `@corerus/chorus-cli@0.1.0`
went out that way and installs a working `chorus` command. The preflight notes
it rather than failing: relying on an undocumented auto-correction is a poor
bet, but blocking a release over something that demonstrably works is worse.

`release:check` is the part worth keeping: publishing is irreversible, so it
verifies every cheap thing beforehand — placeholder metadata, missing
LICENSE/README, dead `bin` links, internal dependency versions, source leaking
into the tarball, and that `pipeline/` is actually present in `@corerus/chorus-cli` (without
it, `chorus analyze` breaks for everyone who installs from the registry, and
without `conformance/` the conformance runners have no vectors). It caught
exactly those during setup.

## Status and caveats

- The renderer, core, CLI, MCP server, DSP pipeline and both provider adapters are working and tested (67 node + 49 python tests).
- **Nothing is on npm yet.** The packages are publish-ready and verified by installing the real tarballs into a clean project, but `scripts/release/stamp.mjs` still carries a placeholder repository URL — set it before the first publish.
- The HeyGen adapter is verified end to end on real renders: SRT + audio in, validated manifest out, rendered over the source video. Switch to "HeyGen render" or "Control Room (4 speakers)" in the demo.
- "Control Room" is a four-character scene built from seven HeyGen renders. `build_scene.py` merges them onto one timeline; `compose_scene.py` then composites them into a **single frame with all four speakers visible at once** — which is the situation CWI attribution actually exists for, and which a cut between talking heads cannot demonstrate. Hero and villain landed on opposite hues (green 120° / magenta 300°) per spec 2.1.1.
- Each provider render is one avatar, so the composite gives every character a fixed position for the whole running time: their own footage plays during their lines, and they hold on a still from their own clip between them. The audio timeline is unchanged, so the manifest built from the concatenated cut applies to the composite without re-timing.
- **A plain four-hander cannot be captioned CVD-safely with the CWI V1.0 palette.** Best worst-case separation across four main characters is ΔE 11.8 — Vale and Ruiz collide under tritanopia — against a floor of 20. The assigner reports this rather than degrading silently.
- Alignment accuracy for providers that give no word timings, measured against ground truth: median 45 ms, p90 78 ms, 97% within 100 ms. Measured on synthetic tones, so it bounds the algorithm rather than predicting real-world TTS accuracy.
- **HeyGen silently ignored both `voice_id` and `voice_settings.pitch`** on the studio avatars used here — see the note at the top of `pipeline/adapters/heygen.py`. The captions are still correct because typography is derived from the rendered audio, but the intended vocal contrast between characters was lost. Measure a probe clip per character before committing to a full pass.
- f0 uses YIN, accurate to ~0.01% on synthetic tones even when the fundamental is deliberately weaker than its second harmonic. It replaced plain autocorrelation, which measured a 101 Hz voice at 162 Hz because a third of its frames doubled.
- `centroidRange` is calibrated against 17 real voices (measured 770–1569 Hz), and spends ~80% of the width axis on that population.
- ASR and diarization are behind adapters and **not exercised by the test suite** — they download multi-GB models.
- The ASS export is generated to format spec but never executed end to end here (the local ffmpeg lacks `libass`). It is superseded by `chorus render`, which is faithful where ASS cannot be — libass has no variable-font axis support.
- `to-vtt` and `to-ass` are lossy by necessity and print exactly what they dropped. ASS cannot carry the variable-font axes at all, so the intonation layer is lost.

## Licence

This toolchain is MIT. **The Caption with Intention design system is not this repo's to license.** Its PDF is marked *All Rights Reserved* on every page and the system is marked ©, despite widespread "open source" framing in the press — there is no licence file or repository anywhere. Get written clarification from `requests@captionwithintention.org` before any commercial deployment. Roboto Flex is separately available under the SIL Open Font License.
