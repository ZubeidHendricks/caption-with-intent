/**
 * Renderer tests, in a real browser.
 *
 * jsdom cannot do this: the spec's geometry is all resolved layout — type size
 * as a percentage of frame height, word gaps that depend on a variable font's
 * advance widths, baseline alignment across differently-sized words. A DOM
 * emulator reports plausible-looking zeros for every one of them, so it would
 * pass while the renderer was broken.
 */
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPreview } from '@corerus/chorus-cli/preview';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FRAME_W = 1920, FRAME_H = 1080;

// One speaker at a known low pitch, one at a known high pitch, with a shout,
// a whisper, an off-camera line, an SFX cue and a music cue — every mechanism
// the spec defines, in one manifest.
const MANIFEST = {
  cwi: '1.0',
  meta: { title: 'Renderer test', aspectRatio: '16:9' },
  characters: [
    { id: 'low', name: 'Low', tier: 'main', color: '#17E517', rank: 0 },
    { id: 'high', name: 'High', tier: 'main', color: '#E517E5', rank: 1 },
  ],
  cues: [
    { id: 'normal', start: 0, end: 2, speaker: 'low', kind: 'dialogue', onCamera: true,
      lines: [{ tokens: [
        { text: 'alpha', start: 0.0, end: 0.4, db: 0, f0: 180, centroid: 1200 },
        { text: 'bravo', start: 0.5, end: 0.9, db: 0, f0: 180, centroid: 1200 },
      ] }] },
    { id: 'shout', start: 3, end: 5, speaker: 'low', kind: 'dialogue', onCamera: true, breakout: true,
      lines: [{ tokens: [{ text: 'LOUD', start: 3.0, end: 3.5, db: 12, f0: 180, centroid: 1200 }] }] },
    { id: 'whisper', start: 6, end: 8, speaker: 'high', kind: 'dialogue', onCamera: true,
      lines: [{ tokens: [{ text: 'quiet', start: 6.0, end: 6.5, db: -18, f0: 180, centroid: 1200 }] }] },
    { id: 'offcam', start: 9, end: 11, speaker: 'high', kind: 'dialogue', onCamera: false,
      lines: [{ tokens: [{ text: 'unseen', start: 9.0, end: 9.5, db: 0, f0: 180, centroid: 1200 }] }] },
    { id: 'sfx', start: 12, end: 14, kind: 'sfx', onCamera: true,
      lines: [{ tokens: [{ text: '[thunder]', start: 12.0, end: 12.6, db: 6 }] }] },
    { id: 'music', start: 15, end: 17, kind: 'music', onCamera: true,
      lines: [{ tokens: [{ text: '♪', start: 15.0, end: 15.4 }, { text: 'theme', start: 15.4, end: 16.0 }] }] },
    { id: 'pitch', start: 18, end: 20, speaker: 'low', kind: 'dialogue', onCamera: true,
      lines: [{ tokens: [
        { text: 'deep', start: 18.0, end: 18.5, db: 0, f0: 85, centroid: 600 },
        { text: 'high', start: 18.6, end: 19.1, db: 0, f0: 320, centroid: 2600 },
      ] }] },
  ],
};

let preview, browser, page;
let unavailable = null;

/**
 * These need a real browser. Skip rather than fail where one is not installed,
 * so a contributor without `playwright install` still gets a green suite — but
 * never silently: the skip reason is reported on every test.
 */
const test = (name, fn) => nodeTest(name, async (t) => {
  if (unavailable) return t.skip(unavailable);
  await fn(t);
});

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chorus-web-'));
  const manifestPath = join(dir, 'm.cwi.json');
  writeFileSync(manifestPath, JSON.stringify(MANIFEST));

  // playwright enforces its Node 20 floor with process.exit, not a throw, so
  // the version must be checked before the import or the whole file dies.
  if (Number(process.versions.node.split('.')[0]) < 20) {
    unavailable = `needs Node 20+ for playwright; this is Node ${process.versions.node}`;
    console.error(`\n  renderer tests skipped — ${unavailable}\n`);
    return;
  }
  try {
    preview = await startPreview({ manifest: manifestPath, port: 0, inspector: false });
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: FRAME_W, height: FRAME_H } });
    await page.goto(`${preview.url}render?w=${FRAME_W}&h=${FRAME_H}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__cwiReady === true', null, { timeout: 45000 });
    if (!(await page.evaluate(() => window.__cwiFontsLoaded))) {
      // Metrics tests (word gaps, sizes) depend on the real font.
      unavailable = 'Roboto Flex did not load — layout metrics would be measured in a fallback face';
      console.error(`\n  renderer tests skipped — ${unavailable}\n`);
    }
  } catch (e) {
    unavailable = `no headless browser: ${String(e.message).split('\n')[0]} — run \`npx playwright install chromium\``;
    console.error(`\n  renderer tests skipped — ${unavailable}\n`);
  }
});

