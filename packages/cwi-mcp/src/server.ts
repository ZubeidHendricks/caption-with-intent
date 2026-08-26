#!/usr/bin/env node
/**
 * MCP server for the Caption with Intention toolchain.
 *
 * Every tool is a thin wrapper over the same operations the CLI uses, so an
 * agent and a person get identical behaviour. Tools return structured JSON
 * alongside a short human-readable summary: the summary is what an agent
 * usually needs to reason, the JSON is what it needs to act.
 *
 * Run over stdio:
 *     cwi-mcp
 *
 * Register with Claude Code:
 *     claude mcp add cwi -- node /path/to/packages/cwi-mcp/dist/server.js
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync } from 'node:fs';
import {
  CwiError, readManifest, writeManifest, assign, validateManifest, stats,
  auditPalette, exportCaptions, resolveTypography, analyzeMedia, buildScene,
} from 'cwi-cli';
import { startPreview, type PreviewHandle } from 'cwi-cli/preview';
import { render, PRESETS } from 'cwi-cli/render';
import { deliver, TARGETS } from 'cwi-cli/deliver';
import { conform } from 'cwi-cli/conform';
import { audit } from 'cwi-cli/audit';
import { toHtml, toMarkdown } from 'cwi-cli/audit-report';
import { init } from 'cwi-cli/scaffold';

const server = new McpServer({ name: 'caption-with-intention', version: '0.1.0' });

/** Structured payload plus a one-line summary an agent can reason over directly. */
function result(summary: string, data: unknown) {
  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function failure(e: unknown) {
  const msg = e instanceof CwiError && e.hint ? `${e.message}\n\nHint: ${e.hint}` : (e as Error).message;
  return { isError: true, content: [{ type: 'text' as const, text: msg }] };
}

const wrap = <T extends unknown[]>(fn: (...a: T) => unknown | Promise<unknown>) =>
  async (...a: T) => {
    try { return (await fn(...a)) as ReturnType<typeof result>; }
    catch (e) { return failure(e) as never; }
  };

// --------------------------------------------------------------------------

server.registerTool('cwi_validate', {
  title: 'Validate a caption manifest',
  description:
    'Structural and accessibility audit of a .cwi manifest. Catches dialogue with no speaker, ' +
    'cues exceeding the two-line maximum, unreadable caption rates, speaker colours below the ' +
    'WCAG contrast floor, and — importantly — speaker colours that collide under protanopia, ' +
    'deuteranopia or tritanopia. Colour collisions defeat the attribution mechanic entirely for ' +
    'affected viewers, so treat them as correctness bugs rather than cosmetic ones.',
  inputSchema: { manifest: z.string().describe('Path to a .cwi.json manifest') },
}, wrap(({ manifest }: { manifest: string }) => {
  const r = validateManifest(readManifest(manifest));
  return result(
    r.ok
      ? `Valid. ${r.warnings} warning(s).`
      : `INVALID — ${r.errors} error(s), ${r.warnings} warning(s).`,
    r,
  );
}));

server.registerTool('cwi_assign_colors', {
  title: 'Assign character colours',
  description:
    "Assign speaker colours from the Caption with Intention palette, implementing the spec's " +
    'hue-spacing and hero/villain-opposition rules plus a colour-vision-safety constraint the ' +
    'spec itself lacks. Writes the manifest in place unless `out` is given. Never pick these ' +
    'colours by hand — the CWI V1.0 palette has pairs that collapse under common dichromacies, ' +
    'and this search avoids them while drawing only from the spec swatches.',
  inputSchema: {
    manifest: z.string().describe('Path to a .cwi.json manifest'),
    out: z.string().optional().describe('Write here instead of in place'),
    cvdSafe: z.boolean().optional().default(true)
      .describe('Apply the colour-vision-deficiency constraint. Leave on unless comparing.'),
  },
}, wrap(({ manifest, out, cvdSafe }: { manifest: string; out?: string; cvdSafe?: boolean }) => {
  const m = readManifest(manifest);
  const r = assign(m, cvdSafe ?? true);
  const target = out ?? manifest;
  writeManifest(target, { ...m, characters: r.characters });
  const sep = Number.isFinite(r.worstCaseDeltaE) ? r.worstCaseDeltaE.toFixed(1) : 'n/a';
  return result(
    `Assigned ${r.characters.length} colours; worst-case separation ΔE ${sep}. ` +
    (r.warnings.length ? `${r.warnings.length} warning(s).` : 'No warnings.'),
    { ...r, out: target },
  );
}));

server.registerTool('cwi_stats', {
  title: 'Per-character screen time',
  description:
    'Words, seconds and share of dialogue per character. Useful for sanity-checking the ' +
    'main/supporting/minor tiering, which drives which palette each character draws from.',
  inputSchema: { manifest: z.string() },
}, wrap(({ manifest }: { manifest: string }) => {
  const r = stats(readManifest(manifest));
  return result(`${r.rows.length} characters, ${r.totalWords} words over ${r.totalSeconds}s.`, r);
}));

server.registerTool('cwi_palette_audit', {
  title: 'Audit the CWI palette',
  description:
    "Audit Caption with Intention V1.0's own six main colours for pairwise separation under " +
    'normal vision and all three dichromacies, plus contrast against the caption box. Takes no ' +
    'manifest — this is a property of the published spec. Use it to explain why a particular ' +
    'cast cannot be captioned colour-vision-safely.',
  inputSchema: { floor: z.number().optional().describe('ΔE floor, default 20') },
}, wrap(({ floor }: { floor?: number }) => {
  const r = auditPalette(floor);
  const total = r.rows.reduce((n, x) => n + x.collisions.length, 0);
  const failing = r.contrast.filter((x) => !x.passesAA).length;
  return result(
    `${total} colliding pair(s) across all vision modes; ${failing} colour(s) below WCAG AA contrast.`,
    r,
  );
}));

server.registerTool('cwi_resolve_typography', {
  title: 'Acoustics to typography',
  description:
    'Given a word\'s measured acoustics, return the type size, weight and width the spec ' +
    'prescribes, with an explanation of each. Pure — touches no files. Use it to reason about ' +
    'what a measurement will look like on screen. Note that `db` is RELATIVE to the speaker\'s ' +
    'normal speaking level (0 = normal), not an absolute level.',
  inputSchema: {
    db: z.number().optional().describe('Level relative to the speaker\'s normal voice; 0 = normal'),
    f0: z.number().optional().describe('Median fundamental frequency over the word, Hz'),
    centroid: z.number().optional().describe('Median spectral centroid over VOICED frames, Hz'),
  },
}, wrap((a: { db?: number; f0?: number; centroid?: number }) => {
  const r = resolveTypography(a);
  return result(`size ${r.size.toFixed(2)}% · wght ${r.wght} · wdth ${r.wdth}`, r);
}));

server.registerTool('cwi_export', {
  title: 'Export to a delivery format',
  description:
    'Export a manifest to WebVTT or ASS. BOTH ARE LOSSY and the result reports exactly what was ' +
    'dropped — read it. WebVTT keeps speaker identity and word timing but no typography at all. ' +
    'ASS keeps colour, per-word size and karaoke timing, but libass has no variable-font axis ' +
    'support, so the entire intonation layer (pitch and harmonics) is lost. Never present a ' +
    'lossy export as full CWI support.',
  inputSchema: {
    manifest: z.string(),
    format: z.enum(['vtt', 'ass']).default('vtt'),
    out: z.string().optional().describe('Write here; otherwise the content is returned'),
    frameHeight: z.number().optional().describe('Frame height for ASS sizing, default 1080'),
  },
}, wrap(({ manifest, format, out, frameHeight }: { manifest: string; format: 'vtt' | 'ass'; out?: string; frameHeight?: number }) => {
  const r = exportCaptions(readManifest(manifest), format, { frameHeight });
  if (out) writeFileSync(out, r.content);
  return result(
    `Exported ${format.toUpperCase()}${out ? ` to ${out}` : ''}. Lost: ${r.lost.length} feature(s).`,
    { format: r.format, lost: r.lost, out: out ?? null, content: out ? undefined : r.content },
  );
}));

server.registerTool('cwi_analyze', {
  title: 'Analyze media into a manifest',
  description:
    'Derive a caption manifest from media: word onsets, per-word loudness, pitch and spectral ' +
    'centroid. Needs one source of text — a word-timed transcript, a WebVTT file, or WhisperX ' +
    'ASR. Colours are NOT assigned; run cwi_assign_colors next. Word onsets matter: the spec ' +
    'requires the colour to flip on a word\'s first phoneme, which segment-level timings miss.',
  inputSchema: {
    media: z.string().describe('Path to audio or video'),
    out: z.string().describe('Where to write the .cwi.json'),
    transcript: z.string().optional().describe('Word-timed JSON'),
    vtt: z.string().optional().describe('WebVTT; word timings approximated unless inline'),
    whisperx: z.boolean().optional().describe('Run WhisperX ASR + diarization (downloads models)'),
    hfToken: z.string().optional(),
    pitchMode: z.enum(['voice', 'word', 'raw']).optional()
      .describe('voice (default): weight/width identify the character. word: per-word prosody, damped.'),
  },
}, wrap(async (a: Parameters<typeof analyzeMedia>[0]) => {
  const r = await analyzeMedia(a);
  return result(
    `Analyzed to ${r.out}: ${r.manifest.characters.length} character(s), ${r.manifest.cues.length} cue(s).`,
    { out: r.out, characters: r.manifest.characters, cues: r.manifest.cues.length, log: r.log },
  );
}));

server.registerTool('cwi_build_scene', {
  title: 'Build a multi-speaker scene',
  description:
    'Merge several single-speaker renders (HeyGen, ElevenLabs) onto one timeline and optionally ' +
    'composite them into a single frame where every character is visible at once. The composite ' +
    'matters: a cut between talking heads gives caption colour nothing to disambiguate, because ' +
    'the picture already says who is speaking.',
  inputSchema: {
    spec: z.string().describe('Path to a scene spec JSON (characters + shots)'),
    out: z.string().describe('Where to write the .cwi.json'),
    composeVideo: z.string().optional().describe('Composite all speakers into one frame at this path'),
    pitchMode: z.enum(['voice', 'word', 'raw']).optional(),
  },
}, wrap(async (a: Parameters<typeof buildScene>[0]) => {
  const r = await buildScene(a);
  return result(
    `Built ${r.out}: ${r.manifest.characters.length} character(s), ${r.manifest.cues.length} cue(s). Video: ${r.video}`,
    { out: r.out, video: r.video, characters: r.manifest.characters, log: r.log },
  );
}));

server.registerTool('cwi_init_app', {
  title: 'Scaffold a Caption with Intention app',
  description:
    'Create a runnable Vite app that renders a manifest over a video, with the colour-vision ' +
    'simulator and validation wired up. Fails on a non-empty directory unless force is set.',
  inputSchema: {
    dir: z.string().describe('Target directory'),
    name: z.string().optional(),
    force: z.boolean().optional(),
  },
}, wrap((a: { dir: string; name?: string; force?: boolean }) => {
  const r = init(a);
  return result(`Scaffolded ${r.files.length} files into ${r.dir}.`, r);
}));

server.registerTool('cwi_render', {
  title: 'Burn captions into a video',
  description:
    'Render a manifest onto a video as permanent open captions. This is currently the ONLY ' +
    'faithful delivery path: no deployed caption decoder can carry Caption with Intention — not ' +
    "WebVTT, SRT, CEA-608/708 or IMSC1/TTML2, and no platform's caption renderer including " +
    "YouTube's. Spec 3.2 says so and prescribes burned-in open captions until decoders catch up. " +
    'Needs ffmpeg and a headless browser (playwright-core). Slow: it captures every frame where a ' +
    'caption is on screen. Prefer cwi_deliver, which also emits the legally-required sidecar.',
  inputSchema: {
    manifest: z.string(),
    video: z.string().optional().describe('Source video; omitted renders captions on black'),
    out: z.string().describe('Output .mp4'),
    preset: z.enum(['web', 'youtube', 'cinema', 'prores']).optional().default('web'),
    from: z.number().optional().describe('Start offset in seconds'),
    duration: z.number().optional().describe('Render only this many seconds — good for a look test'),
  },
}, wrap(async (a: Parameters<typeof render>[0]) => {
  const r = await render(a);
  return result(
    `Rendered ${r.out} — ${r.width}x${r.height} @ ${r.fps}fps, ${r.seconds.toFixed(1)}s ` +
    `(${r.captured} frames captured, ${r.skipped} blank). ${PRESETS[r.preset].note}`,
    r,
  );
}));

server.registerTool('cwi_deliver', {
  title: 'Package a title for a delivery target',
  description:
    'Produce everything a target needs: the video with captions burned in, PLUS a conventional ' +
    'sidecar caption file, PLUS written upload instructions. Both artifacts matter — closed ' +
    'captioning is legally mandated (FCC/CVAA, and the European Accessibility Act since June ' +
    '2025) and spec 3.4 states CWI is additive, "in addition to" regulated closed captions, not a ' +
    'replacement. Shipping only the burned video is a compliance failure; shipping only the ' +
    'sidecar loses the design entirely.',
  inputSchema: {
    manifest: z.string(),
    video: z.string().optional(),
    target: z.enum(['youtube', 'web', 'cinema']).default('youtube'),
    outDir: z.string().describe('Directory to write the package into'),
  },
}, wrap(async (a: Parameters<typeof deliver>[0]) => {
  const r = await deliver(a);
  return result(
    `Packaged for ${TARGETS[r.target].label} in ${r.outDir}: video + ${r.sidecar ? 'sidecar captions' : 'no sidecar'} + DELIVERY.txt.`,
    r,
  );
}));

server.registerTool('cwi_conform', {
  title: 'Run the conformance suite',
  description:
    'Run the Caption with Intention conformance vectors against an implementation. Normative ' +
    'failures mean the implementation contradicts the published spec and are cited by section; ' +
    'informative differences mean the spec is silent there and differing is allowed. Use this ' +
    'when checking whether a renderer or port is correct, or to find out exactly which part of ' +
    'the spec a behaviour comes from. Omit `impl` to check the reference implementation.',
  inputSchema: {
    impl: z.string().optional().describe('Path to a JS module exporting resolveToken, assignColors and validate'),
  },
}, wrap(async ({ impl }: { impl?: string }) => {
  const r = await conform(impl);
  return result(
    r.ok
      ? `Conformant — ${r.passed}/${r.total} checks passed${r.informativeFailures.length ? `, ${r.informativeFailures.length} informative difference(s)` : ''}.`
      : `NOT conformant — ${r.normativeFailures.length} normative failure(s) of ${r.total} checks.`,
    r,
  );
}));

server.registerTool('cwi_audit', {
  title: 'Accessibility audit of a caption track',
  description:
    'Audit a caption track against WCAG 2.2, EN 301 549 (the standard the European Accessibility ' +
    'Act references), FCC 47 CFR 79.1 caption-quality rules, and CWI V1.0 itself. Produces a ' +
    'dated report identified by the SHA-256 of the manifest audited.\n\n' +
    'The finding that matters most: Caption with Intention attributes speakers by hue alone and ' +
    'defines no non-colour cue for identity, so a track using the base design FAILS WCAG 1.4.1 ' +
    '(Use of Color, Level A) whenever it has more than one speaker. Conventional captioning ' +
    'satisfies that criterion with speaker labels and ">>" markers, so this is a regression ' +
    'against ordinary practice, not merely a gap.\n\n' +
    'This is NOT a compliance certificate. Accuracy against the audio, and whether captions ' +
    'obscure important picture, are not decidable from a manifest; those criteria are reported ' +
    'as "review" rather than passing. Never describe its output as certifying compliance.',
  inputSchema: {
    manifest: z.string(),
    duration: z.number().optional().describe('Programme length in seconds, for the completeness check'),
    out: z.string().optional().describe('Write a report here; .md for markdown, otherwise HTML'),
  },
}, wrap(({ manifest, duration, out }: { manifest: string; duration?: number; out?: string }) => {
  const r = audit({ manifest, duration });
  if (out) writeFileSync(out, out.endsWith('.md') ? toMarkdown(r) : toHtml(r));
  const failing = r.findings.filter((f) => f.verdict === 'fail').map((f) => f.criterion.id);
  return result(
    `${r.summary.fail} failing, ${r.summary.warn} warning, ${r.summary.review} needs review, ` +
    `${r.summary.pass} passing.` + (failing.length ? ` Failing: ${failing.join(', ')}.` : ''),
    { ...r, reportWritten: out ?? null },
  );
}));

// --- Preview lifecycle ----------------------------------------------------
// The server process outlives a single call, so a preview can stay up between
// tool invocations. Keyed by URL so several can run at once.
const previews = new Map<string, PreviewHandle>();

server.registerTool('cwi_preview', {
  title: 'Start a caption preview server',
  description:
    'Serve a live player for a manifest, optionally over a video, and return its URL. The player ' +
    'includes the cast list, live validation, and a colour-vision simulator. Stays running until ' +
    'cwi_preview_stop. Note that browsers defer media loading in background tabs — if the video ' +
    'appears black, the tab needs focus.',
  inputSchema: {
    manifest: z.string(),
    video: z.string().optional(),
    port: z.number().optional().describe('Omit to pick a free port'),
  },
}, wrap(async ({ manifest, video, port }: { manifest: string; video?: string; port?: number }) => {
  const h = await startPreview({ manifest, video, port });
  previews.set(h.url, h);
  return result(`Preview running at ${h.url}`, { url: h.url, port: h.port, manifest, video: video ?? null });
}));

server.registerTool('cwi_preview_stop', {
  title: 'Stop a preview server',
  description: 'Stop a preview started by cwi_preview. Omit the url to stop all of them.',
  inputSchema: { url: z.string().optional() },
}, wrap(async ({ url }: { url?: string }) => {
  const targets = url ? [url] : [...previews.keys()];
  for (const u of targets) {
    const h = previews.get(u);
    if (h) { await h.close(); previews.delete(u); }
  }
  return result(`Stopped ${targets.length} preview(s).`, { stopped: targets });
}));

// --------------------------------------------------------------------------

const shutdown = async () => {
  for (const h of previews.values()) await h.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
