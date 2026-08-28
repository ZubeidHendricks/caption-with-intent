/**
 * Conformance runner.
 *
 * Executes the JSON vectors in `conformance/vectors` against an implementation.
 * The vectors are the artifact that matters — they are plain data so a Rust,
 * Swift or shader implementation can consume them without running any of this.
 * This runner exists so the reference implementation is held to the same bar,
 * and so a JavaScript implementation gets the check for free.
 *
 * Normative failures are errors: the expected value is fixed by the published
 * spec and cited by section. Informative failures are reported separately and
 * do not fail the run — the spec is silent there, and an implementation is
 * free to differ as long as it does so knowingly.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CwiError } from './ops.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface VectorCase {
  name?: string;
  note?: string;
  input?: unknown;
  field?: string;
  expect?: Record<string, unknown>;
  tolerance?: number;
  manifest?: unknown;
  expectCode?: string;
  expectSeverity?: string;
}

export interface Vector {
  id: string;
  area: string;
  spec: string | null;
  normative: boolean;
  title: string;
  why: string;
  fn: string;
  property?: 'monotonic-nondecreasing' | 'monotonic-nonincreasing' | 'in-range';
  bounds?: Record<string, [number, number]>;
  expect?: Record<string, unknown>;
  cases?: VectorCase[];
}

export interface CaseResult { vector: string; case: string; ok: boolean; detail?: string }

export interface ConformResult {
  total: number;
  passed: number;
  normativeFailures: CaseResult[];
  informativeFailures: CaseResult[];
  byArea: Record<string, { passed: number; total: number }>;
  ok: boolean;
  implementation: string;
}

/** Walk up for the conformance directory; it is not part of any package. */
export function findVectors(): string {
  if (process.env.CWI_VECTORS) return process.env.CWI_VECTORS;
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'conformance', 'vectors');
    if (existsSync(p)) return p;
    dir = dirname(dir);
  }
  throw new CwiError('Could not locate the conformance vectors.',
    'Set CWI_VECTORS to the directory containing the vector JSON files.');
}

interface Impl {
  resolveToken?: (t: unknown, o?: unknown) => Record<string, number>;
  assignColors?: (c: unknown[], o?: unknown) => { characters: Array<Record<string, unknown>> };
  validate?: (m: unknown) => Array<{ code: string; severity: string }>;
  MAIN_COLORS?: Array<{ hex: string }>;
  SUPPORTING_COLORS?: unknown[];
  MINOR_HUES?: readonly number[];
  MINOR_SATURATION?: number;
  MINOR_BRIGHTNESS?: number;
  simulateCvd?: (hex: string, t: string) => string;
  deltaE?: (a: string, b: string) => number;
  contrastRatio?: (a: string, b: string) => number;
  hexHue?: (hex: string) => number;
  hueDistance?: (a: number, b: number) => number;
}

const near = (a: number, b: number, tol = 0.001) => Math.abs(a - b) <= tol;

/**
 * Run the suite against an implementation.
 *
 * Accepts a module path, or the module object itself. The object form is what
 * lets the mutant tests hold a dozen deliberately-broken implementations in one
 * file rather than a dozen files on disk.
 */
export async function conform(implementation?: string | Record<string, unknown>): Promise<ConformResult> {
  const impl: Impl =
    typeof implementation === 'object' && implementation !== null
      ? (implementation as Impl)
      : implementation
        ? await import(pathToFileURL(implementation).href)
        : await import('@chorus/core');
  const label = typeof implementation === 'string' ? implementation
    : implementation ? '(supplied module)' : '@chorus/core (reference)';

  const dir = findVectors();
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const results: CaseResult[] = [];
  const vectors: Vector[] = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));

  for (const v of vectors) {
    const push = (name: string, ok: boolean, detail?: string) =>
      results.push({ vector: `${v.id}${v.normative ? '' : ' (informative)'}`, case: name, ok, detail });

    try {
      runVector(v, impl, push);
    } catch (e) {
      push('vector', false, `threw: ${(e as Error).message}`);
    }
  }

  const byArea: ConformResult['byArea'] = {};
  for (const v of vectors) {
    byArea[v.area] ??= { passed: 0, total: 0 };
  }
  const vectorArea = new Map(vectors.map((v) => [`${v.id}${v.normative ? '' : ' (informative)'}`, v]));
  for (const r of results) {
    const v = vectorArea.get(r.vector);
    if (!v) continue;
    byArea[v.area].total++;
    if (r.ok) byArea[v.area].passed++;
  }

  const failures = results.filter((r) => !r.ok);
  const normativeFailures = failures.filter((r) => !r.vector.includes('informative'));
  const informativeFailures = failures.filter((r) => r.vector.includes('informative'));

  return {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    normativeFailures,
    informativeFailures,
    byArea,
    ok: normativeFailures.length === 0,
    implementation: label,
  };
}

