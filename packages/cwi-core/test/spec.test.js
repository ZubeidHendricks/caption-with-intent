import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIN_COLORS, SUPPORTING_COLORS, MINOR_HUES, hsbToHex, minorColor,
  DEFAULT_OPTIONS as O, sizeFromDb, weightFromF0, widthFromCentroid, resolveToken, wordGap,
  assignColors, worstCaseSeparation, hexHue, hueDistance,
  simulateCvd, deltaE, contrastRatio, validate,
} from '../dist/index.js';

// --- Palettes are transcribed correctly (spec 2.1.1-2.1.4) -----------------

test('main palette matches the spec swatches', () => {
  assert.equal(MAIN_COLORS.length, 6);
  assert.deepEqual(MAIN_COLORS.map((s) => s.hex),
    ['#E5E517', '#17E517', '#17E5E5', '#E517E5', '#E51717', '#E58017']);
});

test('supporting palette has the spec\'s twelve colours', () => {
  assert.equal(SUPPORTING_COLORS.length, 12);
  assert.equal(new Set(SUPPORTING_COLORS.map((s) => s.hex)).size, 12);
});

test('minor colours are wheel-centre pastels at S30/B90', () => {
  assert.equal(MINOR_HUES.length, 24);
  // hsbToHex at S.3/B.9 must reproduce the spec's fixed saturation/brightness.
  assert.equal(minorColor(0), hsbToHex(0, 0.3, 0.9));
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(minorColor(3).slice(1 + i, 3 + i), 16));
  assert.equal(Math.max(r, g, b), Math.round(0.9 * 255));             // B = 90%
  assert.ok(Math.abs((1 - Math.min(r, g, b) / Math.max(r, g, b)) - 0.3) < 0.02); // S = 30%
});

// --- Volume -> size (spec 2.3.5, 2.3.6) ------------------------------------

test('normal speech sits at the 5% baseline', () => {
  assert.equal(sizeFromDb(0), 5);
  assert.equal(sizeFromDb(undefined), 5);
});

test('size stays inside the spec range of 3-12%', () => {
  for (const db of [-120, -18, -9, 0, 6, 12, 60]) {
    const s = sizeFromDb(db);
    assert.ok(s >= O.minSizePct && s <= O.maxSizePct, `${db} dB -> ${s}%`);
  }
  assert.equal(sizeFromDb(-100), 3, 'a whisper clamps to the floor');
  assert.equal(sizeFromDb(100), 12, 'a shout clamps to the ceiling');
});

test('size is monotonic in loudness', () => {
  const xs = [-24, -12, -6, 0, 4, 8, 12, 20].map((d) => sizeFromDb(d));
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1]);
});

// --- Pitch -> weight (spec 2.3.8, 2.3.9) -----------------------------------

test('the 160-200 Hz neutral band is Roboto Regular 400', () => {
  for (const f of [160, 170, 180, 190, 200]) assert.equal(weightFromF0(f), 400);
});

test('lower voices get heavier type, higher voices lighter', () => {
  assert.ok(weightFromF0(90) > 400);
  assert.ok(weightFromF0(120) > weightFromF0(150));
  assert.ok(weightFromF0(250) < 400);
  assert.ok(weightFromF0(350) < weightFromF0(220));
});

test('weight stays within the Roboto Flex wght axis', () => {
  for (const f of [10, 80, 200, 500, 2000]) {
    const w = weightFromF0(f);
    assert.ok(w >= 100 && w <= 1000, `${f} Hz -> ${w}`);
  }
});

test('unvoiced or missing pitch falls back to the baseline weight', () => {
  assert.equal(weightFromF0(0), 400);
  assert.equal(weightFromF0(undefined), 400);
  assert.equal(weightFromF0(NaN), 400);
});

// --- Harmonics -> width (spec 2.3.9) ---------------------------------------

test('low spectral centroid reads wider, high reads condensed', () => {
  const [lo, hi] = O.centroidRange;
  assert.ok(widthFromCentroid(lo) > widthFromCentroid(hi));
  // Monotonic across the calibrated range...
  const xs = [lo, lo * 1.5, lo * 2.5, hi * 0.8, hi].map((c) => widthFromCentroid(c));
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] <= xs[i - 1], `${xs}`);
  // ...and clamped at both edges rather than running off the axis.
  assert.equal(widthFromCentroid(hi * 2), widthFromCentroid(hi));
  assert.equal(widthFromCentroid(lo / 3), widthFromCentroid(lo));
});