after(async () => {
  await browser?.close().catch(() => {});
  await preview?.close().catch(() => {});
});

/** Seek and read back what the renderer actually laid out. */
async function at(t) {
  return page.evaluate((time) => {
    window.__cwiSeek(time);
    const toks = [...document.querySelectorAll('.cwi-tok')];
    const line = document.querySelector('.cwi-line');
    const root = document.querySelector('.cwi-stack > div');
    return {
      texts: toks.map((e) => e.textContent),
      spoken: toks.map((e) => e.classList.contains('cwi-tok--spoken')),
      sizes: toks.map((e) => parseFloat(getComputedStyle(e).fontSize)),
      colors: toks.map((e) => getComputedStyle(e).color),
      axes: toks.map((e) => e.style.fontVariationSettings),
      transforms: toks.map((e) => e.style.transform),
      // offsetTop/Left are LAYOUT positions and ignore transforms. A scaling
      // element's bounding rect legitimately moves; its layout box must not.
      layout: toks.map((e) => `${e.offsetLeft},${e.offsetTop}`),
      rectTops: toks.map((e) => Math.round(e.getBoundingClientRect().top)),
      gaps: [...document.querySelectorAll('.cwi-sp')].map((e) => e.getBoundingClientRect().width),
      boxed: line ? line.className.includes('cwi-line--boxed') : null,
      speaker: root ? root.style.getPropertyValue('--cwi-speaker') : null,
      offcam: root ? root.className.includes('offcam') : null,
      lineCount: document.querySelectorAll('.cwi-line').length,
      cueClass: root ? root.className : null,
      glyphs: [...document.querySelectorAll('.cwi-glyph')].map((e) => e.textContent),
      lineLeft: line ? Math.round(line.getBoundingClientRect().left) : null,
      bottom: line ? Math.round(window.innerHeight - line.getBoundingClientRect().bottom) : null,
    };
  }, t);
}

// --- spec 2.3.4-2.3.6: type size as a percentage of FRAME height -----------

test('normal speech renders at the spec baseline of 5% of frame height', async () => {
  const s = await at(0.6);
  assert.deepEqual(s.texts, ['alpha', 'bravo']);
  for (const px of s.sizes) {
    assert.ok(Math.abs(px - FRAME_H * 0.05) < 1, `${px}px, expected ~${FRAME_H * 0.05}`);
  }
});

test('a shout reaches the 12% ceiling and a whisper the 3% floor', async () => {
  assert.ok(Math.abs((await at(3.2)).sizes[0] - FRAME_H * 0.12) < 1.5, 'shout should hit 12%');
  assert.ok(Math.abs((await at(6.2)).sizes[0] - FRAME_H * 0.03) < 1.5, 'whisper should hit 3%');
});

test('size never escapes the spec range', async () => {
  for (const t of [0.6, 3.2, 6.2, 9.2, 12.2, 18.2]) {
    for (const px of (await at(t)).sizes) {
      assert.ok(px >= FRAME_H * 0.03 - 1 && px <= FRAME_H * 0.12 + 1, `${px}px at t=${t}`);
    }
  }
});

// --- spec 2.3.8-2.3.9: pitch and harmonics drive the variable axes ---------

