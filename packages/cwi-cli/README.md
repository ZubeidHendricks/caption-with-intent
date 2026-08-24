# cwi-cli

The `cwi` command: scaffold apps, analyze media into caption manifests, assign
accessible colours, validate, preview and export.

```bash
npm install -g cwi-cli
cwi --help
```

## Start here

```bash
cwi init my-captions          # scaffold a runnable Vite app
cwi preview captions.cwi.json --video scene.mp4
```

`preview` needs no scaffolding and no build step. It serves a player with the
cast list, live validation and a colour-vision simulator, using the packages'
own ESM over an import map — so you preview the published renderer rather than
a copy of it.

## Commands

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

Every command takes `--json`. `validate` exits non-zero on errors, so it drops
straight into CI.

## Requirements

`analyze` and `scene` need **Python 3 with numpy** and **ffmpeg** on PATH; the
Python pipeline ships inside this package. Set `CWI_PYTHON` to point at a
specific interpreter. Everything else is pure Node.

Exports are lossy by necessity and print exactly what they dropped — WebVTT
keeps no typography at all, and ASS cannot carry variable-font axes, so the
whole intonation layer is lost there. Never present a lossy export as full CWI
support.

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
