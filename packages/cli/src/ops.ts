/**
 * Operations layer.
 *
 * Every capability lives here and returns structured data, never console
 * output. The CLI formats it for humans, the MCP server hands it to an agent,
 * and neither owns behaviour the other lacks. Adding a capability in one place
 * gets it in both.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  assignColors, validate, speakerStats, worstCaseSeparation,
  simulateCvd, deltaE, contrastRatio, resolveToken, withDefaults,
  MAIN_COLORS, SUPPORTING_COLORS, DELTA_E_FLOOR,
  type CwiManifest, type CwiOptions, type Issue, type Character, type CvdType,
} from '@corerus/chorus-core';
import { toAss, toVtt } from './export.js';

const run = promisify(execFile);

export class CwiError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'CwiError';
  }
}

// --------------------------------------------------------------------------
// Manifest I/O
// --------------------------------------------------------------------------

export function readManifest(path: string): CwiManifest {
  if (!existsSync(path)) throw new CwiError(`No such manifest: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new CwiError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  const m = parsed as CwiManifest;
  if (!m || typeof m !== 'object' || !('cwi' in m)) {
    throw new CwiError(`${path} is not a Caption with Intention manifest (no "cwi" field).`,
      'Expected the .cwi format — see spec/cwi-manifest.schema.json.');
  }
  if (!Array.isArray(m.characters) || !Array.isArray(m.cues)) {
    throw new CwiError(`${path} is missing "characters" or "cues".`);
  }
  return m;
}

export function writeManifest(path: string, m: CwiManifest): void {
  writeFileSync(path, JSON.stringify(m, null, 2));
}

// --------------------------------------------------------------------------
// Core operations
// --------------------------------------------------------------------------

export interface AssignResultOut {
  characters: Character[];
  warnings: string[];
  worstCaseDeltaE: number;
  cvdSafe: boolean;
  profile: string;
}

export function assign(m: CwiManifest, cvdSafe = true): AssignResultOut {
  // The manifest names its own design profile; assignment must honour it, or
  // an chorus-1.0 track silently gets the CWI palette and its defects.
  const { characters, warnings } = assignColors(m.characters, { cvdSafe, profile: m.profile });
  const mains = characters.filter((c) => c.tier === 'main' && c.color).map((c) => c.color!);
  return {
    characters,
    warnings,
    worstCaseDeltaE: mains.length > 1 ? worstCaseSeparation(mains) : Infinity,
    cvdSafe,
    profile: m.profile ?? 'cwi-1.0',
  };
}

export interface ValidationOut {
  issues: Issue[];
  errors: number;
  warnings: number;
  ok: boolean;
}

export function validateManifest(m: CwiManifest, opts?: Partial<CwiOptions>): ValidationOut {
  const issues = validate(m, opts);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  return { issues, errors, warnings, ok: errors === 0 };
}

export interface StatRow {
  id: string;
  name: string;
  tier: string;
  color?: string;
  words: number;
  seconds: number;
  share: number;
}

export function stats(m: CwiManifest): { rows: StatRow[]; totalSeconds: number; totalWords: number } {
  const s = speakerStats(m.cues);
  const byId = new Map(m.characters.map((c) => [c.id, c]));
  const totalSeconds = [...s.values()].reduce((n, v) => n + v.seconds, 0);
  const totalWords = [...s.values()].reduce((n, v) => n + v.words, 0);
  const rows = [...s]
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .map(([id, v]): StatRow => {
      const c = byId.get(id);
      return {
        id,
        name: c?.name ?? id,
        tier: c?.tier ?? 'unknown',
        color: c?.color,
        words: v.words,
        seconds: +v.seconds.toFixed(2),
        share: totalSeconds ? +(v.seconds / totalSeconds).toFixed(4) : 0,
      };
    });
  return { rows, totalSeconds: +totalSeconds.toFixed(2), totalWords };
}

export interface PaletteRow {
  mode: string;
  collisions: Array<{ a: string; b: string; deltaE: number }>;
}

/** Audit the spec's own palette, independent of any manifest. */
export function auditPalette(floor = DELTA_E_FLOOR): {
  rows: PaletteRow[];
  contrast: Array<{ name: string; hex: string; ratio: number; passesAA: boolean }>;
} {
  const modes: Array<string> = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];
  const rows = modes.map((mode): PaletteRow => {
    const sim = (hex: string) => (mode === 'normal' ? hex : simulateCvd(hex, mode as CvdType));
    const collisions: PaletteRow['collisions'] = [];
    for (let i = 0; i < MAIN_COLORS.length; i++) {
      for (let j = i + 1; j < MAIN_COLORS.length; j++) {
        const d = deltaE(sim(MAIN_COLORS[i].hex), sim(MAIN_COLORS[j].hex));
        if (d < floor) {
          collisions.push({
            a: MAIN_COLORS[i].name.replace('CI Main ', ''),
            b: MAIN_COLORS[j].name.replace('CI Main ', ''),
            deltaE: +d.toFixed(1),
          });
        }
      }
    }
    return { mode, collisions };
  });

  const contrast = MAIN_COLORS.map((s) => {
    const ratio = +contrastRatio(s.hex, '#1A1A1A').toFixed(2);
    return { name: s.name, hex: s.hex, ratio, passesAA: ratio >= 4.5 };
  });
  return { rows, contrast };
}

