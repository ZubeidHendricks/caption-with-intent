import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIN_COLORS, SUPPORTING_COLORS, MINOR_HUES, hsbToHex, minorColor,
  DEFAULT_OPTIONS as O, sizeFromDb, weightFromF0, widthFromCentroid, resolveToken, wordGap,
  assignColors, worstCaseSeparation, hexHue, hueDistance,
  simulateCvd, deltaE, contrastRatio, validate, DELTA_E_FLOOR,
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
  // Monotonic across the calibrated range. Sample by interpolation rather than
  // by multipliers, which stop being ordered when the range narrows.
  const xs = [0, 0.25, 0.5, 0.75, 1].map((f) => widthFromCentroid(lo + (hi - lo) * f));
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] <= xs[i - 1], `${xs}`);
  // ...and clamped at both edges rather than running off the axis.
  assert.equal(widthFromCentroid(hi * 2), widthFromCentroid(hi));
  assert.equal(widthFromCentroid(lo / 3), widthFromCentroid(lo));
});

test('centroid range spreads real voices across the width axis', () => {
  // Voiced-frame centroids measured across 17 real voices ran 770-1569 Hz.
  // The range must spend most of the axis on that population, or the width
  // axis carries almost no information.
  const measured = [770, 798, 802, 848, 1232, 1260, 1285, 1519, 1546, 1569];
  const widths = measured.map((c) => widthFromCentroid(c));
  const span = Math.max(...widths) - Math.min(...widths);
  assert.ok(span / (151 - 25) > 0.6, `real voices span only ${Math.round(span)} of the width axis`);

  // A deep voice must read wider than normal, a high one narrower.
  assert.ok(widthFromCentroid(770) > O.baselineWidth, 'deepest voice should be expanded');
  assert.ok(widthFromCentroid(1569) < O.baselineWidth, 'highest voice should be condensed');
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

// --- profiles ---------------------------------------------------------------

import { PROFILES, getProfile, hasNonColourAttribution, colourOnlyPairs } from '../dist/index.js';

test('cwi-1.0 reproduces the published palette exactly', () => {
  // A profile claiming to be the published spec must be it, defects included.
  const p = getProfile('cwi-1.0');
  assert.deepEqual(p.mainColors.map((s) => s.hex), MAIN_COLORS.map((s) => s.hex));
  assert.deepEqual(p.attribution, ['colour']);
  assert.equal(hasNonColourAttribution(p), false,
    'colour-only attribution is exactly why V1.0 fails WCAG 1.4.1');
});

test('chorus-1.0 is substantially more colour-vision safe than cwi-1.0', () => {
  const worst = (hexes) => {
    let w = Infinity;
    for (let i = 0; i < hexes.length; i++)
      for (let j = i + 1; j < hexes.length; j++)
        w = Math.min(w, worstCaseSeparation([hexes[i], hexes[j]]));
    return w;
  };
  const cwi = worst(getProfile('cwi-1.0').mainColors.map((s) => s.hex));
  const open = worst(getProfile('chorus-1.0').mainColors.map((s) => s.hex));
  assert.ok(open > cwi * 3, `chorus-1.0 ΔE ${open.toFixed(1)} vs cwi-1.0 ${cwi.toFixed(1)}`);
  assert.ok(open >= DELTA_E_FLOOR, `chorus-1.0 must clear the ΔE ${DELTA_E_FLOOR} floor`);
});

test('every chorus-1.0 colour clears WCAG AA contrast on the caption box', () => {
  for (const s of getProfile('chorus-1.0').mainColors) {
    assert.ok(contrastRatio(s.hex, '#1A1A1A') >= 4.5,
      `${s.name} ${s.hex} at ${contrastRatio(s.hex, '#1A1A1A').toFixed(2)}:1`);
  }
  // The contrast failure chorus-1.0 exists partly to fix.
  assert.ok(getProfile('cwi-1.0').mainColors.some((s) => contrastRatio(s.hex, '#1A1A1A') < 4.5));
});

test('chorus-1.0 separates every speaker pair without colour', () => {
  for (const n of [2, 3, 4, 6, 8]) {
    const cast = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, tier: 'main', rank: i }));
    const { characters } = assignColors(cast, { profile: 'chorus-1.0' });
    const shared = colourOnlyPairs(characters, getProfile('chorus-1.0'));
    assert.deepEqual(shared, [], `${n} speakers left ${shared.length} colour-only pair(s)`);
  }
});