test('centroid range is calibrated for voiced-frame measurement', () => {
  // The analyzer measures centroid over voiced frames only, which runs well
  // below a full-band speech centroid. A real low male voice measures ~695 Hz
  // and must land mid-axis, not pinned to one end.
  const w = widthFromCentroid(695);
  assert.ok(w > O.baselineWidth, `695 Hz -> wdth ${w}, expected wider than normal`);
  assert.ok(w < 151, `695 Hz -> wdth ${w}, expected off the maximum`);
});

test('width stays within the Roboto Flex wdth axis', () => {
  for (const c of [1, 500, 1500, 3500, 20000]) {
    const w = widthFromCentroid(c);
    assert.ok(w >= 25 && w <= 151, `${c} Hz -> ${w}`);
  }
});

// --- Token resolution -------------------------------------------------------

test('explicit typography on a token overrides measured acoustics', () => {
  const t = { text: 'x', start: 0, end: 1, db: 9, f0: 90, centroid: 600, size: 7, wght: 500, wdth: 88 };
  assert.deepEqual(resolveToken(t), { size: 7, wght: 500, wdth: 88 });
});

test('word gap grows with weight and width', () => {
  const light = { size: 5, wght: 400, wdth: 100 };
  const heavy = { size: 5, wght: 900, wdth: 130 };
  assert.ok(wordGap(heavy, heavy) > wordGap(light, light));
  assert.ok(wordGap(light, light, O, true) > wordGap(light, light, O, false), 'oblique needs more');
});

test('word gap is anchored to the smaller neighbour', () => {
  const small = { size: 3, wght: 400, wdth: 100 };
  const big = { size: 12, wght: 400, wdth: 100 };
  assert.equal(wordGap(small, big), wordGap(big, small));
  assert.ok(wordGap(small, big) < wordGap(big, big));
});

// --- Colour assignment (spec 2.1.1, 2.1.3) ---------------------------------

test('hero and villain are placed opposite on the wheel', () => {
  const { characters } = assignColors([
    { id: 'h', tier: 'main', role: 'hero', rank: 0 },
    { id: 'v', tier: 'main', role: 'villain', rank: 1 },
  ]);
  const [h, v] = characters;
  assert.ok(hueDistance(hexHue(h.color), hexHue(v.color)) >= 150,
    `hero ${h.color} vs villain ${v.color}`);
});

test('every character gets a distinct colour', () => {
  const cast = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, tier: 'main', rank: i })),
    ...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, tier: 'supporting', rank: i })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, tier: 'minor', rank: i })),
  ];
  const { characters } = assignColors(cast);
  const colors = characters.map((c) => c.color);
  assert.equal(new Set(colors).size, colors.length, 'no duplicates');
  assert.ok(colors.every((c) => /^#[0-9A-F]{6}$/.test(c)));
});

test('assignment draws only from the spec palettes', () => {
  const { characters } = assignColors([
    { id: 'a', tier: 'main', rank: 0 }, { id: 'b', tier: 'supporting', rank: 0 },
  ]);
  assert.ok(MAIN_COLORS.some((s) => s.hex === characters[0].color));
  assert.ok(SUPPORTING_COLORS.some((s) => s.hex === characters[1].color));
});

test('pre-assigned colours are respected', () => {
  const { characters } = assignColors([
    { id: 'a', tier: 'main', rank: 0, color: '#E58017' },
    { id: 'b', tier: 'main', rank: 1 },
  ]);
  assert.equal(characters[0].color, '#E58017');
  assert.notEqual(characters[1].color, '#E58017');
});

test('CVD-safe assignment beats naive assignment on worst-case separation', () => {
  const cast = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, tier: 'main', rank: i }));
  const naive = assignColors(cast, { cvdSafe: false }).characters.map((c) => c.color);
  const safe = assignColors(cast, { cvdSafe: true }).characters.map((c) => c.color);
  assert.ok(worstCaseSeparation(safe) > worstCaseSeparation(naive),
    `safe ${worstCaseSeparation(safe).toFixed(1)} vs naive ${worstCaseSeparation(naive).toFixed(1)}`);
});

