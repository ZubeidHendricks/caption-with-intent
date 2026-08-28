/**
 * A/B study harness for caption designs.
 *
 * Every design decision in this repository traces to the spec, to a
 * measurement, or to an argument. None of it has been in front of Deaf or hard
 * of hearing viewers, which is the real ceiling on all of it — and the FCB team
 * validated V1.0 exactly this way, with community sessions and per-variant
 * voting, which is why V1.0 is as restrained as it is.
 *
 * WHAT MAKES THIS AN INSTRUMENT RATHER THAN A SURVEY
 *
 * The central claim of caption attribution is objectively testable: shown a
 * line, can a viewer say who spoke it? That has a right answer, so accuracy is
 * a number rather than an opinion. Preference questions are included, but they
 * are secondary — people are poor at predicting which design they will
 * actually read better, and a design can be liked and still fail.
 *
 * Design decisions that protect validity:
 *
 *   - Trial order is randomised per participant, and variants are interleaved
 *     rather than blocked, so fatigue and learning do not load onto whichever
 *     design happened to come last.
 *   - The correct answer is never sent to the client. A participant cannot
 *     read it out of the page, and neither can a curious developer.
 *   - Response time is recorded. A design that is accurate but slow to read is
 *     not equivalent to one that is accurate and immediate.
 *   - The instrument itself needs no audio and is fully keyboard operable,
 *     because its participants are the people it is asking about.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CwiError, readManifest } from './ops.js';
import type { CwiManifest } from '@corerus/chorus-core';

export interface Variant {
  id: string;
  label: string;
  manifestPath: string;
  manifest: CwiManifest;
}

export interface Trial {
  id: string;
  variantId: string;
  cueId: string;
  /** Seconds into the source video where this cue begins. */
  start: number;
  end: number;
  /** Candidate speakers, shuffled. The correct one is NOT marked. */
  options: Array<{ id: string; name: string }>;
}

export interface Response {
  trialId: string;
  variantId: string;
  cueId: string;
  answerId: string;
  correct: boolean;
  ms: number;
  participant: string;
  at: string;
}

