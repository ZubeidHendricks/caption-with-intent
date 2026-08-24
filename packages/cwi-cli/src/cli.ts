#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  CwiError, readManifest, writeManifest, assign, validateManifest, stats,
  auditPalette, exportCaptions, resolveTypography, analyzeMedia, buildScene,
  type ExportFormat,
} from './ops.js';
import { startPreview } from './preview.js';
import { init } from './scaffold.js';
import { parse, str, num, bool, type Args } from './args.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string | number) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2'), red = c('31'), yel = c('33'), grn = c('32'), bold = c('1'), cyan = c('36');

const USAGE = `${bold('cwi')} — Caption with Intention toolchain

${bold('Getting started')}
  cwi init [dir]                      scaffold a runnable app
  cwi preview <manifest> [--video f]  open a player for any manifest

${bold('Producing captions')}
  cwi analyze <media> --vtt f          media + captions  -> manifest
  cwi analyze <media> --transcript f   media + word timings -> manifest
  cwi analyze <media> --whisperx       ASR + diarization (needs whisperx)
  cwi scene <spec.json> --out f        multi-speaker scene from provider renders

${bold('Working on a manifest')}
  cwi assign <manifest>               assign character colours (CVD-safe)
  cwi validate <manifest>             structural + accessibility audit
  cwi stats <manifest>                per-character screen time
  cwi export <manifest> --format vtt  emit a delivery format (vtt | ass)

${bold('Reference')}
  cwi palette                         audit the spec's own palette
  cwi type --db 6 --f0 110            what typography an acoustic reading yields

${bold('Common flags')}
  --out <file>      where to write        --json     machine-readable output
  --cvd-unsafe      skip the colour-vision constraint on assign
  --quiet           errors only

Run ${cyan('cwi <command> --help')} for detail on any command.`;

function fail(e: unknown): never {
  if (e instanceof CwiError) {
    console.error(`${red('error')} ${e.message}`);
    if (e.hint) console.error(`${dim('hint')}  ${e.hint}`);
  } else {
    console.error(`${red('error')} ${(e as Error).message}`);
  }
  process.exit(1);
}

function out(a: Args, data: unknown, human: () => void): void {
  if (bool(a, 'json')) console.log(JSON.stringify(data, null, 2));
  else human();
}

// --------------------------------------------------------------------------

