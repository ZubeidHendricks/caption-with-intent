/**
 * Character -> colour assignment (spec 2.1.1 – 2.1.4).
 *
 * The spec states placement *rules* rather than a fixed table:
 *   - three main characters should be spaced as far apart as possible;
 *   - a clear hero and villain should sit opposite each other;
 *   - supporting colours must stay visually distant from the mains in use;
 *   - minor characters take pastels from the centre of the wheel.
 *
 * We implement these as a max-min hue separation search, which is small enough
 * to solve exhaustively for mains and greedily for the rest.
 */
import type { Character } from './types.js';
import { simulateCvd, deltaE, type CvdType } from './cvd.js';
import { colourOnlyPairs, getProfile, positionFor, type Profile } from './profiles.js';
import {
  MAIN_COLORS, SUPPORTING_COLORS, MINOR_HUES,
  minorColor, hueDistance, hsbToHex, MINOR_SATURATION, MINOR_BRIGHTNESS,
} from './palette.js';

export interface AssignResult {
  characters: Character[];
  warnings: string[];
}

export interface AssignOptions {
  /**
   * Caption design profile. Selects the palette and, where the profile carries
   * a non-colour attribution channel, assigns that too. Defaults to cwi-1.0,
   * which reproduces the published spec including its accessibility defects.
   */
  profile?: string | Profile;
  /**
   * Extend the spec's hue-separation rule with a colour-vision-deficiency
   * constraint: prefer sets whose colours stay distinguishable under
   * protanopia, deuteranopia and tritanopia as well as normal vision.
   *
   * The CWI V1.0 palette is not CVD-safe out of the box — Red/Orange,
   * Yellow/Green and Green/Orange all collapse under deuteranopia. With this
   * on, the assigner avoids picking such pairs together while still drawing
   * only from the spec's own swatches. Default: true.
   */
  cvdSafe?: boolean;
  /** ΔE floor used by the CVD constraint. Default 20. */
  deltaEFloor?: number;
}

const CVD_MODES: CvdType[] = ['protanopia', 'deuteranopia', 'tritanopia'];

/** Worst-case ΔE between one candidate colour and each of `others`, across
 *  normal vision and all three dichromacies. Does not consider pairs *within*
 *  `others` — use `worstCaseSeparation` for that. */
export function separationAgainst(candidate: string, others: string[]): number {
  let worst = Infinity;
  for (const o of others) {
    worst = Math.min(worst, deltaE(candidate, o));
    for (const m of CVD_MODES) {
      worst = Math.min(worst, deltaE(simulateCvd(candidate, m), simulateCvd(o, m)));
    }
  }
  return worst;
}

/**
 * Worst-case pairwise ΔE across normal vision and all three dichromacies.
 * Higher is better; this is what `cvdSafe` maximises alongside hue spacing.
 */
export function worstCaseSeparation(hexes: string[]): number {
  if (hexes.length < 2) return Infinity;
  let worst = Infinity;
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) {
      worst = Math.min(worst, deltaE(hexes[i], hexes[j]));
      for (const m of CVD_MODES) {
        worst = Math.min(worst, deltaE(simulateCvd(hexes[i], m), simulateCvd(hexes[j], m)));
      }
    }
  }
  return worst;
}

/** All k-subsets of `arr`, order preserved. */
function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  const out: T[][] = [];
  const walk = (start: number, acc: T[]) => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= arr.length - (k - acc.length); i++) {
      acc.push(arr[i]); walk(i + 1, acc); acc.pop();
    }
  };
  walk(0, []);
  return out;
}

/** Smallest pairwise hue gap in a set — the quantity we maximise. */
function minPairwiseGap(hues: number[]): number {
  let min = Infinity;
  for (let i = 0; i < hues.length; i++)
    for (let j = i + 1; j < hues.length; j++)
      min = Math.min(min, hueDistance(hues[i], hues[j]));
  return hues.length < 2 ? 180 : min;
}