test('the 160-200 Hz neutral band renders at wght 400', async () => {
  for (const axes of (await at(0.6)).axes) {
    assert.match(axes, /["']wght["']\s*400/, axes);
  }
});

test('a low voice renders heavier and wider than a high one', async () => {
  const s = await at(19.0);
  const [deep, high] = s.axes.map((a) => ({
    wght: Number(/wght["']?\s*(\d+)/.exec(a)?.[1]),
    wdth: Number(/wdth["']?\s*(\d+)/.exec(a)?.[1]),
  }));
  assert.ok(deep.wght > high.wght, `${deep.wght} should exceed ${high.wght}`);
  assert.ok(deep.wdth > high.wdth, `${deep.wdth} should exceed ${high.wdth}`);
  assert.ok(deep.wght >= 100 && deep.wght <= 1000);
  assert.ok(deep.wdth >= 25 && deep.wdth <= 151);
});

// --- spec 2.2.1-2.2.2: read-ahead, then colour on the word's onset ---------

test('unspoken words are white and spoken words take the speaker colour', async () => {
  const before = await at(0.45);          // "alpha" spoken, "bravo" not yet
  assert.deepEqual(before.spoken, [true, false]);
  assert.match(before.colors[0], /^rgba?\(23, 229, 23/, 'spoken word takes the character colour');
  assert.match(before.colors[1], /^rgba?\(255, 255, 255/, 'read-ahead stays white');
});

test('colour flips exactly on the word onset, not after', async () => {
  assert.equal((await at(0.49)).spoken[1], false, 'still read-ahead just before onset');
  assert.equal((await at(0.51)).spoken[1], true, 'coloured just after onset');
});

test('each speaker gets their own colour', async () => {
  assert.equal((await at(0.6)).speaker, '#17E517');
  assert.equal((await at(6.2)).speaker, '#E517E5');
});

// --- spec 2.2.3: the onset pop, and that it never reflows ------------------

test('the pop peaks near 15% and returns to rest', async () => {
  const rest = await at(0.45);
  assert.ok(!rest.transforms[0] || rest.transforms[0] === 'none',
    `settled word should carry no transform, got "${rest.transforms[0]}"`);

  let peak = 1;
  for (let t = 0.5; t < 0.68; t += 0.01) {
    const m = /scale\(([\d.]+)\)/.exec((await at(t)).transforms[1] ?? '');
    if (m) peak = Math.max(peak, Number(m[1]));
  }
  assert.ok(peak > 1.10 && peak <= 1.16, `peak scale ${peak}, expected ~1.15`);
});

test('the pop is a pure transform and never reflows the line', async () => {
  // The read-ahead text must already occupy final geometry, or every word
  // onset would shove the rest of the line sideways.
  const before = await at(0.45);
  const during = await at(0.53);
  assert.deepEqual(during.sizes, before.sizes, 'font-size must not change during a pop');
  assert.deepEqual(during.layout, before.layout, 'no word may change its layout position during a pop');
});

test('a popping word grows visually while its neighbours stay put', async () => {
  const before = await at(0.45);
  const during = await at(0.53);          // "bravo" is mid-pop here
  assert.equal(during.rectTops[0], before.rectTops[0], 'the settled word must not move');
  assert.notEqual(during.rectTops[1], before.rectTops[1], 'the popping word should visibly scale');
});

test('seeking backwards reproduces the same frame exactly', async () => {
  // A CSS animation could not do this; the pop is derived from the seek time.
  const forward = await at(0.53);
  await at(5.0);
  const back = await at(0.53);
  assert.deepEqual(back.transforms, forward.transforms);
  assert.deepEqual(back.spoken, forward.spoken);
});

// --- spec 2.1.5, 2.4.1, 2.4.4, 2.4.5 --------------------------------------

test('off-camera speech is obliqued', async () => {
  const s = await at(9.2);
  assert.match(s.axes[0], /slnt/, 'off-camera token should carry a slant axis');
  assert.equal((await at(0.6)).axes[0].includes('slnt'), false, 'on-camera must not be slanted');
});

test('sound effects and music render white regardless of any speaker', async () => {
  assert.match((await at(12.2)).colors[0], /^rgba?\(255, 255, 255/);
  assert.match((await at(15.6)).colors[0], /^rgba?\(255, 255, 255/);
});

test('music is static — no read-ahead state to advance', async () => {
  const s = await at(15.2);
  assert.ok(s.spoken.every((x) => x === true), 'music descriptors do not animate');
});

test('a breakout cue drops the caption box', async () => {
  assert.equal((await at(0.6)).boxed, true, 'normal cues are boxed');
  assert.equal((await at(3.2)).boxed, false, 'spec 2.4.1: sudden loud speech may break out');
});

test('captions sit inside the work area at the bottom of the frame', async () => {
  const s = await at(0.6);
  // Spec 2.4.3: lower 20% of frame, with a bottom safe margin.
  assert.ok(s.bottom > 0, 'must clear the bottom edge');
  assert.ok(s.bottom < FRAME_H * 0.2, `bottom gap ${s.bottom}px should stay within the work area`);
});

test('at most two lines are ever on screen', async () => {
  for (const t of [0.6, 3.2, 6.2, 9.2, 12.2, 15.6, 19.0]) {
    assert.ok((await at(t)).lineCount <= 2, `t=${t}`);
  }
});

// --- word spacing ----------------------------------------------------------

test('words are separated by a real gap', async () => {
  // Flex items containing only whitespace collapse to zero width; this caught
  // a real regression where every word welded to its neighbour.
  const s = await at(0.6);
  assert.equal(s.gaps.length, 1);
  assert.ok(s.gaps[0] > 4, `word gap was ${s.gaps[0]}px`);
});

test('heavier type gets a wider gap', async () => {
  const light = (await at(0.6)).gaps[0];
  const heavy = (await at(19.0)).gaps[0];
  assert.ok(heavy > light, `heavy gap ${heavy} should exceed light gap ${light}`);
});

// --- lifecycle -------------------------------------------------------------

test('cues appear and retire on their own boundaries', async () => {
  assert.equal((await at(2.5)).texts.length, 0, 'nothing between cues');
  assert.ok((await at(3.2)).texts.length > 0, 'next cue is present');
});

// --- non-colour attribution (WCAG 1.4.1) ----------------------------------

test('caption position varies by speaker when the profile carries it', async () => {
  // Colour alone fails WCAG 1.4.1 for a multi-speaker track. Position is the
  // least intrusive second channel, so it must actually move the captions.
  await page.evaluate(() => {
    const m = window.__cwiManifest;
    m.profile = 'chorus-1.0';
    m.characters[0].position = 'left';
    m.characters[1].position = 'right';
    window.__cwiReload(m);
  });
  const left = await at(0.6);          // speaker "low"
  const right = await at(6.2);         // speaker "high"
  assert.match(left.cueClass, /cwi-cue--left/);
  assert.match(right.cueClass, /cwi-cue--right/);
  assert.ok(left.lineLeft < right.lineLeft,
    `left-positioned caption at ${left.lineLeft} should sit left of ${right.lineLeft}`);
});

test('a centred speaker carries no position modifier', async () => {
  await page.evaluate(() => {
    const m = window.__cwiManifest;
    m.characters[0].position = 'center';
    m.characters[1].position = 'center';
    window.__cwiReload(m);
  });
  const s = await at(0.6);
  assert.equal(/cwi-cue--(left|right)/.test(s.cueClass), false, s.cueClass);
});

test('a per-character mark renders before the first line only', async () => {
  await page.evaluate(() => {
    const m = window.__cwiManifest;
    m.characters[0].glyph = '\u25CF';
    m.characters[1].glyph = '\u25A0';
    window.__cwiReload(m);
  });
  assert.deepEqual((await at(0.6)).glyphs, ['\u25CF']);
  assert.deepEqual((await at(6.2)).glyphs, ['\u25A0']);
});

test('marks are not applied to sound effects or music', async () => {
  assert.deepEqual((await at(12.2)).glyphs, [], 'sfx has no speaker to mark');
  assert.deepEqual((await at(15.6)).glyphs, [], 'music has no speaker to mark');
});

test('a profile without the channels leaves captions centred and unmarked', async () => {
  await page.evaluate(() => {
    const m = window.__cwiManifest;
    delete m.profile;
    for (const c of m.characters) { delete c.position; delete c.glyph; }
    window.__cwiReload(m);
  });
  const s = await at(0.6);
  assert.equal(/cwi-cue--(left|right)/.test(s.cueClass), false);
  assert.deepEqual(s.glyphs, []);
});

// --- writing systems -------------------------------------------------------

/**
 * The Latin manifest cannot exercise these: it has no unspaced script and no
 * right-to-left text. Reload the same page with a different one rather than
 * standing up a second browser.
 */
async function loadScene(m) {
  await page.evaluate((manifest) => window.__cwiReload(manifest), m);
}

const jaTokens = [...'ゲートは内側から開いた。'].map((ch, i) => ({
  text: ch, start: i * 0.12, end: i * 0.12 + 0.11, db: 0, f0: 180, centroid: 1200,
}));

const JA = {
  cwi: '1.0',
  meta: { title: '日本語', language: 'ja', direction: 'ltr', aspectRatio: '16:9' },
  characters: [{ id: 'a', name: 'ヴァリ', tier: 'main', color: '#17E517', rank: 0 }],
  cues: [{ id: 'ja', start: 0, end: 3, speaker: 'a', kind: 'dialogue', onCamera: true,
    lines: [{ tokens: jaTokens }] }],
};

const AR = {
  cwi: '1.0',
  meta: { title: 'مشهد', language: 'ar', direction: 'rtl', aspectRatio: '16:9' },
  characters: [{ id: 'a', name: 'فالي', tier: 'main', color: '#17E517', rank: 0 }],
  cues: [{ id: 'ar', start: 0, end: 3, speaker: 'a', kind: 'dialogue', onCamera: true,
    lines: [{ tokens: [
      { text: 'البوابة', start: 0.0, end: 0.5, db: 0, f0: 180, centroid: 1200 },
      { text: 'فتحت', start: 0.6, end: 1.0, db: 0, f0: 180, centroid: 1200 },
      { text: 'من', start: 1.1, end: 1.4, db: 0, f0: 180, centroid: 1200 },
    ] }] }],
};

test('an unspaced script reveals per character with no gaps between them', async () => {
  await loadScene(JA);
  const s = await at(0.5);
  assert.equal(s.texts.length, jaTokens.length, 'every character is its own reveal unit');
  assert.deepEqual(s.gaps, [], 'gapping each character would render the line spaced out');
  // The reveal is still progressive — that is the whole point of splitting.
  assert.ok(s.spoken.some(Boolean) && s.spoken.some((v) => !v), s.spoken.join(','));
});

test('a mixed unspaced/Latin boundary keeps its gap', async () => {
  await loadScene({
    ...JA,
    cues: [{ ...JA.cues[0], lines: [{ tokens: [
      { text: 'Netflix', start: 0, end: 0.4, db: 0, f0: 180, centroid: 1200 },
      { text: '大', start: 0.5, end: 0.6, db: 0, f0: 180, centroid: 1200 },
      { text: '門', start: 0.6, end: 0.7, db: 0, f0: 180, centroid: 1200 },
    ] }] }],
  });
  const s = await at(0.9);
  assert.equal(s.gaps.length, 1, 'one gap, after the Latin word');
  assert.ok(s.gaps[0] > 0, `gap collapsed to ${s.gaps[0]}px`);
});

test('a right-to-left scene lays out right to left', async () => {
  await loadScene(AR);
  const s = await at(1.2);
  const dir = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.cwi-line')).direction);
  assert.equal(dir, 'rtl');
  // The first spoken word must sit to the RIGHT of the last. Laid out LTR the
  // reveal runs backwards through the line, which is worse than no reveal.
  const lefts = s.layout.map((v) => Number(v.split(',')[0]));
  assert.ok(lefts[0] > lefts[lefts.length - 1],
    `first token at ${lefts[0]}, last at ${lefts[lefts.length - 1]}`);
});

test('right-to-left text does not mirror the position cue', async () => {
  // Position is a spatial attribution cue, not part of the text. A speaker
  // pinned left stays left whichever way their script runs.
  await loadScene({ ...AR, profile: 'chorus-1.0',
    characters: [{ ...AR.characters[0], position: 'left' }] });
  const s = await at(1.2);
  assert.match(s.cueClass, /cwi-cue--left/);
  assert.ok(s.lineLeft < FRAME_W / 3, `line at ${s.lineLeft}px`);
});
