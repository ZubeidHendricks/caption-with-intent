/**
 * Render conformance.
 *
 * The vector suite in `conformance/vectors` checks *computation*: given these
 * acoustics, what type size. Every one of those can pass while the picture on
 * screen is wrong — words revealed at the wrong moment, a speaker drawn in
 * another speaker's colour, a line reflowing under the pop. Nothing in this
 * project checked the picture until now, which meant an integrator could
 * legitimately claim conformance for a renderer that fails the reader.
 *
 * This checks the picture, without requiring the renderer to be ours or even
 * to be a browser. An implementation reports what it drew — one record per
 * token per sampled instant — and the checker compares that against what the
 * manifest says it should have drawn. A Swift player, a shader, an NLE plugin
 * and a web renderer can all emit the same report.
 *
 * Levels, because "conformant" is otherwise unfalsifiable:
 *
 *   A    attribution and synchronisation — the mechanic the design exists for.
 *        Fail this and the captions actively mislead about who spoke.
 *   AA   the acoustics-to-typography mapping, within tolerance.
 *   AAA  layout discipline: no reflow, line limits, safe area, and a second
 *        non-colour attribution channel where the profile provides one.
 *
 * A implies nothing about AA; they are reported independently, and the awarded
 * level is the highest with no failures at it or below.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveToken, withDefaults, deltaE, getProfile,
  type CwiManifest, type Token, type Cue, type Character,
} from '@corerus/chorus-core';
import { CwiError } from './ops.js';

const here = dirname(fileURLToPath(import.meta.url));

// --- the report contract ---------------------------------------------------

/** One token as it was actually drawn, at one instant. */
export interface ReportToken {
  text: string;
  /** Has this word been reached by the playhead? Drives the reveal. */
  spoken: boolean;
  /** Rendered type size in device pixels. */
  sizePx: number;
  /** Rendered fill colour, as #rrggbb or rgb(); compared perceptually. */
  colour: string;
  /**
   * Variable font axes as rendered. Omitting them forfeits AA rather than
   * failing A: a static face is a real deployment constraint, but it cannot
   * carry intonation and should not be certified as though it does.
   */
  wght?: number;
  wdth?: number;
  /**
   * Layout position of the token box in device pixels, ignoring any transform.
   * A pop that moves the layout box is a reflow.
   */
  leftPx: number;
  topPx: number;
}

export interface ReportSample {
  t: number;
  tokens: ReportToken[];
  /** Number of text lines drawn for the active cue. */
  lineCount?: number;
  /** The caption block's bounding box in device pixels. */
  box?: { left: number; top: number; width: number; height: number };
  /**
   * Non-colour speaker marks actually drawn, if the profile uses them. Read
   * from the report rather than the manifest on purpose: an implementation
   * that silently drops the marks would otherwise be credited with them.
   */
  marks?: string[];
}

export interface RenderReport {
  cwiRenderReport: '1.0';
  implementation: string;
  scene: string;
  frame: { w: number; h: number };
  samples: ReportSample[];
}

export interface RenderScene {
  id: string;
  title: string;
  why: string;
  frame: { w: number; h: number };
  /** Instants to sample, in seconds. */
  samples: number[];
  manifest: CwiManifest;
}

export type Level = 'A' | 'AA' | 'AAA';

export interface RenderCheck {
  id: string;
  level: Level;
  spec: string | null;
  title: string;
  ok: boolean;
  detail?: string;
  /** Set when the implementation declined to report the inputs a check needs. */
  skipped?: boolean;
}

export interface RenderConformResult {
  scene: string;
  implementation: string;
  checks: RenderCheck[];
  byLevel: Record<Level, { passed: number; total: number; skipped: number }>;
  /** Highest level fully met. Null if A is not met. */
  level: Level | null;
  ok: boolean;
}

// --- tolerances ------------------------------------------------------------

/**
 * Type size, as a fraction of the expected size. Sub-pixel rounding, hinting
 * and a host's device-pixel-ratio all move this slightly; 2% sits far inside
 * the steps of the 3–12% range, so a real mapping error still fails.
 */
const SIZE_TOL = 0.02;
const SIZE_TOL_PX = 1;
/** Variable axis tolerance. Renderers quantise weight; 10 is under one step. */
const WGHT_TOL = 10;
const WDTH_TOL = 5;
/**
 * Colour. Delta-E 3 is around the just-noticeable difference, so anything
 * inside it is the same colour to a viewer, and anything outside is not.
 */
