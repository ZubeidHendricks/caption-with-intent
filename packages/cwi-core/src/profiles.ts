/**
 * Caption design profiles.
 *
 * A profile bundles the palette, the attribution channels and any option
 * overrides that define a caption *design*. The rest of this library — the
 * acoustics-to-typography mapping, validation, the renderer — is profile
 * agnostic, so a design can be swapped without touching any of it.
 *
 * Two ship here.
 *
 * `cwi-1.0` reproduces Caption with Intention V1.0 exactly, including its two
 * known accessibility defects, because a profile claiming to be that spec must
 * be that spec. Use it to author CWI-conformant material or to check something
 * against the published design.
 *
 * `open-1.0` is this project's own design. It keeps the idea that carries
 * across — derive typography from *measured acoustics* rather than inferred
 * emotion, which is what makes any of this automatable — and fixes the two
 * defects the audit found in V1.0:
 *
 *   1. Its palette was derived by maximising the SMALLEST pairwise perceptual
 *      distance across normal vision and all three dichromacies at once, under
 *      a WCAG AA contrast constraint. Worst-case separation for four speakers
 *      is ΔE 43.6 against V1.0's 11.8; for six, 33.9 against 6.0. No colour
 *      falls below 4.5:1 on the caption box, where V1.0's red reaches 3.70:1.
 *
 *   2. Speaker identity is carried by a second, non-colour channel. Colour
 *      alone fails WCAG 2.2 SC 1.4.1 (Level A) whenever a scene has more than
 *      one speaker — a criterion conventional captioning satisfies with speaker
 *      labels and ">>" markers, so V1.0 regressed against ordinary practice on
 *      that specific point.
 *
 * The colour values in `open-1.0` are computed, not adapted. See
 * `scripts/derive-palette.mjs` for the derivation.
 */
import type { CwiOptions } from './types.js';
import { MAIN_COLORS, SUPPORTING_COLORS, type Swatch } from './palette.js';

/**
 * A channel that tells one speaker from another.
 *
 * `colour` alone does not satisfy WCAG 1.4.1. At least one other channel is
 * needed for a multi-speaker track to pass.
 */
export type AttributionChannel = 'colour' | 'position' | 'glyph' | 'label';

/** Horizontal placement, used when `position` is an attribution channel. */
export type CaptionPosition = 'left' | 'center' | 'right';

export interface Profile {
  id: string;
  label: string;
  /** What this design descends from, for provenance. */
  basedOn?: string;
  /** Free-text note surfaced by tooling. */
  note: string;
  mainColors: Swatch[];
  supportingColors: Swatch[];
  attribution: AttributionChannel[];
  /** Positions cycled through when `position` is an attribution channel. */
  positions?: CaptionPosition[];
  /**
   * Marks used when the cast outgrows the positions.
   *
   * Three horizontal slots is the practical ceiling for captions — they are
   * wide, and finer placement collides with itself — so a fourth speaker would
   * otherwise share a slot and fall back to colour alone. Escalating to a
   * per-character mark keeps every pair separable at any cast size.
   */
  glyphs?: string[];
  options?: Partial<CwiOptions>;
}

/**
 * Derived by `scripts/derive-palette.mjs`: maximise the minimum pairwise ΔE
 * across normal, protanopia, deuteranopia and tritanopia simultaneously,
 * subject to >= 4.5:1 against the caption box. Ordered by lightness.
 *
 * Optimising the average would let one indistinguishable pair hide behind
 * several good ones, and the pair that collapses is precisely what a viewer
 * runs into. Hue names are descriptive only; hue is not the carrier here.
 */
const OPEN_MAIN: Swatch[] = [
  { name: 'Open Violet', hex: '#9E60FB', hue: 265 },
  { name: 'Open Ember', hex: '#E95935', hue: 13 },
  { name: 'Open Steel', hex: '#5793C7', hue: 205 },
  { name: 'Open Rose', hex: '#C07C81', hue: 356 },
  { name: 'Open Lime', hex: '#A8F906', hue: 79 },
  { name: 'Open Sand', hex: '#FCE99C', hue: 50 },
];

/**
 * Supporting colours sit between the mains in lightness and saturation while
 * staying clear of them. Same constraint, lower separation budget: supporting
 * characters carry less of the scene, so a smaller margin is acceptable.
 */