const commands: Record<string, (a: Args) => Promise<void> | void> = {
  init(a) {
    const r = init({ dir: a.positional[0] ?? '.', name: str(a, 'name'), force: bool(a, 'force') });
    out(a, r, () => {
      console.log(`${grn('created')} ${r.dir}`);
      for (const f of r.files) console.log(`  ${dim(f)}`);
      console.log(`\n${bold('Next')}`);
      for (const l of r.next) console.log(l ? `  ${l}` : '');
    });
  },

  assign(a) {
    const path = need(a, 'manifest');
    const m = readManifest(path);
    const r = assign(m, !bool(a, 'cvd-unsafe'));
    const target = str(a, 'out') ?? path;
    writeManifest(target, { ...m, characters: r.characters });
    out(a, { ...r, out: target }, () => {
      for (const ch of r.characters) {
        console.log(`  ${(ch.name ?? ch.id).padEnd(22)} ${ch.tier.padEnd(11)} ${ch.color}`);
      }
      const sep = Number.isFinite(r.worstCaseDeltaE) ? r.worstCaseDeltaE.toFixed(1) : 'n/a';
      console.log(`\nworst-case separation across mains (normal + all dichromacies): ${dim('ΔE')} ${sep}`);
      for (const w of r.warnings) console.log(`${yel('warning')} ${w}`);
      console.log(`\n${grn('wrote')} ${target}`);
    });
  },

  validate(a) {
    const r = validateManifest(readManifest(need(a, 'manifest')));
    out(a, r, () => {
      if (!r.issues.length) { console.log(grn('No issues.')); return; }
      for (const i of r.issues) {
        const tint = i.severity === 'error' ? red : i.severity === 'warning' ? yel : dim;
        console.log(`${tint(i.severity.padEnd(7))} ${dim(i.code + (i.ref ? ` ${i.ref}` : ''))}\n  ${i.message}`);
      }
      console.log(`\n${r.errors} error(s), ${r.warnings} warning(s)`);
    });
    if (!r.ok) process.exitCode = 1;
  },

  stats(a) {
    const r = stats(readManifest(need(a, 'manifest')));
    out(a, r, () => {
      console.log(`character              tier         words   seconds   share`);
      for (const row of r.rows) {
        console.log(
          `${row.name.slice(0, 22).padEnd(22)} ${row.tier.padEnd(12)} ${String(row.words).padStart(5)} ` +
          `${row.seconds.toFixed(1).padStart(9)} ${(row.share * 100).toFixed(1).padStart(6)}%`,
        );
      }
      console.log(`\n${r.totalWords} words over ${r.totalSeconds.toFixed(1)}s`);
    });
  },

  palette(a) {
    const r = auditPalette();
    out(a, r, () => {
      console.log('Caption with Intention V1.0 main palette — pairwise separation\n');
      for (const row of r.rows) {
        const txt = row.collisions.length
          ? yel(row.collisions.map((x) => `${x.a}/${x.b} ΔE${x.deltaE}`).join('  '))
          : grn('all pairs distinguishable');
        console.log(`  ${row.mode.padEnd(13)} ${txt}`);
      }
      console.log('\ncontrast against the caption box:');
      for (const x of r.contrast) {
        const t = x.passesAA ? grn(`${x.ratio}:1`) : yel(`${x.ratio}:1  below WCAG AA`);
        console.log(`  ${x.name.replace('CI Main ', '').padEnd(8)} ${x.hex}  ${t}`);
      }
      console.log(dim('\nPairs below ΔE 20 are hard to tell apart on moving text.'));
    });
  },

  type(a) {
    const r = resolveTypography({ db: num(a, 'db'), f0: num(a, 'f0'), centroid: num(a, 'centroid') });
    out(a, r, () => {
      console.log(`  size  ${String(r.size.toFixed(2)).padStart(6)}   ${dim(r.explanation.size)}`);
      console.log(`  wght  ${String(r.wght).padStart(6)}   ${dim(r.explanation.wght)}`);
      console.log(`  wdth  ${String(r.wdth).padStart(6)}   ${dim(r.explanation.wdth)}`);
    });
  },

  export(a) {
    const path = need(a, 'manifest');
    const format = (str(a, 'format') ?? 'vtt') as ExportFormat;
    if (format !== 'vtt' && format !== 'ass') {
      throw new CwiError(`Unknown format "${format}".`, 'Use --format vtt or --format ass.');
    }
    const r = exportCaptions(readManifest(path), format, { frameHeight: num(a, 'height') });
    const target = str(a, 'out');
    if (target) { writeFileSync(target, r.content); console.log(`${grn('wrote')} ${target}`); }
    else if (!bool(a, 'json')) console.log(r.content);
    if (bool(a, 'json')) { console.log(JSON.stringify(r, null, 2)); return; }
    console.error(`\n${yel(`${format.toUpperCase()} cannot carry:`)}`);
    for (const l of r.lost) console.error(`  - ${l}`);
  },

  async analyze(a) {
    const media = need(a, 'media file');
    const outPath = str(a, 'out') ?? media.replace(/\.[^.]+$/, '') + '.cwi.json';
    const r = await analyzeMedia({
      media, out: outPath,
      transcript: str(a, 'transcript'), vtt: str(a, 'vtt'), whisperx: bool(a, 'whisperx'),
      hfToken: str(a, 'hf-token'), pitchMode: str(a, 'pitch-mode') as 'voice' | 'word' | 'raw' | undefined,
      maxGap: num(a, 'max-gap'), maxCue: num(a, 'max-cue'), maxChars: num(a, 'max-chars'),
    });
    out(a, { out: r.out, characters: r.manifest.characters.length, cues: r.manifest.cues.length }, () => {
      console.log(r.log);
      console.log(`\n${dim('next')}  cwi assign ${r.out}`);
    });
  },

  async scene(a) {
    const spec = need(a, 'scene spec');
    const outPath = str(a, 'out') ?? 'scene.cwi.json';
    const r = await buildScene({
      spec, out: outPath,
      composeVideo: bool(a, 'compose') ? (str(a, 'video') ?? 'scene.mp4') : str(a, 'video'),
      pitchMode: str(a, 'pitch-mode') as 'voice' | 'word' | 'raw' | undefined,
    });
    out(a, { out: r.out, video: r.video }, () => {
      console.log(r.log);
      console.log(`\n${dim('next')}  cwi assign ${r.out} && cwi preview ${r.out} --video ${r.video}`);
    });
  },

  async preview(a) {
    const manifest = need(a, 'manifest');
    const h = await startPreview({
      manifest, video: str(a, 'video'), port: num(a, 'port'),
      host: str(a, 'host'), inspector: !bool(a, 'no-inspector'),
    });
    console.log(`${grn('preview')} ${cyan(h.url)}`);
    console.log(dim(`  manifest  ${basename(manifest)}`));
    console.log(dim(`  video     ${str(a, 'video') ?? '(none — captions render on their own)'}`));
    console.log(dim('\nCtrl-C to stop.'));
    const stop = () => { void h.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await new Promise(() => {});
  },
};

function need(a: Args, what: string): string {
  const v = a.positional[0];
  if (!v) throw new CwiError(`Missing ${what}.`, `Usage: cwi ${process.argv[2]} <${what}>`);
  return v;
}

const [, , cmd, ...rest] = process.argv;
const args = parse(rest);

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); process.exit(0); }
if (cmd === '--version' || cmd === 'version') { console.log('0.1.0'); process.exit(0); }

const fn = commands[cmd];
if (!fn) {
  console.error(`${red('error')} Unknown command "${cmd}".`);
  const near = Object.keys(commands).filter((k) => k.startsWith(cmd[0] ?? ''));
  if (near.length) console.error(`${dim('hint')}  Did you mean: ${near.join(', ')}?`);
  console.error(`\n${USAGE}`);
  process.exit(1);
}

try {
  await fn(args);
} catch (e) {
  fail(e);
}