const COLOUR_TOL = 3;
/** Layout drift that counts as a reflow. Half a pixel is rounding. */
const REFLOW_TOL_PX = 0.5;

// --- scene loading ---------------------------------------------------------

export function findRenderScenes(): string {
  if (process.env.CWI_RENDER_SCENES) return process.env.CWI_RENDER_SCENES;
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'conformance', 'render', 'scenes');
    if (existsSync(p)) return p;
    dir = dirname(dir);
  }
  throw new CwiError('Could not locate the render conformance scenes.',
    'Set CWI_RENDER_SCENES to the directory containing the scene JSON files.');
}

export function loadScenes(): RenderScene[] {
  const dir = findRenderScenes();
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RenderScene);
}

export function loadScene(id: string): RenderScene {
  const all = loadScenes();
  const found = all.find((s) => s.id === id);
  if (!found) {
    throw new CwiError(`No render scene "${id}".`,
      `Available: ${all.map((s) => s.id).join(', ')}`);
  }
  return found;
}

// --- what the manifest says should be drawn --------------------------------

/** The cue live at `t`, or null. Ties go to the later cue, as the renderer does. */
export function cueAt(m: CwiManifest, t: number): Cue | null {
  let live: Cue | null = null;
  for (const c of m.cues) if (t >= c.start && t < c.end) live = c;
  return live;
}

function tokensOf(cue: Cue): Token[] {
  return cue.lines.flatMap((l) => l.tokens);
}

// --- the checks ------------------------------------------------------------

