#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  CwiError, readManifest, writeManifest, assign, validateManifest, stats,
  auditPalette, exportCaptions, resolveTypography, analyzeMedia, buildScene, doctor,
  type ExportFormat,
} from './ops.js';
import { startPreview } from './preview.js';
import { render, PRESETS, ALPHA_FORMATS } from './render.js';
import { deliver, TARGETS } from './deliver.js';
import { conform } from './conform.js';
import { checkReport, loadScene, loadScenes,
  type RenderReport, type RenderConformResult } from './render-conform.js';
import { probeWebRenderer } from './render-probe.js';
import { audit } from './audit.js';
import { analyse, readResponses } from './study.js';
import { startStudy } from './study-server.js';
import { toHtml, toMarkdown } from './audit-report.js';
import { init } from './scaffold.js';
import { parse, str, num, bool, type Args } from './args.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string | number) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2'), red = c('31'), yel = c('33'), grn = c('32'), bold = c('1'), cyan = c('36');

const USAGE = `${bold('cwi')} — Caption with Intention toolchain

${bold('Getting started')}
  cwi doctor                          check what is available on this machine
  cwi init [dir]                      scaffold a runnable app
  cwi preview <manifest> [--video f]  open a player for any manifest

${bold('Delivering')}
  cwi deliver <manifest> --video f --target youtube
                                       burned video + mandated sidecar, ready to upload
  cwi render <manifest> --video f      just burn captions into the video
  cwi render <manifest> --alpha        transparent overlay for Premiere/FCP/Resolve/CapCut
  cwi targets / presets / overlays     list delivery targets, encodings, overlay formats

${bold('Producing captions')}
  cwi analyze <media> --vtt f          media + captions  -> manifest
  cwi analyze <media> --transcript f   media + word timings -> manifest
  cwi analyze <media> --whisperx       ASR + diarization (needs whisperx)
  cwi scene <spec.json> --out f        multi-speaker scene from provider renders

${bold('Working on a manifest')}
  cwi audit <manifest> [--out r.html]  accessibility audit against WCAG / EN 301 549 / FCC
  cwi assign <manifest>               assign character colours (CVD-safe)
  cwi validate <manifest>             structural + accessibility audit
  cwi stats <manifest>                per-character screen time
  cwi export <manifest> --format vtt  emit a delivery format (vtt | ass)

${bold('Validating with viewers')}
  cwi study <a.cwi.json> <b.cwi.json> --video f
                                       run an A/B attribution study
  cwi study-report <results.jsonl>     accuracy per design, with intervals

${bold('Reference')}
  cwi conform [--impl f]              run the conformance suite
  cwi conform-render [--report r.json] check what a renderer actually draws
  cwi render-scenes                   list the render conformance scenes
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
  async study(a) {
    const variants = a.positional;
    const results = str(a, 'results') ?? 'study-results.jsonl';
    const h = await startStudy({
      variants, results, video: str(a, 'video'),
      port: num(a, 'port'), host: str(a, 'host'), maxTrials: num(a, 'max-trials'),
    });
    console.log(`${grn('study')} ${cyan(h.url)}`);
    for (const v of h.variants) console.log(dim(`  ${v.id.padEnd(14)} ${v.label}`));
    console.log(dim(`  results  ${results}`));
    console.log(dim('\n  Share the URL with participants. Each visit is a fresh session.'));
    console.log(dim(`  Analyse with: cwi study-report ${results}`));
    console.log(dim('\nCtrl-C to stop.'));
    const stop = () => { void h.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await new Promise(() => {});
  },

  'study-report'(a) {
    const path = need(a, 'results file');
    const r = analyse(readResponses(path));
    out(a, r, () => {
      if (!r.totalTrials) { console.log(yel('No responses recorded yet.')); return; }
      console.log(`${bold('Study results')} — ${r.participants} participant(s), ${r.totalTrials} trials\n`);
      console.log('  variant          trials  accuracy        95% CI        median');
      for (const v of r.variants) {
        console.log(
          `  ${v.variantId.padEnd(15)} ${String(v.trials).padStart(6)}  ` +
          `${(v.accuracy * 100).toFixed(1).padStart(6)}%  ` +
          `${(v.ci95[0] * 100).toFixed(0).padStart(4)}–${(v.ci95[1] * 100).toFixed(0).padEnd(4)}%  ` +
          `${String(v.medianMs).padStart(6)}ms`);
      }
      console.log();
      for (const line of r.interpretation) console.log(`  ${dim(line)}`);
    });
  },

  audit(a) {
    const r = audit({ manifest: need(a, 'manifest'), duration: num(a, 'duration') });
    const format = str(a, 'format') ?? (str(a, 'out')?.endsWith('.md') ? 'md' : 'html');
    const target = str(a, 'out');

    if (bool(a, 'json')) { console.log(JSON.stringify(r, null, 2)); }
    else if (target) {
      const body = format === 'md' ? toMarkdown(r) : format === 'json' ? JSON.stringify(r, null, 2) : toHtml(r);
      writeFileSync(target, body);
      console.log(`${grn('wrote')} ${target}`);
    }

    if (!bool(a, 'json')) {
      const tint = { pass: grn, fail: red, warn: yel, review: cyan } as const;
      console.log(`\n${bold('Caption accessibility audit')} — ${r.title}`);
      console.log(dim(`  ${r.manifest.sha256.slice(0, 16)}…  ${r.generated}`));
      console.log(dim(`  ${r.disclaimer}`));
      console.log();
      for (const f of r.findings.filter((x) => x.verdict !== 'pass')) {
        console.log(`  ${tint[f.verdict](f.verdict.toUpperCase().padEnd(6))} ${f.criterion.id.padEnd(18)} ${f.criterion.title}`);
        console.log(`         ${dim(f.detail.slice(0, 150))}${f.detail.length > 150 ? dim('…') : ''}`);
      }
      const passing = r.findings.filter((x) => x.verdict === 'pass').length;
      console.log(`\n  ${red(String(r.summary.fail))} failing · ${yel(String(r.summary.warn))} warning · ` +
        `${cyan(String(r.summary.review))} needs review · ${grn(String(passing))} passing`);
    }
    if (r.summary.fail > 0) process.exitCode = 1;
  },

  async conform(a) {
    const r = await conform(str(a, 'impl'));
    out(a, r, () => {
      console.log(`conformance — ${dim(r.implementation)}\n`);
      for (const [area, x] of Object.entries(r.byArea)) {
        const tint = x.passed === x.total ? grn : yel;
        console.log(`  ${area.padEnd(12)} ${tint(`${x.passed}/${x.total}`)}`);
      }
      if (r.normativeFailures.length) {
        console.log(`\n${red('normative failures')} ${dim('— these are fixed by the published spec')}`);
        for (const f of r.normativeFailures) console.log(`  ${red('✗')} ${f.vector} · ${f.case}\n      ${dim(f.detail ?? '')}`);
      }
      if (r.informativeFailures.length) {
        console.log(`\n${yel('informative differences')} ${dim('— the spec is silent here; differing is allowed')}`);
        for (const f of r.informativeFailures) console.log(`  ${yel('•')} ${f.vector} · ${f.case}\n      ${dim(f.detail ?? '')}`);
      }
      console.log(r.ok
        ? `\n${grn(`${r.passed}/${r.total} — conformant`)}`
        : `\n${red(`${r.normativeFailures.length} normative failure(s)`)} of ${r.total} checks`);
    });
    if (!r.ok) process.exitCode = 1;
  },

  async 'conform-render'(a) {
    const scenes = str(a, 'scene') ? [loadScene(str(a, 'scene')!)] : loadScenes();
    const reportPath = str(a, 'report');
    const results: RenderConformResult[] = [];

    for (const scene of scenes) {
      // Either an implementation hands us what it drew, or we drive the web
      // renderer ourselves. The checker cannot tell the difference, which is
      // the point: the reference renderer earns its level the same way.
      const report: RenderReport = reportPath
        ? JSON.parse(readFileSync(resolve(reportPath), 'utf8'))
        : await probeWebRenderer({ scene });
      if (reportPath && report.scene !== scene.id) {
        throw new CwiError(`That report is for scene "${report.scene}", not "${scene.id}".`,
          'Pass --scene to pick the scene the report covers.');
      }
      results.push(checkReport(scene, report));
    }

    out(a, results.length === 1 ? results[0] : results, () => {
      for (const r of results) {
        console.log(`render conformance — ${dim(r.implementation)} · ${bold(r.scene)}\n`);
        for (const c of r.checks) {
          const mark = c.skipped ? yel('skip') : c.ok ? grn(' ok ') : red('FAIL');
          console.log(`  ${mark} ${c.level.padEnd(3)} ${c.id.padEnd(5)} ${c.title}`);
          if (c.detail && (!c.ok || c.skipped)) console.log(`         ${dim(c.detail.slice(0, 160))}`);
          if (!c.ok && c.spec) console.log(`         ${dim(`spec ${c.spec}`)}`);
        }
        const tint = r.level === null ? red : grn;
        console.log(`\n  ${tint(r.level ? `Level ${r.level}` : 'not conformant')}` +
          dim(`  A ${r.byLevel.A.passed}/${r.byLevel.A.total}` +
            ` · AA ${r.byLevel.AA.passed}/${r.byLevel.AA.total}` +
            ` · AAA ${r.byLevel.AAA.passed}/${r.byLevel.AAA.total}`) + '\n');
      }
    });
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  },

  async 'render-scenes'(a) {
    const scenes = loadScenes().map((s) => ({
      id: s.id, title: s.title, why: s.why, frame: s.frame, samples: s.samples.length,
    }));
    out(a, scenes, () => {
      for (const s of scenes) {
        console.log(`  ${bold(s.id)}  ${dim(`${s.frame.w}x${s.frame.h}, ${s.samples} samples`)}`);
        console.log(`    ${s.title}`);
        console.log(`    ${dim(s.why)}\n`);
      }
    });
  },

  async doctor(a) {
    const r = await doctor();
    out(a, r, () => {
      for (const c of r.checks) {
        const mark = c.ok ? grn('ok  ') : red('FAIL');
        console.log(`  ${mark} ${c.name.padEnd(13)} ${c.detail}`);
        if (!c.ok) {
          console.log(`       ${dim(`needed for: ${c.needed}`)}`);
          if (c.fix) console.log(`       ${cyan(c.fix)}`);
        }
      }
      console.log(r.ok ? `\n${grn('Everything is available.')}`
        : `\n${yel('Some capabilities are unavailable.')} ${dim('The rest of the toolchain still works.')}`);
    });
    if (!r.ok) process.exitCode = 1;
  },

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
      console.log(dim(`  profile: ${r.profile}`));
      for (const ch of r.characters) {
        console.log(`  ${(ch.name ?? ch.id).padEnd(22)} ${ch.tier.padEnd(11)} ${ch.color}` +
          (ch.position ? dim(`  ${ch.position}`) : '') + (ch.glyph ? `  ${ch.glyph}` : ''));
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

  async render(a) {
    const manifest = need(a, 'manifest');
    const alpha = str(a, 'alpha') ?? (bool(a, 'alpha') ? 'prores4444' : undefined);
    const ext = alpha ? (ALPHA_FORMATS[alpha]?.ext ?? '.mov') : '.burned.mp4';
    const stem = manifest.replace(/\.cwi\.json$|\.json$/, '');
    const outPath = str(a, 'out') ?? (alpha === 'png' ? `${stem}.frames` : stem + ext);
    const quiet = bool(a, 'quiet') || bool(a, 'json');
    let lastPct = -1;
    const r = await render({
      manifest, video: str(a, 'video'), out: outPath,
      preset: str(a, 'preset'), fps: num(a, 'fps'), alpha,
      width: num(a, 'width'), height: num(a, 'height'),
      from: num(a, 'from'), duration: num(a, 'duration'),
      onProgress: quiet ? undefined : (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        const bar = '█'.repeat(Math.round(pct / 3)).padEnd(33, '·');
        process.stderr.write(`\r  ${bar} ${String(pct).padStart(3)}%  ${done}/${total} frames`);
      },
    });
    if (!quiet) process.stderr.write('\n');
    out(a, r, () => {
      console.log(`${grn('wrote')} ${r.out}`);
      console.log(dim(`  ${r.width}x${r.height} @ ${r.fps}fps · ${r.seconds.toFixed(1)}s`));
      console.log(dim(`  ${r.captured} frames captured, ${r.skipped} blank (no caption on screen)`));
      if (r.alpha) {
        const f = ALPHA_FORMATS[r.alpha];
        console.log(dim(`  ${f.label} — ${f.note}`));
        console.log(`\n  ${bold('Import as a track above your picture in:')} ${r.worksIn?.join(', ')}`);
      } else {
        console.log(dim(`  ${PRESETS[r.preset].note}`));
      }
    });
  },

  async deliver(a) {
    const manifest = need(a, 'manifest');
    const target = str(a, 'target') ?? 'youtube';
    const quiet = bool(a, 'quiet') || bool(a, 'json');
    let lastPct = -1;
    const r = await deliver({
      manifest, video: str(a, 'video'), target,
      outDir: str(a, 'out') ?? `deliver-${target}`,
      onProgress: quiet ? undefined : (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        process.stderr.write(`\r  rendering ${String(pct).padStart(3)}%  ${done}/${total} frames`);
      },
    });
    if (!quiet) process.stderr.write('\n');
    out(a, r, () => {
      console.log(`${grn('packaged')} ${r.outDir}`);
      console.log(dim(`  ${TARGETS[target].label} · ${r.seconds.toFixed(1)}s · ${r.frames} frames`));
      console.log(`  ${basename(r.video)}`);
      if (r.sidecar) console.log(`  ${basename(r.sidecar)}   ${dim('the mandated closed caption track — ship it too')}`);
      console.log(`  ${basename(r.readme)}   ${dim('upload instructions')}`);
    });
  },

  targets(a) {
    out(a, Object.entries(TARGETS).map(([k, v]) => ({ id: k, label: v.label, preset: v.preset, sidecar: v.sidecar })), () => {
      for (const [k, v] of Object.entries(TARGETS)) {
        console.log(`  ${cyan(k.padEnd(9))} ${v.label}  ${dim(`(${v.preset} + ${v.sidecar} sidecar)`)}`);
      }
    });
  },

  overlays(a) {
    out(a, Object.entries(ALPHA_FORMATS).map(([id, f]) => ({ id, ...f })), () => {
      console.log(`Transparent overlay formats — import above your picture, no plugin needed.\n`);
      for (const [id, f] of Object.entries(ALPHA_FORMATS)) {
        console.log(`  ${cyan(id.padEnd(11))} ${f.label}`);
        console.log(`  ${' '.repeat(11)} ${dim(f.note)}`);
        console.log(`  ${' '.repeat(11)} ${dim('works in: ' + f.worksIn.join(', '))}`);
      }
    });
  },

  presets(a) {
    const rows = Object.entries(PRESETS).map(([k, v]) => ({ id: k, ...v }));
    out(a, rows, () => {
      for (const [k, v] of Object.entries(PRESETS)) {
        console.log(`  ${cyan(k.padEnd(9))} ${v.label}`);
        console.log(`  ${' '.repeat(9)} ${dim(v.note)}`);
      }
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