/**
 * Acoustics -> typography for a single hypothetical word. Pure; no files.
 * Exposed mainly so an agent can reason about what a measurement will look
 * like without running a whole analysis.
 */
export function resolveTypography(
  acoustics: { db?: number; f0?: number; centroid?: number },
  options?: Partial<CwiOptions>,
) {
  const o = withDefaults(options);
  const style = resolveToken({ text: '', start: 0, end: 1, ...acoustics }, o);
  return {
    ...style,
    explanation: {
      size: `${style.size.toFixed(2)}% of frame height (spec baseline ${o.baselineSizePct}%, range ${o.minSizePct}–${o.maxSizePct}%)`,
      wght: `Roboto Flex wght ${style.wght} (spec neutral ${o.baselineWeight} for ${o.neutralF0[0]}–${o.neutralF0[1]} Hz)`,
      wdth: `Roboto Flex wdth ${style.wdth} (normal ${o.baselineWidth})`,
    },
  };
}

export type ExportFormat = 'vtt' | 'ass';

export function exportCaptions(
  m: CwiManifest,
  format: ExportFormat,
  opts: { frameHeight?: number; frameWidth?: number } = {},
): { content: string; lost: string[]; format: ExportFormat } {
  if (format === 'vtt') {
    const { vtt, lost } = toVtt(m);
    return { content: vtt, lost, format };
  }
  const h = opts.frameHeight ?? 1080;
  const w = opts.frameWidth ?? Math.round((h * 16) / 9);
  const { ass, lost } = toAss(m, undefined, h, w);
  return { content: ass, lost, format };
}

// --------------------------------------------------------------------------
// Python pipeline bridge
// --------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the Python pipeline.
 *
 * Checked in order: an explicit override, the copy bundled inside this package
 * (published installs), then upward from here (working in the repo). Nothing
 * sits above node_modules, so the bundled copy is what makes `analyze` and
 * `scene` work for anyone who installed from the registry.
 */
export function findPipeline(): string {
  if (process.env.CWI_PIPELINE) return process.env.CWI_PIPELINE;

  const bundled = join(here, '..', 'pipeline');            // dist/.. -> package root
  if (existsSync(join(bundled, 'analyze.py'))) return bundled;

  let dir = here;
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'pipeline');
    if (existsSync(join(p, 'analyze.py'))) return p;
    dir = dirname(dir);
  }
  throw new CwiError(
    'Could not locate the Python pipeline.',
    'Set CWI_PIPELINE to the directory containing analyze.py.',
  );
}