test('assignment warns rather than degrading silently when it cannot clear the floor', () => {
  const cast = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, tier: 'main', rank: i }));
  const { warnings } = assignColors(cast, { cvdSafe: true });
  assert.ok(warnings.some((w) => /colour-vision|dichromac/i.test(w)), warnings.join('|'));
});

// --- The finding: the V1.0 palette is not CVD-safe -------------------------

test('spec palette has deuteranopia collisions (documents the gap)', () => {
  const collisions = [];
  for (let i = 0; i < MAIN_COLORS.length; i++)
    for (let j = i + 1; j < MAIN_COLORS.length; j++) {
      const d = deltaE(simulateCvd(MAIN_COLORS[i].hex, 'deuteranopia'),
                       simulateCvd(MAIN_COLORS[j].hex, 'deuteranopia'));
      if (d < 20) collisions.push(`${MAIN_COLORS[i].name}/${MAIN_COLORS[j].name}`);
    }
  assert.ok(collisions.length >= 3,
    `expected the documented collisions, got ${collisions.length}`);
});

test('CI Main Red fails WCAG AA against the caption box', () => {
  assert.ok(contrastRatio('#E51717', '#1A1A1A') < 4.5);
});

test('CVD simulation is idempotent for a dichromat-safe grey', () => {
  assert.equal(simulateCvd('#808080', 'deuteranopia').length, 7);
  assert.equal(deltaE('#FFFFFF', '#FFFFFF'), 0);
});

// --- Validation -------------------------------------------------------------

const cue = (o = {}) => ({
  start: 0, end: 2, kind: 'dialogue', speaker: 'a',
  lines: [{ tokens: [{ text: 'hi', start: 0, end: 0.4 }] }], ...o,
});
const manifest = (cues, characters = [{ id: 'a', tier: 'main', color: '#17E5E5' }]) =>
  ({ cwi: '1.0', characters, cues });

test('validation catches dialogue with no speaker', () => {
  const issues = validate(manifest([cue({ speaker: undefined })]));
  assert.ok(issues.some((i) => i.code === 'no-speaker' && i.severity === 'error'));
});

test('validation catches an unknown speaker reference', () => {
  const issues = validate(manifest([cue({ speaker: 'ghost' })]));
  assert.ok(issues.some((i) => i.code === 'unknown-speaker'));
});

test('validation enforces the two-line maximum (spec 2.4.2)', () => {
  const three = [1, 2, 3].map(() => ({ tokens: [{ text: 'x', start: 0, end: 0.3 }] }));
  const issues = validate(manifest([cue({ lines: three })]));
  assert.ok(issues.some((i) => i.code === 'too-many-lines' && i.severity === 'error'));
});

test('validation catches inverted timing', () => {
  const issues = validate(manifest([cue({ start: 5, end: 2 })]));
  assert.ok(issues.some((i) => i.code === 'bad-timing'));
});

test('validation flags tokens outside their cue window', () => {
  const issues = validate(manifest([cue({ lines: [{ tokens: [{ text: 'x', start: 9, end: 9.4 }] }] })]));
  assert.ok(issues.some((i) => i.code === 'token-bounds'));
});

test('validation flags an unreadable caption rate', () => {
  const tokens = Array.from({ length: 30 }, (_, i) => ({ text: 'w', start: i * 0.02, end: i * 0.02 + 0.01 }));
  const issues = validate(manifest([cue({ start: 0, end: 0.6, lines: [{ tokens }] })]));
  assert.ok(issues.some((i) => i.code === 'reading-rate'));
});

test('a clean manifest produces no errors', () => {
  const m = manifest([cue()], [{ id: 'a', tier: 'main', color: '#17E5E5' }]);
  assert.equal(validate(m).filter((i) => i.severity === 'error').length, 0);
});

test('mapping functions survive being passed straight to Array.map', () => {
  // Array.map passes (value, index, array) — the index must not be mistaken
  // for an options object.
  assert.deepEqual([0, 0, 0].map(sizeFromDb), [5, 5, 5]);
  assert.deepEqual([180, 180].map(weightFromF0), [400, 400]);
  assert.ok([1500, 1500].map(widthFromCentroid).every(Number.isFinite));
});
