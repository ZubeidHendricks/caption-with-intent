/**
 * Acoustics -> typography. This is the heart of the system, and the reason
 * Caption with Intention is automatable at all: it encodes *measurable signal
 * properties* (amplitude, fundamental frequency, spectral distribution) rather
 * than interpreted emotion categories.
 */
import type { CwiOptions, Token, TokenStyle } from './types.js';
import { DEFAULT_OPTIONS } from './options.js';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Guard the options argument. These are public functions that people will
 * reasonably write as `levels.map(sizeFromDb)` — where Array.map helpfully
 * passes the index as the second argument. Without this, that silently yields
 * NaN sizes rather than failing loudly.
 */
function opts(o: unknown): CwiOptions {
  return (o && typeof o === 'object' ? o : DEFAULT_OPTIONS) as CwiOptions;
}

/** Linear interpolation from domain [d0,d1] onto range [r0,r1], clamped. */
function lerp(v: number, d0: number, d1: number, r0: number, r1: number): number {
  if (d1 === d0) return r0;
  const t = clamp((v - d0) / (d1 - d0), 0, 1);
  return r0 + t * (r1 - r0);
}

/** Same, but interpolating in log-frequency space — the perceptually right
 *  domain for pitch and spectral position. */
function lerpLog(v: number, d0: number, d1: number, r0: number, r1: number): number {
  return lerp(Math.log2(Math.max(v, 1e-6)), Math.log2(d0), Math.log2(d1), r0, r1);
}

/**
 * Volume -> type size, as a percentage of frame height (spec 2.3.4–2.3.6).
 *
 * `db` is the word's level *relative to the speaker's dialogue reference*,
 * not an absolute level. Normal speech is 0 dB -> the 5% baseline. This
 * relative framing is what keeps a quiet scene and a loud scene from drifting
 * apart, which the spec does not address.
 *
 * A soft knee sits around the baseline. Ordinary speech swings roughly 15 dB
 * word to word from stress alone, and mapping that straight onto the 3-12%
 * range makes an evenly read line pulse between sizes. Inside the knee the
 * response is heavily compressed, so the size axis stays reserved for what the
 * spec actually describes it carrying: a character shouting or whispering,
 * not the amplitude dip on an unstressed syllable.
 */
export function sizeFromDb(db: number | undefined, options: CwiOptions = DEFAULT_OPTIONS): number {
  const o = opts(options);
  if (db == null || !Number.isFinite(db)) return o.baselineSizePct;
  const knee = o.dbKneeDb;
  const delta = o.dbKneeSizePct;
  if (db >= 0) {
    return db <= knee
      ? lerp(db, 0, knee, o.baselineSizePct, o.baselineSizePct + delta)
      : lerp(db, knee, o.loudRangeDb, o.baselineSizePct + delta, o.maxSizePct);
  }
  return db >= -knee
    ? lerp(db, -knee, 0, o.baselineSizePct - delta, o.baselineSizePct)
    : lerp(db, -o.quietRangeDb, -knee, o.minSizePct, o.baselineSizePct - delta);
}

/**
 * Pitch -> Roboto Flex `wght` (spec 2.3.8–2.3.9). Lower voices read heavier.
 * The 160–200 Hz neutral band is a plateau at 400, exactly as specified.
 */
export function weightFromF0(f0: number | undefined, options: CwiOptions = DEFAULT_OPTIONS): number {
  const o = opts(options);
  if (f0 == null || !Number.isFinite(f0) || f0 <= 0) return o.baselineWeight;
  const [nLo, nHi] = o.neutralF0;
  const [fLo, fHi] = o.f0Range;
  const [wLo, wHi] = o.weightRange;
  if (f0 >= nLo && f0 <= nHi) return o.baselineWeight;
  const w = f0 < nLo
    ? lerpLog(f0, fLo, nLo, wLo, o.baselineWeight)
    : lerpLog(f0, nHi, fHi, o.baselineWeight, wHi);
  return Math.round(clamp(w, Math.min(wLo, wHi), Math.max(wLo, wHi)));
}

/**
 * Harmonics -> Roboto Flex `wdth` (spec 2.3.9). Energy concentrated low in the
 * spectrum reads fuller and maps wider; high spectral centroid maps condensed.
 * See docs/SPEC-NOTES.md — the spec's own chart is ambiguous here and we follow
 * its prose.
 */
export function widthFromCentroid(c: number | undefined, options: CwiOptions = DEFAULT_OPTIONS): number {
  const o = opts(options);
  if (c == null || !Number.isFinite(c) || c <= 0) return o.baselineWidth;
  const [cLo, cHi] = o.centroidRange;
  const [wLo, wHi] = o.widthRange;
  const w = lerpLog(c, cLo, cHi, wLo, wHi);
  return Math.round(clamp(w, Math.min(wLo, wHi), Math.max(wLo, wHi)));
}

/**
 * Resolve one token to concrete typography. Explicit style on the token always
 * wins — that is the escape hatch for an editor overriding the analyzer.
 */
export function resolveToken(t: Token, options: CwiOptions = DEFAULT_OPTIONS): TokenStyle {
  const o = opts(options);
  return {
    size: t.size ?? sizeFromDb(t.db, o),
    wght: t.wght ?? weightFromF0(t.f0, o),
    wdth: t.wdth ?? widthFromCentroid(t.centroid, o),
  };
}

/**
 * Word gap between two adjacent tokens, in the same "% of frame height" unit
 * the spec uses for type size.
 *
 * NOT IN THE SPEC. Caption with Intention V1.0 fixes type size, weight and
 * width per word but says nothing about the space between words — and the
 * font's natural space advance is calibrated for regular weight. Once a word
 * is set at `wght` 900 and `wdth` 122 (a low, resonant voice, which the system
 * asks for often) the natural advance is far too tight and adjacent words
 * visibly weld together. Obliqued off-camera text makes it worse, because the
 * lean carries the last glyph into the following space.
 *
 * So the gap tracks weight, and gets a small extra allowance when slanted.
 * Living here rather than in a renderer keeps every backend — web, After
 * Effects, burn-in — spacing identically.
 */
export function wordGap(
  a: TokenStyle,
  b: TokenStyle,
  o: CwiOptions = DEFAULT_OPTIONS,
  slanted = false,
): number {
  // Anchor on the smaller neighbour so a shouted word does not drag an
  // oversized gap along with it.
  const base = Math.min(a.size, b.size);
  const heaviest = Math.max(a.wght, b.wght);
  const widest = Math.max(a.wdth, b.wdth);
  const weightTerm = o.wordSpaceEm + o.wordSpaceWeightGain * ((heaviest - 400) / 600);
  const widthTerm = 1 + 0.25 * ((widest - 100) / 100);
  return base * Math.max(o.wordSpaceEm, weightTerm) * widthTerm * (slanted ? 1.15 : 1);
}

/** Bake resolved styles into a token, so a manifest can be shipped pre-resolved. */
export function bakeToken(t: Token, o: CwiOptions = DEFAULT_OPTIONS): Token {
  return { ...t, ...resolveToken(t, o) };
}