export function findPython(): string {
  if (process.env.CWI_PYTHON) return process.env.CWI_PYTHON;

  // Walk up from the pipeline looking for a venv. One level is not enough: in
  // a workspace the pipeline may resolve to the copy bundled inside the
  // package, whose parent has no .venv, and we would silently fall through to
  // a bare `python3` that lacks numpy.
  let dir = findPipeline();
  for (let i = 0; i < 5; i++) {
    for (const c of [join(dir, '.venv', 'bin', 'python'), join(dir, '.venv', 'Scripts', 'python.exe')]) {
      if (existsSync(c)) return c;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return 'python3';
}

/**
 * Check the Python side is usable before blaming the user's inputs.
 *
 * `analyze` needs Python with numpy and ffmpeg on PATH. Reporting that up front
 * is far kinder than a traceback from a subprocess three layers down.
 */
export async function checkPipelineEnv(): Promise<{ ok: boolean; python: string; numpy: boolean; ffmpeg: boolean; detail: string[] }> {
  const py = findPython();
  const detail: string[] = [];
  let numpy = false;
  try {
    const { stdout } = await run(py, ['-c', 'import numpy; print(numpy.__version__)']);
    numpy = true;
    detail.push(`numpy ${stdout.trim()}`);
  } catch {
    detail.push(`numpy missing for ${py}`);
  }
  let ffmpeg = false;
  try {
    await run('ffmpeg', ['-version']);
    ffmpeg = true;
    detail.push('ffmpeg found');
  } catch {
    detail.push('ffmpeg not on PATH');
  }
  return { ok: numpy && ffmpeg, python: py, numpy, ffmpeg, detail };
}

async function python(script: string, args: string[]): Promise<string> {
  const pipeline = findPipeline();
  const env = await checkPipelineEnv();
  if (!env.ok) {
    throw new CwiError(
      `The analysis environment is not ready: ${env.detail.join('; ')}.`,
      env.numpy
        ? 'Install ffmpeg (brew install ffmpeg / apt install ffmpeg).'
        : `Install numpy for ${env.python}, or set CWI_PYTHON to an interpreter that has it.`,
    );
  }
  try {
    const { stdout } = await run(findPython(), [join(pipeline, script), ...args], {
      cwd: pipeline,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new CwiError(
      `${script} failed: ${(err.stderr || err.message).trim().split('\n').slice(-4).join('\n')}`,
      'Run `npm run setup:py` if the environment is missing, then retry.',
    );
  }
}

/**
 * Minimum Node for the browser-backed commands.
 *
 * playwright-core requires Node 20+ and enforces it by calling process.exit —
 * not by throwing — so importing it on Node 18 kills the process outright and
 * cannot be caught. Every path that might import it has to check first.
 * Everything else in this toolchain still works on Node 18.
 */
export const BROWSER_MIN_NODE = 20;

export function browserSupported(): boolean {
  return Number(process.versions.node.split('.')[0]) >= BROWSER_MIN_NODE;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  needed: string;
  fix?: string;
}

/**
 * Report which capabilities are actually available.
 *
 * Most of this toolchain is pure Node, but `analyze` needs Python with numpy
 * and `render` needs ffmpeg plus a headless browser. Discovering that three
 * minutes into a render is a poor experience, and the failure surfaces as a
 * subprocess error that says nothing useful about the cause.
 */
export async function doctor(): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const checks: DoctorCheck[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node', ok: major >= 18, needed: 'everything',
    detail: `v${process.versions.node}`,
    fix: major >= 18 ? undefined : 'Node 18 or newer is required.',
  });

  for (const [bin, needed] of [['ffmpeg', 'render, analyze'], ['ffprobe', 'render, analyze']] as const) {
    try {
      const { stdout } = await run(bin, ['-version']);
      checks.push({ name: bin, ok: true, needed, detail: stdout.split('\n')[0].slice(0, 48) });
    } catch {
      checks.push({
        name: bin, ok: false, needed, detail: 'not on PATH',
        fix: 'brew install ffmpeg   /   apt install ffmpeg',
      });
    }
  }

  let pipeline = '';
  try {
    pipeline = findPipeline();
    const bundled = pipeline.includes(`${sep}packages${sep}@corerus/chorus-cli${sep}pipeline`);
    checks.push({
      name: 'pipeline', ok: true, needed: 'analyze, scene',
      detail: pipeline + (bundled ? '  (bundled copy)' : ''),
    });
  } catch (e) {
    checks.push({
      name: 'pipeline', ok: false, needed: 'analyze, scene',
      detail: (e as Error).message, fix: 'Set CWI_PIPELINE to the directory holding analyze.py.',
    });
  }

  if (pipeline) {
    const py = findPython();
    try {
      const { stdout } = await run(py, ['-c', 'import numpy,sys; print(numpy.__version__, sys.version.split()[0])']);
      const [np, ver] = stdout.trim().split(' ');
      checks.push({ name: 'python+numpy', ok: true, needed: 'analyze, scene', detail: `${py} (py ${ver}, numpy ${np})` });
    } catch {
      checks.push({
        name: 'python+numpy', ok: false, needed: 'analyze, scene',
        detail: `${py} cannot import numpy`,
        fix: 'npm run setup:py   (or set CWI_PYTHON to an interpreter that has numpy)',
      });
    }
  }

  if (!browserSupported()) {
    checks.push({
      name: 'browser', ok: false, needed: 'render, deliver',
      detail: `Node ${process.versions.node} — playwright needs ${BROWSER_MIN_NODE}+`,
      fix: `Upgrade to Node ${BROWSER_MIN_NODE} or newer. Everything except render and deliver works on this version.`,
    });
    return { checks, ok: checks.every((c) => c.ok) };
  }
  try {
    const { chromium } = await import('playwright-core');
    const b = await chromium.launch({ headless: true });
    const v = b.version();
    await b.close();
    checks.push({ name: 'browser', ok: true, needed: 'render, deliver', detail: `chromium ${v}` });
  } catch (e) {
    checks.push({
      name: 'browser', ok: false, needed: 'render, deliver',
      detail: String((e as Error).message).split('\n')[0].slice(0, 60),
      fix: 'npm i playwright-core && npx playwright install chromium',
    });
  }

  return { checks, ok: checks.every((c) => c.ok) };
}

export interface AnalyzeInput {
  media: string;
  out: string;
  transcript?: string;
  vtt?: string;
  whisperx?: boolean;
  hfToken?: string;
  pitchMode?: 'voice' | 'word' | 'raw';
  maxGap?: number;
  maxCue?: number;
  maxChars?: number;
}

/** media + transcript -> manifest. Colours are NOT assigned; run `assign` next. */
export async function analyzeMedia(input: AnalyzeInput): Promise<{ manifest: CwiManifest; out: string; log: string }> {
  // Check inputs here rather than letting Python surface a traceback. A missing
  // file is the most common mistake and deserves a one-line answer.
  requireFile(input.media, 'media file');
  const a = ['--media', abs(input.media), '--out', abs(input.out)];
  if (input.transcript) { requireFile(input.transcript, 'transcript'); a.push('--transcript', abs(input.transcript)); }
  else if (input.vtt) { requireFile(input.vtt, 'WebVTT file'); a.push('--vtt', abs(input.vtt)); }
  else if (input.whisperx) a.push('--whisperx');
  else throw new CwiError('analyze needs one of --transcript, --vtt or --whisperx.');
  if (input.hfToken) a.push('--hf-token', input.hfToken);
  if (input.pitchMode) a.push('--pitch-mode', input.pitchMode);
  if (input.maxGap != null) a.push('--max-gap', String(input.maxGap));
  if (input.maxCue != null) a.push('--max-cue', String(input.maxCue));
  if (input.maxChars != null) a.push('--max-chars', String(input.maxChars));

  const log = await python('analyze.py', a);
  return { manifest: readManifest(abs(input.out)), out: abs(input.out), log: log.trim() };
}

export interface SceneInput {
  spec: string;
  out: string;
  /** Also composite every speaker into ONE frame, rather than cutting between them. */
  composeVideo?: string;
  /** Intermediate concatenated cut; required by the manifest build. */
  outVideo?: string;
  pitchMode?: 'voice' | 'word' | 'raw';
}

/** Multi-speaker scene: merge per-character renders, optionally composite them. */
export async function buildScene(input: SceneInput): Promise<{ manifest: CwiManifest; out: string; video?: string; log: string }> {
  requireFile(input.spec, 'scene spec');
  const cut = abs(input.outVideo ?? input.out.replace(/\.cwi\.json$|\.json$/, '') + '.cut.mp4');
  const a = [abs(input.spec), '--out-video', cut, '--out', abs(input.out)];
  if (input.pitchMode) a.push('--pitch-mode', input.pitchMode);
  let log = await python('build_scene.py', a);

  let video = cut;
  if (input.composeVideo) {
    video = abs(input.composeVideo);
    log += await python('compose_scene.py', [abs(input.spec), '--out', video]);
  }
  return { manifest: readManifest(abs(input.out)), out: abs(input.out), video, log: log.trim() };
}

function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function requireFile(p: string, what: string): void {
  if (!existsSync(abs(p))) throw new CwiError(`No such ${what}: ${p}`);
}

export { SUPPORTING_COLORS, MAIN_COLORS };