export function checkReport(scene: RenderScene, report: RenderReport): RenderConformResult {
  const m = scene.manifest;
  const opts = withDefaults(m.options ?? {});
  const chars = new Map<string, Character>(m.characters.map((c) => [c.id, c]));
  const checks: RenderCheck[] = [];
  const add = (
    id: string, level: Level, spec: string | null, title: string,
    ok: boolean, detail?: string, skipped?: boolean,
  ) => { checks.push({ id, level, spec, title, ok, detail, skipped }); };

  const byT = new Map(report.samples.map((s) => [round3(s.t), s]));
  const missing = scene.samples.filter((t) => !byT.has(round3(t)));
  if (missing.length) {
    throw new CwiError(
      `The report is missing ${missing.length} of ${scene.samples.length} required samples.`,
      `Scene "${scene.id}" must be sampled at: ${scene.samples.join(', ')}`);
  }
  if (report.frame.w !== scene.frame.w || report.frame.h !== scene.frame.h) {
    throw new CwiError(
      `The report was produced at ${report.frame.w}x${report.frame.h}, not the scene's ${scene.frame.w}x${scene.frame.h}.`,
      'Type size is a percentage of frame height, so a mismatched frame makes every size check meaningless.');
  }

  // --- A1 the right words, in the right order ------------------------------
  const wrongText: string[] = [];
  for (const t of scene.samples) {
    const s = byT.get(round3(t))!;
    const cue = cueAt(m, t);
    const want = cue ? tokensOf(cue).map((k) => k.text) : [];
    const got = s.tokens.map((k) => k.text);
    if (want.join(' ') !== got.join(' ')) {
      wrongText.push(`t=${t}: expected [${want.join(' ')}], drew [${got.join(' ')}]`);
    }
  }
  add('R-A1', 'A', '2.2', "the active cue's words are drawn, in order",
    wrongText.length === 0, wrongText.slice(0, 3).join('; '));

  // --- A2 word-level synchronisation ---------------------------------------
  // The whole design rests on this. A renderer that reveals per line rather
  // than per word passes every computational vector and fails the reader.
  const desync: string[] = [];
  let anyReveal = false;
  for (const t of scene.samples) {
    const s = byT.get(round3(t))!;
    const cue = cueAt(m, t);
    if (!cue) continue;
    const want = tokensOf(cue);
    if (want.length !== s.tokens.length) continue;          // already failed A1
    want.forEach((k, i) => {
      const expected = t >= k.start;
      if (s.tokens[i].spoken !== expected) {
        desync.push(`t=${t} "${k.text}" (starts ${k.start}) reported ${s.tokens[i].spoken ? 'spoken' : 'unspoken'}`);
      }
    });
    if (new Set(s.tokens.map((k) => k.spoken)).size > 1) anyReveal = true;
  }
  add('R-A2', 'A', '2.2', 'each word turns over at its own onset',
    desync.length === 0, desync.slice(0, 3).join('; '));
  add('R-A3', 'A', '2.2', 'the reveal is per word, not per line',
    anyReveal, anyReveal ? undefined
      : 'no sample showed a partially-revealed line, so the line is turning over as a block');

  // The flags can be perfect while the picture never changes. A renderer that
  // tracks the playhead internally and draws every word identically reports a
  // clean R-A2 and gives the reader nothing.
  let visibleReveal = false;
  for (const t of scene.samples) {
    const s = byT.get(round3(t))!;
    const spoken = s.tokens.filter((k) => k.spoken);
    const unspoken = s.tokens.filter((k) => !k.spoken);
    if (!spoken.length || !unspoken.length) continue;
    if (differs(spoken[0].colour, unspoken[0].colour)) { visibleReveal = true; break; }
  }
  add('R-A6', 'A', '2.2', 'a spoken word looks different from one not yet spoken',
    visibleReveal,
    visibleReveal ? undefined
      : 'spoken and unspoken words were drawn identically, so the reveal exists only in the report');

  // --- A4 attribution by colour --------------------------------------------
  const miscoloured: string[] = [];
  for (const t of scene.samples) {
    const s = byT.get(round3(t))!;
    const cue = cueAt(m, t);
    if (!cue || cue.kind !== 'dialogue') continue;
    const ch = cue.speaker ? chars.get(cue.speaker) : undefined;
    if (!ch?.color) continue;
    // Spoken words only. A word not yet reached is deliberately neutral until
    // the playhead arrives — that turn from neutral to the speaker's colour is
    // the attribution event, and holding read-ahead text to the speaker colour
    // would fail every conformant renderer.
    for (const k of s.tokens.filter((x) => x.spoken)) {
      const d = safeDeltaE(k.colour, ch.color);
      if (d === null) { miscoloured.push(`t=${t} unreadable colour "${k.colour}"`); continue; }
      if (d > COLOUR_TOL) {
        miscoloured.push(`t=${t} "${k.text}" drew ${k.colour}, ${ch.name ?? ch.id} is ${ch.color} (deltaE ${d.toFixed(1)})`);
      }
    }
  }
  add('R-A4', 'A', '2.1', "dialogue is drawn in its speaker's assigned colour",
    miscoloured.length === 0, miscoloured.slice(0, 3).join('; '));

  // --- A5 speakers do not collide on screen --------------------------------
  // Two characters assigned distinct colours must reach the screen distinct.
  // A renderer that clamps to a web-safe palette, or applies a display LUT,
  // passes A4 cue by cue and still makes two speakers identical.
  const drawn = new Map<string, string>();
  for (const t of scene.samples) {
    const cue = cueAt(m, t);
    if (!cue?.speaker || cue.kind !== 'dialogue') continue;
    const s = byT.get(round3(t))!;
    const first = s.tokens.find((k) => k.spoken);
    if (first) drawn.set(cue.speaker, first.colour);
  }
  const collisions: string[] = [];
  const ids = [...drawn.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const d = safeDeltaE(drawn.get(ids[i])!, drawn.get(ids[j])!);
      if (d !== null && d <= COLOUR_TOL) {
        collisions.push(`${ids[i]} and ${ids[j]} both drew ${drawn.get(ids[i])}`);
      }
    }
  }
  add('R-A5', 'A', '2.1', 'distinct speakers reach the screen distinct',
    collisions.length === 0, collisions.slice(0, 3).join('; '));

  // --- AA typography -------------------------------------------------------
  const sizeErr: string[] = [];
  const wghtErr: string[] = [];
  const wdthErr: string[] = [];
  let reportedAxes = false;
  for (const t of scene.samples) {
    const s = byT.get(round3(t))!;
    const cue = cueAt(m, t);
    if (!cue) continue;
    const want = tokensOf(cue);
    if (want.length !== s.tokens.length) continue;
    want.forEach((k, i) => {
      const style = resolveToken(k, opts);
      const got = s.tokens[i];
      const wantPx = (style.size / 100) * scene.frame.h;
      if (Math.abs(got.sizePx - wantPx) > Math.max(SIZE_TOL_PX, wantPx * SIZE_TOL)) {
        sizeErr.push(`t=${t} "${k.text}" ${got.sizePx.toFixed(1)}px, expected ${wantPx.toFixed(1)}px`);
      }
      if (got.wght !== undefined) {
        reportedAxes = true;
        if (Math.abs(got.wght - style.wght) > WGHT_TOL) {
          wghtErr.push(`t=${t} "${k.text}" wght ${got.wght}, expected ${style.wght}`);
        }
      }
      if (got.wdth !== undefined && Math.abs(got.wdth - style.wdth) > WDTH_TOL) {
        wdthErr.push(`t=${t} "${k.text}" wdth ${got.wdth}, expected ${style.wdth}`);
      }
    });
  }
  add('R-B1', 'AA', '2.3.4', 'type size follows loudness, as a percentage of frame height',
    sizeErr.length === 0, sizeErr.slice(0, 3).join('; '));
  add('R-B2', 'AA', '2.3.8', 'the weight axis follows pitch',
    wghtErr.length === 0,
    reportedAxes ? wghtErr.slice(0, 3).join('; ')
      : 'no variable axes reported, and a static face cannot carry intonation',
    !reportedAxes);
  add('R-B3', 'AA', '2.3.8', 'the width axis follows timbre',
    wdthErr.length === 0,
    reportedAxes ? wdthErr.slice(0, 3).join('; ') : 'no variable axes reported', !reportedAxes);

  // --- AAA layout discipline ----------------------------------------------
  // No reflow. The pop is a scale about a token's own centre; if it moves the
  // layout box, every other word on the line shifts under the reader's eye
  // mid-sentence. Hardest thing here to get right, most obvious when wrong.
  const reflow: string[] = [];
  const byCue = new Map<Cue, ReportSample[]>();
  for (const t of scene.samples) {
    const cue = cueAt(m, t);
    if (!cue) continue;
    const list = byCue.get(cue) ?? [];
    list.push(byT.get(round3(t))!);
    byCue.set(cue, list);
  }
  for (const [cue, samples] of byCue) {
    if (samples.length < 2) continue;
    const first = samples[0];
    for (const s of samples.slice(1)) {
      if (s.tokens.length !== first.tokens.length) continue;
      s.tokens.forEach((k, i) => {
        const dx = Math.abs(k.leftPx - first.tokens[i].leftPx);
        const dy = Math.abs(k.topPx - first.tokens[i].topPx);
        if (dx > REFLOW_TOL_PX || dy > REFLOW_TOL_PX) {
          reflow.push(`cue ${cue.id} "${k.text}" moved ${dx.toFixed(1)},${dy.toFixed(1)}px between t=${first.t} and t=${s.t}`);
        }
      });
    }
  }
  add('R-C1', 'AAA', '2.3.7', 'the emphasis pop never reflows the line',
    reflow.length === 0, reflow.slice(0, 3).join('; '));

  const reportedLines = report.samples.some((s) => s.lineCount !== undefined);
  const overLine = scene.samples
    .map((t) => byT.get(round3(t))!)
    .filter((s) => (s.lineCount ?? 0) > opts.maxLines)
    .map((s) => `t=${s.t}: ${s.lineCount} lines`);
  add('R-C2', 'AAA', '2.4', `no more than ${opts.maxLines} lines are on screen at once`,
    overLine.length === 0, reportedLines ? overLine.slice(0, 3).join('; ') : 'no line counts reported',
    !reportedLines);

  // Safe area. Captions that run under a broadcaster's bug, into an overscan
  // margin or off a phone's rounded corner are unreadable for reasons that
  // have nothing to do with the design.
  const reportedBox = report.samples.some((s) => s.box !== undefined);
  const sa = opts.safeArea;
  const minL = (sa.left / 100) * scene.frame.w - 1;
  const maxR = scene.frame.w - (sa.right / 100) * scene.frame.w + 1;
  const maxB = scene.frame.h - (sa.bottom / 100) * scene.frame.h + 1;
  const outside = report.samples
    .filter((s) => s.box && (s.box.left < minL
      || s.box.left + s.box.width > maxR
      || s.box.top + s.box.height > maxB))
    .map((s) => `t=${s.t}: box ${Math.round(s.box!.left)}..${Math.round(s.box!.left + s.box!.width)}`
      + ` x ${Math.round(s.box!.top + s.box!.height)}`);
  add('R-C3', 'AAA', '2.4', 'the caption block stays inside the safe area',
    outside.length === 0, reportedBox ? outside.slice(0, 3).join('; ') : 'no caption box reported',
    !reportedBox);

  // --- AAA a second, non-colour attribution channel ------------------------
  // WCAG 2.2 SC 1.4.1 is assessed per pair of speakers, so this asks whether
  // every pair is separable without colour, not merely whether a channel exists.
  const profile = getProfile(m.profile);
  if (profile.attribution.some((c) => c !== 'colour')) {
    const spots = new Map<string, string>();
    for (const t of scene.samples) {
      const cue = cueAt(m, t);
      if (!cue?.speaker || cue.kind !== 'dialogue') continue;
      const s = byT.get(round3(t))!;
      // Both read off what was drawn, not off what the manifest asked for.
      const spot = s.box ? bucket(s.box.left + s.box.width / 2, scene.frame.w) : '?';
      spots.set(cue.speaker, `${spot}/${(s.marks ?? []).join('')}`);
    }
    const same: string[] = [];
    const keys = [...spots.keys()];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (spots.get(keys[i]) === spots.get(keys[j])) {
          same.push(`${keys[i]} and ${keys[j]} are separable only by colour`);
        }
      }
    }
    const unreadable = spots.size === 0 || [...spots.values()].some((v) => v.startsWith('?/'));
    add('R-C4', 'AAA', 'WCAG 2.2 SC 1.4.1',
      'every pair of speakers is separable without colour',
      same.length === 0 && !unreadable,
      unreadable ? 'no caption box reported, so position could not be read'
        : same.slice(0, 3).join('; '),
      unreadable);
  }

  return summarise(scene.id, report.implementation, checks);
}