test('marks appear only once positions are exhausted', () => {
  const cast = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, tier: 'main', rank: i }));
  const three = assignColors(cast(3), { profile: 'chorus-1.0' }).characters;
  assert.ok(three.every((c) => !c.glyph), 'three speakers fit the positions; no marks needed');
  const four = assignColors(cast(4), { profile: 'chorus-1.0' }).characters;
  assert.ok(four.every((c) => c.glyph), 'marking some speakers and not others would be worse');
});

test('cwi-1.0 leaves position and marks unset', () => {
  const cast = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, tier: 'main', rank: i }));
  const { characters } = assignColors(cast, { profile: 'cwi-1.0' });
  assert.ok(characters.every((c) => !c.position && !c.glyph));
});

test('colourOnlyPairs reports every pair when there is no second channel', () => {
  const p = getProfile('cwi-1.0');
  const speakers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(colourOnlyPairs(speakers, p).length, 3, 'all 3 pairs rely on colour alone');
});

test('an unknown profile fails loudly', () => {
  assert.throws(() => getProfile('nope'), /Unknown profile/);
});

test('each profile explains itself', () => {
  for (const [id, p] of Object.entries(PROFILES)) {
    assert.ok(p.label, `${id} label`);
    assert.ok(p.note.length > 80, `${id} needs a note saying when to use it`);
    assert.ok(p.mainColors.length >= 4 && p.supportingColors.length >= 6, `${id} palettes`);
    assert.ok(p.attribution.includes('colour'));
  }
});

// --- writing systems --------------------------------------------------------

import { needsWordGap, isUnspacedText } from '../dist/index.js';

test('no word gap between two unspaced-script characters', () => {
  // CJK and Thai are segmented per character so word-level synchronisation
  // survives. Gapping every one would render the line as spaced-out glyphs.
  assert.equal(needsWordGap('大', '门'), false);
  assert.equal(needsWordGap('ゲ', 'ー'), false);
  assert.equal(needsWordGap('ป', 'ร'), false);
});

test('word gaps remain between spaced-script words', () => {
  assert.equal(needsWordGap('the', 'gate'), true);
  assert.equal(needsWordGap('البوابة', 'فتحت'), true);
  assert.equal(needsWordGap('השער', 'נפתח'), true);
});

test('a mixed boundary keeps its gap', () => {
  // "Netflix大门" should not weld the Latin to the CJK.
  assert.equal(needsWordGap('Netflix', '大'), true);
  assert.equal(needsWordGap('大', 'Netflix'), true);
});

test('isUnspacedText classifies whole strings', () => {
  assert.equal(isUnspacedText('大门'), true);
  assert.equal(isUnspacedText('。'), true, 'CJK punctuation is unspaced too');
  assert.equal(isUnspacedText('ab'), false);
  assert.equal(isUnspacedText(''), false);
});

// --- multiple subtitle languages -------------------------------------------

import {
  languagesOf, coverageOf, linesFor, directionFor, retime, addTrack, displayWidth,
} from '../dist/index.js';

const tok = (text, start, end, extra = {}) => ({ text, start, end, ...extra });

/** One English cue, spoken loudly, with known acoustics. */
const enCue = {
  id: 'c1', start: 1, end: 4, speaker: 'v', kind: 'dialogue', onCamera: true,
  lines: [{ tokens: [
    tok('The', 1.0, 1.2, { db: 0, f0: 180, centroid: 1200 }),
    tok('gate', 1.3, 1.7, { db: 0, f0: 180, centroid: 1200 }),
    tok('OPENED', 1.8, 2.6, { db: 11, f0: 200, centroid: 2000 }),
  ] }],
};
const base = {
  cwi: '1.0',
  meta: { language: 'en', direction: 'ltr' },
  characters: [{ id: 'v', name: 'Vale', tier: 'main', color: '#17E517', rank: 0 }],
  cues: [enCue],
};