function runVector(v: Vector, impl: Impl, push: (n: string, ok: boolean, d?: string) => void): void {
  switch (v.fn) {
    case 'resolveToken': return typographyVector(v, impl, push);
    case 'palette': return paletteVector(v, impl, push);
    case 'assignColors': return assignVector(v, impl, push);
    case 'paletteAudit': return auditVector(v, impl, push);
    case 'validate': return validateVector(v, impl, push);
    default: push('vector', false, `unknown fn "${v.fn}"`);
  }
}

function typographyVector(v: Vector, impl: Impl, push: (n: string, ok: boolean, d?: string) => void): void {
  const resolve = impl.resolveToken;
  if (!resolve) return push('vector', false, 'implementation exports no resolveToken');
  const token = (input: Record<string, number>) => resolve({ text: '', start: 0, end: 1, ...input });

  if (v.property === 'monotonic-nondecreasing' || v.property === 'monotonic-nonincreasing') {
    const field = v.cases?.[0]?.field ?? 'size';
    const xs = (v.cases ?? []).map((c) => token(c.input as Record<string, number>)[field]);
    const up = v.property === 'monotonic-nondecreasing';
    let ok = true;
    for (let i = 1; i < xs.length; i++) {
      if (up ? xs[i] < xs[i - 1] - 1e-9 : xs[i] > xs[i - 1] + 1e-9) ok = false;
    }
    return push(`${field} ${v.property}`, ok, ok ? undefined : `sequence: ${xs.join(', ')}`);
  }

  if (v.property === 'in-range') {
    for (const c of v.cases ?? []) {
      const got = token(c.input as Record<string, number>);
      const bad = Object.entries(v.bounds ?? {}).filter(([k, [lo, hi]]) => got[k] < lo || got[k] > hi);
      push(`bounds ${JSON.stringify(c.input)}`, bad.length === 0,
        bad.length ? bad.map(([k]) => `${k}=${got[k]}`).join(', ') : undefined);
    }
    return;
  }

  for (const c of v.cases ?? []) {
    const got = token((c.input ?? {}) as Record<string, number>);
    const bad = Object.entries(c.expect ?? {}).filter(
      ([k, want]) => !near(got[k], want as number, c.tolerance ?? 0.001));
    push(c.note ?? JSON.stringify(c.input), bad.length === 0,
      bad.length ? bad.map(([k, want]) => `${k}: got ${got[k]}, expected ${want}`).join('; ') : undefined);
  }
}

function paletteVector(v: Vector, impl: Impl, push: (n: string, ok: boolean, d?: string) => void): void {
  const e = v.expect ?? {};
  const main = (impl.MAIN_COLORS ?? []).map((s) => s.hex);
  const wantMain = e.main as string[];
  const sameSet = wantMain.length === main.length && wantMain.every((h) => main.includes(h));
  push('main palette', sameSet, sameSet ? undefined : `got ${main.join(', ')}`);

  push('supporting count', (impl.SUPPORTING_COLORS ?? []).length === e.supportingCount,
    `got ${(impl.SUPPORTING_COLORS ?? []).length}`);
  push('minor hue count', (impl.MINOR_HUES ?? []).length === e.minorHueCount,
    `got ${(impl.MINOR_HUES ?? []).length}`);
  push('minor saturation', impl.MINOR_SATURATION === e.minorSaturation, `got ${impl.MINOR_SATURATION}`);
  push('minor brightness', impl.MINOR_BRIGHTNESS === e.minorBrightness, `got ${impl.MINOR_BRIGHTNESS}`);
}

