# caption-with-intent

An open toolchain for the [Caption with Intention](https://www.captionwithintention.org/) design system — the caption format FCB Chicago built with the Chicago Hearing Society to give Deaf and Hard of Hearing audiences speaker attribution, word-level synchronization, and vocal intonation.

CWI V1.0 ships as a PDF, an After Effects template, and a font. This repo adds the parts needed to run it at scale: **an interchange format, a reference implementation of the spec's math, a web renderer, and an analyzer that derives the whole thing from audio.**

Read `RESEARCH.md` for what the system is, `ARCHITECTURE.md` for how to automate and distribute it, and `docs/SPEC-NOTES.md` for every place this implementation had to decide something the spec left open.

## Layout

```
spec/cwi-manifest.schema.json   the .cwi interchange format
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

`cwi analyze` and `cwi scene` additionally need **Python 3 with numpy** and
**ffmpeg** on PATH. The Python pipeline ships inside `cwi-cli`; set `CWI_PYTHON`
to choose an interpreter. Everything else is pure Node.

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
cwi init [dir]                      scaffold a runnable app
cwi preview <manifest> [--video f]  open a player for any manifest
cwi analyze <media> --vtt f         media + captions -> manifest
cwi scene <spec.json> --out f       multi-speaker scene from provider renders
cwi assign <manifest>               assign character colours (CVD-safe)
cwi validate <manifest>             structural + accessibility audit
cwi stats <manifest>                per-character screen time
cwi export <manifest> --format vtt  emit a delivery format (vtt | ass)
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

Eleven tools: `cwi_validate`, `cwi_assign_colors`, `cwi_stats`,
`cwi_palette_audit`, `cwi_resolve_typography`, `cwi_export`, `cwi_analyze`,
`cwi_build_scene`, `cwi_init_app`, `cwi_preview`, `cwi_preview_stop`.
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
- f0 estimation has a known octave-error failure mode on some rendered audio. A naive sub-harmonic correction was tried and rejected (it over-corrected higher voices); fixing it properly needs pYIN or CREPE behind the same interface.
- ASR and diarization are behind adapters and **not exercised by the test suite** — they download multi-GB models.
- The ASS burn-in export is generated to format spec but **was not executed end to end here**, because the local ffmpeg build lacks `libass`.
- `to-vtt` and `to-ass` are lossy by necessity and print exactly what they dropped. ASS cannot carry the variable-font axes at all, so the intonation layer is lost.

## Licence

This toolchain is MIT. **The Caption with Intention design system is not this repo's to license.** Its PDF is marked *All Rights Reserved* on every page and the system is marked ©, despite widespread "open source" framing in the press — there is no licence file or repository anywhere. Get written clarification from `requests@captionwithintention.org` before any commercial deployment. Roboto Flex is separately available under the SIL Open Font License.