/** Which third of the frame the caption sits in. */
function bucket(centre: number, w: number): 'left' | 'center' | 'right' {
  if (centre < w * 0.4) return 'left';
  if (centre > w * 0.6) return 'right';
  return 'center';
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function safeDeltaE(a: string, b: string): number | null {
  try { return deltaE(toHex(a), toHex(b)); } catch { return null; }
}

/**
 * Are these two visibly different? Alpha counts: a renderer may distinguish
 * read-ahead text by opacity alone, which is dimmer but not another hue.
 */
function differs(a: string, b: string): boolean {
  const d = safeDeltaE(a, b);
  if (d !== null && d > COLOUR_TOL) return true;
  return Math.abs(alphaOf(a) - alphaOf(b)) >= 0.05;
}

function alphaOf(c: string): number {
  const m = String(c).match(/^rgba\(\s*[\d.]+[,\s]+[\d.]+[,\s]+[\d.]+[,\s/]+([\d.]+)/i);
  return m ? Number(m[1]) : 1;
}

/** Accept the shapes a renderer actually reports: #rgb, #rrggbb, rgb(). */
export function toHex(c: string): string {
  const s = String(c).trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${[...s.slice(1)].map((x) => x + x).join('')}`.toLowerCase();
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map((v) => Math.round(Number(v)));
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new CwiError(`Cannot read the colour "${c}".`,
    'Report colours as #rrggbb or rgb(r, g, b).');
}

function summarise(scene: string, implementation: string, checks: RenderCheck[]): RenderConformResult {
  const byLevel = {
    A: { passed: 0, total: 0, skipped: 0 },
    AA: { passed: 0, total: 0, skipped: 0 },
    AAA: { passed: 0, total: 0, skipped: 0 },
  } as Record<Level, { passed: number; total: number; skipped: number }>;
  for (const c of checks) {
    const b = byLevel[c.level];
    b.total++;
    if (c.skipped) b.skipped++;
    else if (c.ok) b.passed++;
  }
  // A skipped check forfeits its level. An implementation reporting no
  // variable axes is not AA, even though nothing it did was wrong.
  const complete = (l: Level) => checks.filter((c) => c.level === l).every((c) => c.ok && !c.skipped);
  const clean = (l: Level) => checks.filter((c) => c.level === l).every((c) => c.ok || c.skipped);

  let level: Level | null = null;
  if (complete('A')) level = 'A';
  if (level === 'A' && complete('AA')) level = 'AA';
  if (level === 'AA' && complete('AAA')) level = 'AAA';

  return { scene, implementation, checks, byLevel, level, ok: clean('A') };
}
