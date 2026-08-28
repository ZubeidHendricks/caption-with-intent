/**
 * Each mutant re-exports the reference implementation with one thing wrong.
 * The comment on each says what a viewer would experience.
 */
import * as ref from '@chorus/core';

const base = { ...ref };

/** Baseline set to 4% instead of 5%. Every caption in the title is undersized. */
export const wrongBaseline = {
  ...base,
  resolveToken: (t, o) => ({ ...ref.resolveToken(t, o), size: 4 }),
};

/** Size range clamped to 4-8%. Shouts and whispers stop reading as either. */
export const narrowRange = {
  ...base,
  resolveToken: (t, o) => {
    const r = ref.resolveToken(t, o);
    return { ...r, size: Math.min(8, Math.max(4, r.size)) };
  },
};

/** Neutral band mapped to 500, not 400. Every weight is read against the wrong zero. */
export const wrongNeutral = {
  ...base,
  resolveToken: (t, o) => {
    const r = ref.resolveToken(t, o);
    return { ...r, wght: r.wght === 400 ? 500 : r.wght };
  },
};

/** Pitch-to-weight inverted: a bass renders light, a treble heavy. */
export const invertedWeight = {
  ...base,
  resolveToken: (t, o) => {
    const r = ref.resolveToken(t, o);
    return { ...r, wght: 1100 - r.wght };
  },
};

/** Harmonics-to-width inverted, following the spec's chart instead of its prose. */
export const invertedWidth = {
  ...base,
  resolveToken: (t, o) => {
    const r = ref.resolveToken(t, o);
    return { ...r, wdth: 176 - r.wdth };
  },
};

/** Axis values unclamped. A renderer silently clamps and the contrast is lost. */
export const unclamped = {
  ...base,
  resolveToken: (t, o) => {
    const r = ref.resolveToken(t, o);
    return { ...r, wght: r.wght * 3, wdth: r.wdth * 3 };
  },
};

/** A palette swatch mistyped — one character is off-brand and off-spec. */
export const wrongPalette = {
  ...base,
  MAIN_COLORS: ref.MAIN_COLORS.map((s, i) => (i === 0 ? { ...s, hex: '#FFFF00' } : s)),
};

/** Hero and villain no longer opposed; the strongest attribution cue is gone. */
export const noOpposition = {
  ...base,
  assignColors: (chars) => {
    const { characters, warnings } = ref.assignColors(chars);
    const main = characters.filter((c) => c.tier === 'main');
    if (main.length >= 2) {
      // Adjacent hues instead of opposite ones.
      main[0].color = '#E51717';
      main[1].color = '#E58017';
    }
    return { characters, warnings };
  },
};

/** Two characters share a colour. Captions become actively misleading. */
export const duplicateColours = {
  ...base,
  assignColors: (chars) => {
    const { characters, warnings } = ref.assignColors(chars);
    if (characters.length >= 2) characters[1].color = characters[0].color;
    return { characters, warnings };
  },
};

/** Validator ignores unattributed dialogue — the one thing CWI exists to fix. */
export const blindValidator = {
  ...base,
  validate: (m) => ref.validate(m).filter((i) => i.code !== 'no-speaker'),
};

/** Validator permits three lines, overrunning the work area. */
export const permissiveLines = {
  ...base,
  validate: (m) => ref.validate(m).filter((i) => i.code !== 'too-many-lines'),
};