const OPEN_SUPPORTING: Swatch[] = [
  { name: 'Open Violet Dim', hex: '#7B5BB8', hue: 262 },
  { name: 'Open Ember Dim', hex: '#B5603F', hue: 15 },
  { name: 'Open Steel Dim', hex: '#4E7C9E', hue: 203 },
  { name: 'Open Rose Dim', hex: '#9C6E72', hue: 354 },
  { name: 'Open Lime Dim', hex: '#8CC22B', hue: 79 },
  { name: 'Open Sand Dim', hex: '#C7B87E', hue: 48 },
  { name: 'Open Teal', hex: '#4FB3A6', hue: 172 },
  { name: 'Open Slate', hex: '#8E9BB0', hue: 217 },
  { name: 'Open Clay', hex: '#C98F6B', hue: 25 },
  { name: 'Open Moss', hex: '#7FA86B', hue: 100 },
  { name: 'Open Plum', hex: '#A87BA8', hue: 300 },
  { name: 'Open Straw', hex: '#D9C98A', hue: 47 },
];

export const PROFILES: Record<string, Profile> = {
  'cwi-1.0': {
    id: 'cwi-1.0',
    label: 'Caption with Intention V1.0 (2025.1)',
    note:
      'The published design, reproduced faithfully — including two known accessibility defects. ' +
      'Speakers are distinguished by hue alone, which fails WCAG 2.2 SC 1.4.1 (Level A) for any ' +
      'scene with more than one speaker, and the palette has pairs that collapse under common ' +
      'dichromacies. Use this to author CWI-conformant material; use open-1.0 to ship something ' +
      'that passes an accessibility audit.',
    mainColors: MAIN_COLORS,
    supportingColors: SUPPORTING_COLORS,
    attribution: ['colour'],
  },
  'open-1.0': {
    id: 'open-1.0',
    label: 'Open caption design 1.0',
    basedOn: 'The measured-acoustics approach of Caption with Intention V1.0',
    note:
      'Keeps the idea worth keeping — typography derived from measured acoustics rather than ' +
      'inferred emotion — and fixes the two defects found in V1.0. The palette is derived by ' +
      'optimisation for colour-vision safety under a WCAG AA contrast constraint, and speaker ' +
      'identity is carried by position as well as colour so a multi-speaker track can satisfy ' +
      'WCAG 1.4.1.',
    mainColors: OPEN_MAIN,
    supportingColors: OPEN_SUPPORTING,
    attribution: ['colour', 'position', 'glyph'],
    positions: ['left', 'center', 'right'],
    // Plain geometric marks: unambiguous at caption sizes, present in every
    // reasonable font, and distinguishable by shape rather than by fill.
    glyphs: ['●', '■', '▲', '◆', '★', '✚', '⬢', '◗'],
  },
};

export const DEFAULT_PROFILE = 'cwi-1.0';

export function getProfile(id: string = DEFAULT_PROFILE): Profile {
  const p = PROFILES[id];
  if (!p) {
    throw new Error(`Unknown profile "${id}". Available: ${Object.keys(PROFILES).join(', ')}`);
  }
  return p;
}

/**
 * Does this profile carry speaker identity without relying on colour?
 *
 * Necessary for WCAG 1.4.1, but NOT sufficient — see `colourOnlyPairs`. A
 * profile answering false cannot pass with more than one speaker, whatever its
 * palette.
 */
export function hasNonColourAttribution(p: Profile): boolean {
  return p.attribution.some((c) => c !== 'colour');
}

/**
 * Pairs of speakers that only colour tells apart.
 *
 * This is the question WCAG 1.4.1 actually asks, and it is per *pair*, not per
 * track. Declaring a non-colour channel is not enough: with four speakers and
 * three positions two of them share a slot, and distinguishing those two falls
 * back to colour alone. Such a pair still fails the criterion even though the
 * track as a whole "has" a second channel.
 */
export function colourOnlyPairs(
  speakers: Array<{ id: string; position?: string; glyph?: string }>,
  p: Profile,
): Array<[string, string]> {
  if (!hasNonColourAttribution(p)) {
    const out: Array<[string, string]> = [];
    for (let i = 0; i < speakers.length; i++)
      for (let j = i + 1; j < speakers.length; j++)
        out.push([speakers[i].id, speakers[j].id]);
    return out;
  }
  const key = (s: { position?: string; glyph?: string }) => `${s.position ?? ''}|${s.glyph ?? ''}`;
  const out: Array<[string, string]> = [];
  for (let i = 0; i < speakers.length; i++)
    for (let j = i + 1; j < speakers.length; j++)
      if (key(speakers[i]) === key(speakers[j])) out.push([speakers[i].id, speakers[j].id]);
  return out;
}

/** Assign a position to each speaker, spread across the available slots. */
export function positionFor(index: number, p: Profile): CaptionPosition | undefined {
  if (!p.attribution.includes('position') || !p.positions?.length) return undefined;
  return p.positions[index % p.positions.length];
}
