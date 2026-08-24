import type { CwiOptions } from './types.js';

/**
 * Defaults. Every value fixed by the Caption with Intention V1.0 spec is the
 * spec's own number. Values the spec leaves open are marked INFERRED in
 * types.ts and justified in docs/SPEC-NOTES.md.
 */
export const DEFAULT_OPTIONS: CwiOptions = {
  baselineSizePct: 5,
  minSizePct: 3,
  maxSizePct: 12,
  quietRangeDb: 18,
  loudRangeDb: 12,
  dbKneeDb: 6,
  dbKneeSizePct: 0.6,

  neutralF0: [160, 200],
  f0Range: [80, 400],
  weightRange: [900, 100],
  baselineWeight: 400,

  centroidRange: [450, 2000],
  widthRange: [151, 25],
  baselineWidth: 100,

  popScale: 0.15,
  popDurationSec: 0.18,

  readAheadOpacity: 0.9,
  boxOpacity: 0.9,
  workAreaPct: 0.2,
  safeArea: { top: 5, bottom: 7.5, left: 5, right: 5 },
  maxLines: 2,
  wordSpaceEm: 0.30,
  wordSpaceWeightGain: 0.28,

  monochrome: false,
  offCameraSlant: -10,
};

export function withDefaults(partial?: Partial<CwiOptions>): CwiOptions {
  if (!partial) return { ...DEFAULT_OPTIONS };
  return {
    ...DEFAULT_OPTIONS,
    ...partial,
    safeArea: { ...DEFAULT_OPTIONS.safeArea, ...(partial.safeArea ?? {}) },
  };
}