/** Deterministic shuffle, so a participant's sequence can be reproduced. */
function shuffle<T>(items: T[], seed: string): T[] {
  const out = [...items];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const rand = () => ((h = (h * 1664525 + 1013904223) >>> 0) / 0x100000000);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function loadVariants(paths: string[]): Variant[] {
  if (paths.length < 2) {
    throw new CwiError('A study needs at least two variants to compare.',
      'Pass two or more manifests of the same scene, e.g. one per design profile.');
  }
  const variants = paths.map((p) => {
    const manifest = readManifest(resolve(p));
    return {
      id: manifest.profile ?? `variant-${createHash('sha1').update(p).digest('hex').slice(0, 6)}`,
      label: `${manifest.meta?.title ?? 'Untitled'} — ${manifest.profile ?? 'default'}`,
      manifestPath: resolve(p),
      manifest,
    };
  });

  // Comparing designs only means something if the underlying dialogue matches.
  const shape = (m: CwiManifest) => m.cues.map((c) => `${c.start}:${c.speaker}`).join('|');
  const first = shape(variants[0].manifest);
  const differing = variants.filter((v) => shape(v.manifest) !== first);
  if (differing.length) {
    throw new CwiError(
      `Variants do not share the same cues: ${differing.map((v) => v.id).join(', ')} differ from ${variants[0].id}.`,
      'A comparison is only meaningful when every variant carries the same dialogue at the same ' +
      'times. Generate them from one manifest, changing only the design.',
    );
  }
  if (new Set(variants.map((v) => v.id)).size !== variants.length) {
    throw new CwiError('Two variants share an id.', 'Give each manifest a distinct "profile".');
  }
  return variants;
}

/**
 * Build the trial sequence for one participant.
 *
 * Every cue is asked once per variant, so each design is measured on identical
 * material. Interleaving rather than blocking keeps order effects from landing
 * on one design.
 */
export function buildTrials(variants: Variant[], participant: string, maxTrials?: number): Trial[] {
  const cast = variants[0].manifest.characters;
  const trials: Trial[] = [];

  for (const v of variants) {
    for (const cue of v.manifest.cues) {
      if (cue.kind !== 'dialogue' || !cue.speaker) continue;
      // At least two candidates, or the question answers itself.
      if (cast.length < 2) continue;
      trials.push({
        // Derived, not random: the docs promise a participant's sequence can be
        // reproduced, and a random id makes that false — you could recover the
        // order but never confirm which trial was which.
        id: createHash('sha1')
          .update(`${participant}:${v.id}:${cue.id ?? cue.start}`).digest('hex').slice(0, 16),
        variantId: v.id,
        cueId: cue.id ?? String(cue.start),
        start: cue.start,
        end: cue.end,
        options: shuffle(
          cast.map((c) => ({ id: c.id, name: c.name ?? c.id })),
          `${participant}:${v.id}:${cue.id ?? cue.start}`,
        ),
      });
    }
  }

  const ordered = shuffle(trials, participant);
  return maxTrials ? ordered.slice(0, maxTrials) : ordered;
}

/** The answer key, kept server-side. */
export function answerKey(variants: Variant[]): Map<string, string> {
  const key = new Map<string, string>();
  for (const v of variants) {
    for (const cue of v.manifest.cues) {
      if (cue.kind === 'dialogue' && cue.speaker) {
        key.set(`${v.id}:${cue.id ?? cue.start}`, cue.speaker);
      }
    }
  }
  return key;
}

export function recordResponse(resultsPath: string, r: Response): void {
  mkdirSync(dirname(resolve(resultsPath)), { recursive: true });
  appendFileSync(resolve(resultsPath), JSON.stringify(r) + '\n');
}

export function readResponses(resultsPath: string): Response[] {
  const p = resolve(resultsPath);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// --------------------------------------------------------------------------
// Analysis
// --------------------------------------------------------------------------

export interface VariantResult {
  variantId: string;
  trials: number;
  correct: number;
  accuracy: number;
  /** Wilson score interval — behaves sensibly at small n, unlike normal approx. */
  ci95: [number, number];
  medianMs: number;
  participants: number;
}

export interface StudyReport {
  variants: VariantResult[];
  participants: number;
  totalTrials: number;
  /** Stated plainly: a difference is not a finding until it is powered. */
  interpretation: string[];
}

/**
 * Wilson score interval. The normal approximation gives nonsense at the small
 * sample sizes a caption study realistically reaches — intervals that extend
 * past 100%, or collapse to zero width when every answer is correct.
 */
export function wilson(correct: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = correct / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

export function analyse(responses: Response[]): StudyReport {
  const byVariant = new Map<string, Response[]>();
  for (const r of responses) {
    const list = byVariant.get(r.variantId) ?? [];
    list.push(r);
    byVariant.set(r.variantId, list);
  }

  const variants: VariantResult[] = [...byVariant].map(([variantId, rs]) => {
    const correct = rs.filter((r) => r.correct).length;
    const times = rs.map((r) => r.ms).sort((a, b) => a - b);
    return {
      variantId,
      trials: rs.length,
      correct,
      accuracy: rs.length ? correct / rs.length : 0,
      ci95: wilson(correct, rs.length),
      medianMs: times.length ? times[Math.floor(times.length / 2)] : 0,
      participants: new Set(rs.map((r) => r.participant)).size,
    };
  }).sort((a, b) => b.accuracy - a.accuracy);

  const participants = new Set(responses.map((r) => r.participant)).size;
  const interpretation: string[] = [];

  if (participants < 12) {
    interpretation.push(
      `${participants} participant(s). Too few to conclude anything: report the numbers, not a ` +
      'winner. Caption studies of this kind usually want 15-30 participants before a difference ' +
      'of a few percentage points means much.');
  }
  if (variants.length >= 2) {
    const [a, b] = variants;
    const overlap = a.ci95[0] <= b.ci95[1] && b.ci95[0] <= a.ci95[1];
    interpretation.push(overlap
      ? `The 95% intervals for ${a.variantId} and ${b.variantId} overlap, so this data does not ` +
        'show one to be more accurate than the other.'
      : `${a.variantId} is more accurate than ${b.variantId} and the 95% intervals do not overlap. ` +
        'That is suggestive, not conclusive — confirm with a pre-registered analysis before ' +
        'relying on it.');
    if (a.medianMs && b.medianMs && Math.abs(a.medianMs - b.medianMs) > 300) {
      const faster = a.medianMs < b.medianMs ? a : b;
      interpretation.push(
        `${faster.variantId} was answered faster (median ${faster.medianMs}ms vs ` +
        `${(faster === a ? b : a).medianMs}ms). A design read accurately but slowly is not ` +
        'equivalent to one read accurately and immediately.');
    }
  }
  interpretation.push(
    'Accuracy is the objective measure. Any preference data collected alongside it is secondary: ' +
    'people are poor predictors of which design they actually read better.');

  return {
    variants,
    participants,
    totalTrials: responses.length,
    interpretation,
  };
}

export { join as _join };
