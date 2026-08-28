# @chorus/mcp

MCP server for the [Caption with Intention](https://www.captionwithintention.org/)
toolchain, so an agent gets identical behaviour to a person at the CLI.

```bash
claude mcp add chorus -- npx -y @chorus/mcp
```

Or in `.mcp.json`:

```json
{ "mcpServers": { "cwi": { "command": "npx", "args": ["-y", "@chorus/mcp"] } } }
```

## Tools

| Tool | Does |
|---|---|
| `cwi_validate` | Structural + accessibility audit of a manifest |
| `cwi_assign_colors` | Colour-vision-safe speaker colours |
| `cwi_stats` | Per-character screen time |
| `cwi_palette_audit` | Audit the spec's own palette; needs no manifest |
| `cwi_resolve_typography` | Acoustics -> type size/weight/width. Pure |
| `cwi_export` | WebVTT or ASS, reporting what was dropped |
| `cwi_analyze` | Media -> manifest |
| `cwi_build_scene` | Merge and composite multi-speaker renders |
| `cwi_init_app` | Scaffold a runnable app |
| `cwi_preview` / `cwi_preview_stop` | Live player, kept up across calls |

Each returns a one-line summary plus structured JSON. Both the CLI and this
server sit on one shared operations layer, so behaviour cannot drift between
them.

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
