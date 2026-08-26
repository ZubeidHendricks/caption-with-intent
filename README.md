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
packages/cwi-core               spec math: palettes, acoustics→type, assignment, validation (0 deps)
packages/cwi-web                DOM + variable-font renderer, drives off any <video>
packages/cwi-cli                the `cwi` command + shared operations layer
packages/cwi-mcp                MCP server — the same operations, for agents
pipeline/                       media → .cwi  (numpy DSP, no models required)
  acoustics.py                    per-word loudness, pitch, spectral centroid
  align.py                        known text → word onsets on clean speech
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
| [`cwi-core`](packages/cwi-core) | Spec math: palettes, acoustics→type, assignment, validation. Zero deps. |
| [`cwi-web`](packages/cwi-web) | DOM + variable-font renderer |
| [`cwi-cli`](packages/cwi-cli) | The `cwi` command |
| [`cwi-mcp`](packages/cwi-mcp) | MCP server, for agents |

```bash
npm install -g cwi-cli          # the toolchain
npm install cwi-core cwi-web    # to build against
```

Requirements vary by command — run `cwi doctor` to see what this machine has:

| Command | Needs |
|---|---|
| everything else | Node 18+ |
| `analyze`, `scene` | Python 3 with numpy, and ffmpeg on PATH |
| `render`, `deliver` | ffmpeg, plus **Node 20+** and a headless browser (`playwright-core`) |

The Python pipeline ships inside `cwi-cli`; set `CWI_PYTHON` to choose an
interpreter. Playwright enforces its Node 20 floor by exiting the process rather
than throwing, so the browser-backed commands check the version before importing
it and report a clear message on Node 18.

## Working on this repo

```bash
npm install
npm run setup:py       # venv + numpy for the pipeline
npm run build
```

### Make an app

```bash
npx cwi init my-captions     # scaffold a runnable Vite app
cd my-captions && npm install && npm run dev
```

### Ship it

No caption decoder anywhere can render CWI — not WebVTT, SRT, CEA-608/708 or
IMSC1/TTML2, and no platform's caption engine including YouTube's. Spec 3.2 says
so and prescribes burned-in open captions until decoders catch up. So delivery
means burning the captions into the picture:

```bash
cwi deliver captions.cwi.json --video scene.mp4 --target youtube --out ./upload
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
`cwi targets`). Encoding presets are listed by `cwi presets`.

The captions are captured offscreen from the same renderer the preview uses, so
a burned-in master and the preview agree frame for frame. Rendering needs
ffmpeg and a headless browser (`npm i playwright-core`), and it is slow — it
captures every frame where a caption is on screen.

### Or just look at a manifest

```bash
npx cwi preview captions.cwi.json --video scene.mp4
```

`preview` needs no scaffolding and no build step. It serves a player with the
cast list, live validation, and a colour-vision simulator, using the packages'
own ESM over an import map — so what you preview is the published renderer,
not a copy of it.

### The command

```
cwi doctor                          check what is available on this machine
cwi init [dir]                      scaffold a runnable app
cwi preview <manifest> [--video f]  open a player for any manifest
cwi deliver <manifest> --target youtube
                                    burned video + sidecar, ready to upload
cwi render <manifest> --video f     just burn captions into the video
cwi targets / cwi presets           delivery targets and encoding presets
cwi analyze <media> --vtt f         media + captions -> manifest
cwi scene <spec.json> --out f       multi-speaker scene from provider renders
cwi assign <manifest>               assign character colours (CVD-safe)
cwi validate <manifest>             structural + accessibility audit
cwi audit <manifest> --out r.html   compliance report (WCAG / EN 301 549 / FCC)
cwi study <a> <b> --video f         A/B attribution study with viewers
cwi study-report <results.jsonl>    accuracy per design, with intervals
cwi stats <manifest>                per-character screen time
cwi export <manifest> --format vtt  emit a delivery format (vtt | ass)
cwi conform [--impl f]              run the conformance suite
cwi palette                         audit the spec's own palette
cwi type --db 6 --f0 110            what typography an acoustic reading yields
```

Every command takes `--json` for machine-readable output. `validate` exits
non-zero on errors, so it drops straight into CI.

### For agents — MCP

The same operations are exposed over MCP, so an agent gets identical behaviour
to a person. `.mcp.json` in the repo root registers it; or:

```bash
claude mcp add cwi -- node "$PWD/packages/cwi-mcp/dist/server.js"
```

Fifteen tools: `cwi_validate`, `cwi_assign_colors`, `cwi_stats`,
`cwi_palette_audit`, `cwi_resolve_typography`, `cwi_export`, `cwi_analyze`,
`cwi_build_scene`, `cwi_render`, `cwi_deliver`, `cwi_conform`, `cwi_audit`,
`cwi_init_app`, `cwi_preview`, `cwi_preview_stop`.
Each returns a one-line summary plus structured JSON, and lossy exports report
what they dropped rather than pretending to be complete.

### The reference demo

```bash
npm run dev            # http://localhost:5178
```

Analyze a clip you already have word timings for:

```bash
./.venv/bin/python pipeline/analyze.py --media clip.mp4 --transcript words.json --out clip.cwi.json
node packages/cwi-cli/dist/cli.js assign   clip.cwi.json
node packages/cwi-cli/dist/cli.js validate clip.cwi.json
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
node packages/cwi-cli/dist/cli.js palette
```

```
normal        all pairs distinguishable
protanopia    Yellow/Green ΔE6.0
deuteranopia  Yellow/Green ΔE18.0  Green/Orange ΔE10.7  Red/Orange ΔE14.1
tritanopia    Green/Blue ΔE11.8
```

CWI V1.0 tells speakers apart by hue alone. Give two leads Red and Orange and a deuteranopic viewer cannot tell them apart — which defeats the attribution mechanic rather than merely degrading it. `cwi assign` avoids colliding pairs by default while drawing only from the spec's own swatches. Toggle it in the demo to watch the difference.

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
npm run sample -w cwi-demo     # rebuilds sample.cwi.json
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
cwi study control-room.cwi.json chorus-room.cwi.json --video scene.mp4
cwi study-report study-results.jsonl
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
cwi audit captions.cwi.json --duration 1847 --out report.html
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

## Conformance

The thesis of this repo is that **the format is the product** — a platform
should write its own renderer against semantics that are pinned down. That is
only credible if an implementation can prove it got them right.

```bash
cwi conform                        # the reference implementation
cwi conform --impl ./mine.js       # yours
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

`release:check` is the part worth keeping: publishing is irreversible, so it
verifies every cheap thing beforehand — placeholder metadata, missing
LICENSE/README, dead `bin` links, internal dependency versions, source leaking
into the tarball, and that `pipeline/` is actually present in `cwi-cli` (without
it, `cwi analyze` breaks for everyone who installs from the registry). It caught
exactly that during setup.

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
- The ASS export is generated to format spec but never executed end to end here (the local ffmpeg lacks `libass`). It is superseded by `cwi render`, which is faithful where ASS cannot be — libass has no variable-font axis support.
- `to-vtt` and `to-ass` are lossy by necessity and print exactly what they dropped. ASS cannot carry the variable-font axes at all, so the intonation layer is lost.

## Licence

This toolchain is MIT. **The Caption with Intention design system is not this repo's to license.** Its PDF is marked *All Rights Reserved* on every page and the system is marked ©, despite widespread "open source" framing in the press — there is no licence file or repository anywhere. Get written clarification from `requests@captionwithintention.org` before any commercial deployment. Roboto Flex is separately available under the SIL Open Font License.