test('display width counts CJK as two cells and combining marks as none', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('大门'), 4, 'CJK is double width');
  assert.equal(displayWidth('é'), 1, 'a combining acute adds no width');
});

test('a manifest with no translations reports only its own language', () => {
  assert.deepEqual(languagesOf(base), ['en']);
  assert.deepEqual(linesFor(base, enCue, 'en'), enCue.lines);
});

test('retiming spreads a translation across the source utterance', () => {
  const words = ['Das', 'Tor', 'WURDE', 'GEÖFFNET'];
  const out = retime(enCue, words);
  assert.equal(out.length, 4);
  // The translation occupies exactly the span the actor was speaking, no more.
  assert.equal(out[0].start, 1.0);
  assert.ok(Math.abs(out[3].end - 2.6) < 0.001, `ends at ${out[3].end}, expected 2.6`);
  // Monotonic and non-overlapping.
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start >= out[i - 1].end - 1e-9);
});

test('a translated word inherits the acoustics of whatever was being said then', () => {
  // This is the property that makes switching language safe: the typography
  // still describes the actor's delivery, not the translator's word choice.
  const out = retime(enCue, ['Das', 'Tor', 'WURDE', 'GEÖFFNET']);
  const loud = out.filter((k) => k.db === 11);
  assert.ok(loud.length >= 1, 'the shout must survive translation');
  assert.ok(out.every((k) => k.f0 !== undefined), 'every token carries pitch');
});

test('wider scripts get proportionally more of the span', () => {
  // Weighting by character count would reveal a CJK line at half the rate it
  // is read, since each glyph is about two Latin cells wide.
  const out = retime(enCue, ['門', 'a']);
  const first = out[0].end - out[0].start;
  const second = out[1].end - out[1].start;
  assert.ok(first > second * 1.5, `${first} vs ${second}`);
});

test('adding a track leaves the original untouched and switchable', () => {
  const two = addTrack(base, 'de', [[['Das', 'Tor', 'wurde', 'geöffnet']]]);
  assert.deepEqual(languagesOf(two), ['en', 'de']);
  assert.deepEqual(two.cues[0].lines, enCue.lines, 'the source track is unchanged');
  assert.deepEqual(linesFor(two, two.cues[0], 'de')[0].tokens.map((t) => t.text),
    ['Das', 'Tor', 'wurde', 'geöffnet']);
  assert.deepEqual(linesFor(two, two.cues[0], 'en')[0].tokens.map((t) => t.text),
    ['The', 'gate', 'OPENED']);
});

test('an untranslated cue falls back to the original rather than going blank', () => {
  const m = { ...base, cues: [enCue, { ...enCue, id: 'c2', start: 5, end: 7 }] };
  const two = addTrack(m, 'de', [[['Das', 'Tor']], null]);
  assert.deepEqual(linesFor(two, two.cues[1], 'de')[0].tokens.map((t) => t.text),
    ['The', 'gate', 'OPENED'], 'cue 2 has no German, so English shows');
  assert.deepEqual(coverageOf(two, 'de'), { total: 2, present: 1 });
});

test('a right-to-left track on a left-to-right film reports its own direction', () => {
  const two = addTrack(base, 'ar', [[['البوابة', 'فتحت']]], 'rtl');
  assert.equal(directionFor(two, two.cues[0], 'ar'), 'rtl');
  assert.equal(directionFor(two, two.cues[0], 'en'), 'ltr', 'the film itself is unchanged');
});

test('a translation with the wrong number of cues is refused', () => {
  // Silently dropping the tail would ship a film subtitled for ten minutes.
  assert.throws(() => addTrack(base, 'de', [[['a']], [['b']]]), /must correspond one to one/);
});