function assignVector(v: Vector, impl: Impl, push: (n: string, ok: boolean, d?: string) => void): void {
  const assign = impl.assignColors;
  if (!assign) return push('vector', false, 'implementation exports no assignColors');
  const palette = new Set([
    ...(impl.MAIN_COLORS ?? []).map((s) => s.hex),
    ...((impl.SUPPORTING_COLORS ?? []) as Array<{ hex: string }>).map((s) => s.hex),
  ]);

  for (const c of v.cases ?? []) {
    const { characters } = assign(c.input as unknown[]);
    const colors = characters.map((x) => String(x.color));
    const e = c.expect ?? {};
    const name = c.note ?? `${(c.input as unknown[]).length} characters`;

    if (e.allDistinct) {
      push(`${name} — distinct`, new Set(colors).size === colors.length,
        `got ${colors.join(', ')}`);
    }
    if (e.fromPalette) {
      // Minor characters come from the wheel-centre pastels, which are computed
      // rather than listed, so only main and supporting are checked here.
      const tiers = c.input as Array<{ tier: string }>;
      const checked = colors.filter((_, i) => tiers[i].tier !== 'minor');
      const stray = checked.filter((h) => !palette.has(h));
      push(`${name} — from palette`, stray.length === 0, stray.join(', '));
    }
    if (e.minHueSeparationDegrees != null && impl.hexHue && impl.hueDistance) {
      const hues = colors.map((h) => impl.hexHue!(h));
      let min = 360;
      for (let i = 0; i < hues.length; i++)
        for (let j = i + 1; j < hues.length; j++)
          min = Math.min(min, impl.hueDistance!(hues[i], hues[j]));
      const want = e.minHueSeparationDegrees as number;
      push(`${name} — hue separation >= ${want}`, min >= want - 0.5, `got ${min.toFixed(1)}`);
    }
  }
}

function auditVector(v: Vector, impl: Impl, push: (n: string, ok: boolean, d?: string) => void): void {
  const { simulateCvd, deltaE, contrastRatio, MAIN_COLORS } = impl;
  if (!simulateCvd || !deltaE || !contrastRatio || !MAIN_COLORS) {
    return push('vector', false, 'implementation lacks the colour-vision helpers');
  }
  const e = v.expect ?? {};
  const count = (mode: string | null) => {
    let n = 0;
    for (let i = 0; i < MAIN_COLORS.length; i++)
      for (let j = i + 1; j < MAIN_COLORS.length; j++) {
        const a = mode ? simulateCvd(MAIN_COLORS[i].hex, mode) : MAIN_COLORS[i].hex;
        const b = mode ? simulateCvd(MAIN_COLORS[j].hex, mode) : MAIN_COLORS[j].hex;
        if (deltaE(a, b) < 20) n++;
      }
    return n;
  };
  push('normal vision is clean', count(null) === e.normalVisionCollisions, `got ${count(null)}`);
  const deut = count('deuteranopia');
  push('deuteranopia collisions', deut >= (e.deuteranopiaCollisionsAtLeast as number), `got ${deut}`);
  const failing = MAIN_COLORS.filter((s) => contrastRatio(s.hex, '#1A1A1A') < 4.5).length;
  push('contrast failures', failing >= (e.contrastFailuresAtLeast as number), `got ${failing}`);
}

function validateVector(v: Vector, impl: Impl, push: (n: string, ok: boolean, d?: string) => void): void {
  const validate = impl.validate;
  if (!validate) return push('vector', false, 'implementation exports no validate');
  for (const c of v.cases ?? []) {
    const issues = validate(c.manifest);
    const hit = issues.find((i) => i.code === c.expectCode);
    push(c.name ?? String(c.expectCode), !!hit && hit.severity === c.expectSeverity,
      hit ? `severity ${hit.severity}, expected ${c.expectSeverity}`
          : `no "${c.expectCode}" issue; got: ${issues.map((i) => i.code).join(', ') || 'none'}`);
  }
}