function byRank(a: Character, b: Character): number {
  return (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Assign colours to every character that lacks one. Characters with an explicit
 * `color` are respected and treated as occupied hues.
 */
export function assignColors(input: Character[], opts: AssignOptions = {}): AssignResult {
  const { cvdSafe = true, deltaEFloor = 20 } = opts;
  const profile = typeof opts.profile === 'object' ? opts.profile : getProfile(opts.profile);
  const MAIN_COLORS = profile.mainColors;
  const SUPPORTING_COLORS = profile.supportingColors;
  const warnings: string[] = [];
  const chars = input.map((c) => ({ ...c }));

  const mains = chars.filter((c) => c.tier === 'main').sort(byRank);
  const supporting = chars.filter((c) => c.tier === 'supporting').sort(byRank);
  const minors = chars.filter((c) => c.tier === 'minor').sort(byRank);

  // --- Mains -------------------------------------------------------------
  const needMain = mains.filter((c) => !c.color);
  if (needMain.length > MAIN_COLORS.length) {
    warnings.push(
      `${needMain.length} main characters exceeds the spec's six main colours; ` +
      `colours will repeat. Consider demoting the least prominent to 'supporting'.`,
    );
  }

  const hero = needMain.find((c) => c.role === 'hero');
  const villain = needMain.find((c) => c.role === 'villain');
  const taken = new Set<string>(mains.filter((c) => c.color).map((c) => c.color!));

  if (hero && villain) {
    // Spec 2.1.1: hero and villain opposite each other on the spectrum.
    let best: { h: typeof MAIN_COLORS[0]; v: typeof MAIN_COLORS[0]; gap: number } | null = null;
    for (const h of MAIN_COLORS) {
      for (const v of MAIN_COLORS) {
        if (h === v) continue;
        const gap = hueDistance(h.hue, v.hue);
        // Opposition is the spec's rule; CVD separation breaks ties, and vetoes
        // pairs that would be indistinguishable to a dichromatic viewer.
        const sep = cvdSafe ? worstCaseSeparation([h.hex, v.hex]) : Infinity;
        if (cvdSafe && sep < deltaEFloor) continue;
        const score = gap + (cvdSafe ? Math.min(sep, 60) / 10 : 0);
        const bestScore = best ? best.gap + (cvdSafe ? Math.min(worstCaseSeparation([best.h.hex, best.v.hex]), 60) / 10 : 0) : -1;
        if (!best || score > bestScore) best = { h, v, gap };
      }
    }
    if (best) {
      hero.color = best.h.hex; villain.color = best.v.hex;
      taken.add(best.h.hex); taken.add(best.v.hex);
      if (best.gap < 150) {
        warnings.push(
          `Hero/villain hue opposition is only ${best.gap.toFixed(0)}deg — the six ` +
          `main colours are not evenly spaced, so true opposition is not always available.`,
        );
      }
    }
  }

  const remainingMains = needMain.filter((c) => !c.color);
  const availableMain = MAIN_COLORS.filter((s) => !taken.has(s.hex));
  if (remainingMains.length) {
    const k = Math.min(remainingMains.length, availableMain.length);
    // Spec: maximise separation. Exhaustive — at most C(6,k).
    let bestSet = availableMain.slice(0, k);
    let bestScore = -Infinity;
    let bestSep = 0;
    for (const combo of combinations(availableMain, k)) {
      const hexes = [...combo.map((s) => s.hex), ...taken];
      const hues = [...combo.map((s) => s.hue), ...[...taken].map(hexHue)];
      const gap = minPairwiseGap(hues);
      const sep = cvdSafe ? worstCaseSeparation(hexes) : Infinity;
      // Hard veto below the floor, then hue spacing with CVD separation as the
      // tie-break. Falls back gracefully when no set clears the floor.
      const score = (cvdSafe && sep < deltaEFloor ? -1000 : 0) + gap + (cvdSafe ? Math.min(sep, 60) / 10 : 0);
      if (score > bestScore) { bestScore = score; bestSet = combo; bestSep = sep; }
    }
    if (cvdSafe && bestSep < deltaEFloor) {
      warnings.push(
        `No assignment of ${k} main colours from the CWI palette stays distinguishable ` +
        `under all three dichromacies (best worst-case ΔE ${bestSep.toFixed(1)}, floor ${deltaEFloor}). ` +
        `Some viewers with colour-vision deficiency will not be able to tell two leads apart. ` +
        `Consider demoting a character, or enabling shape/position cues.`,
      );
    }
    remainingMains.forEach((c, i) => {
      const swatch = bestSet[i] ?? MAIN_COLORS[i % MAIN_COLORS.length];
      c.color = swatch.hex;
      taken.add(swatch.hex);
    });
  }

  // --- Supporting --------------------------------------------------------
  // Spec 2.1.3: keep supporting hues visually distant from the mains in use.
  const mainHues = mains.map((c) => hexHue(c.color!)).filter(Number.isFinite);
  const usedSupport: number[] = [];
  const usedSupportHex: string[] = [];
  for (const c of supporting) {
    if (c.color) { usedSupport.push(hexHue(c.color)); usedSupportHex.push(c.color); continue; }
    let best: { hex: string; hue: number; score: number } | null = null;
    for (const s of SUPPORTING_COLORS) {
      if (usedSupport.some((h) => hueDistance(h, s.hue) < 1)) continue;
      // Distance to the nearest already-committed hue, mains weighted heavier.
      const dMain = Math.min(...mainHues.map((h) => hueDistance(h, s.hue)), 180);
      const dSup = Math.min(...usedSupport.map((h) => hueDistance(h, s.hue)), 180);
      // Measure the candidate against the committed colours only — the mains'
      // separation from each other is already fixed and must not veto here.
      const committed = [...mains.map((m) => m.color!), ...usedSupportHex];
      const sep = cvdSafe && committed.length ? separationAgainst(s.hex, committed) : Infinity;
      if (cvdSafe && sep < deltaEFloor * 0.6) continue; // supporting tier tolerates less separation
      const score = dMain * 1.5 + dSup + (cvdSafe ? Math.min(sep, 40) / 4 : 0);
      if (!best || score > best.score) best = { hex: s.hex, hue: s.hue, score };
    }
    if (best) {
      c.color = best.hex; usedSupport.push(best.hue); usedSupportHex.push(best.hex);
    } else {
      // Nothing cleared the CVD floor. Fall back to the next unused swatch by
      // hue spacing alone, and say so rather than silently degrading.
      const unused = SUPPORTING_COLORS.filter(
        (s) => !usedSupport.some((h) => hueDistance(h, s.hue) < 1),
      );
      const pick = unused.length
        ? unused.reduce((bestS, s) => {
            const d = Math.min(...mainHues.map((h) => hueDistance(h, s.hue)), 180);
            const bd = Math.min(...mainHues.map((h) => hueDistance(h, bestS.hue)), 180);
            return d > bd ? s : bestS;
          })
        : SUPPORTING_COLORS[usedSupport.length % SUPPORTING_COLORS.length];
      c.color = pick.hex; usedSupport.push(pick.hue); usedSupportHex.push(pick.hex);
      warnings.push(
        unused.length
          ? `No supporting colour for "${c.id}" clears the CVD floor against the cast; ` +
            `fell back to maximum hue separation (${pick.name}).`
          : `Ran out of distinct supporting colours; reusing ${pick.name} for "${c.id}".`,
      );
    }
  }
  if (supporting.length > SUPPORTING_COLORS.length) {
    warnings.push(
      `${supporting.length} supporting characters exceeds the spec's twelve ` +
      `supporting colours; colours will repeat.`,
    );
  }

  // --- Minor -------------------------------------------------------------
  // Spec 2.1.4: pastels from the wheel centre, fixed S:30% B:90%.
  const usedMinor: number[] = [];
  minors.forEach((c) => {
    if (c.color) return;
    let best: { hue: number; score: number } | null = null;
    for (const hue of MINOR_HUES) {
      if (usedMinor.some((h) => hueDistance(h, hue) < 1)) continue;
      const score = Math.min(...usedMinor.map((h) => hueDistance(h, hue)), 180);
      if (!best || score > best.score) best = { hue, score };
    }
    const hue = best?.hue ?? MINOR_HUES[usedMinor.length % MINOR_HUES.length];
    c.color = hsbToHex(hue, MINOR_SATURATION, MINOR_BRIGHTNESS);
    usedMinor.push(hue);
  });
  void minorColor; // exported for callers that want the raw indexed colour

  // A second, non-colour channel where the profile has one. Colour alone does
  // not satisfy WCAG 1.4.1 for a multi-speaker track, whatever the palette.
  if (profile.attribution.includes('position')) {
    const speaking = [...mains, ...supporting, ...minors];
    speaking.forEach((c, i) => {
      c.position ??= positionFor(i, profile);
    });

    // Having a non-colour channel is not the same as that channel separating
    // every pair. With more speakers than slots, two share one and only colour
    // tells them apart — which still fails WCAG 1.4.1 for that pair.
    let shared = colourOnlyPairs(speaking as Array<{ id: string; position?: string }>, profile);

    if (shared.length && profile.glyphs?.length) {
      // Escalate to marks. Applied to the whole cast, not only the colliding
      // pair: marking some speakers and not others reads as meaning something
      // it does not.
      speaking.forEach((c, i) => {
        c.glyph ??= profile.glyphs![i % profile.glyphs!.length];
      });
      shared = colourOnlyPairs(
        speaking as Array<{ id: string; position?: string; glyph?: string }>, profile);
      if (speaking.length > profile.glyphs.length) {
        warnings.push(
          `${speaking.length} speakers exceeds the ${profile.glyphs.length} available marks, so ` +
          'some are reused. Consider demoting the least prominent characters.',
        );
      }
    }

    if (shared.length) {
      warnings.push(
        `${shared.length} speaker pair(s) share every non-colour channel, so only colour ` +
        `distinguishes them: ${shared.map(([a, b]) => `${a}/${b}`).join(', ')}. WCAG 1.4.1 is ` +
        'assessed per pair, so these still rely on colour alone.',
      );
    }
  }

  return { characters: chars, warnings };
}

/** Hue in degrees for a #RRGGBB string. */
export function hexHue(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  return (hue + 360) % 360;
}
