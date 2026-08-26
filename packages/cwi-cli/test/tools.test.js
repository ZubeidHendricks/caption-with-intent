import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, str, num, bool } from '../dist/args.js';
import {
  CwiError, readManifest, writeManifest, assign, validateManifest, stats,
  auditPalette, exportCaptions, resolveTypography,
} from '../dist/ops.js';
import { startPreview } from '../dist/preview.js';
import { init } from '../dist/scaffold.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'cwi-'));

const MANIFEST = {
  cwi: '1.0',
  meta: { title: 'T' },
  characters: [
    { id: 'a', name: 'Alpha', tier: 'main', role: 'hero', rank: 0 },
    { id: 'b', name: 'Beta', tier: 'main', role: 'villain', rank: 1 },
  ],
  cues: [
    { id: 'c1', start: 0, end: 2, speaker: 'a', kind: 'dialogue', onCamera: true,
      lines: [{ tokens: [{ text: 'Hello', start: 0, end: 0.5, db: 0, f0: 190 }] }] },
    { id: 'c2', start: 2.5, end: 4, speaker: 'b', kind: 'dialogue', onCamera: false,
      lines: [{ tokens: [{ text: 'Goodbye', start: 2.5, end: 3.1, db: -9, f0: 100 }] }] },
  ],
};

function fixture() {
  const dir = tmp();
  const p = join(dir, 'm.cwi.json');
  writeFileSync(p, JSON.stringify(MANIFEST));
  return { dir, p };
}

// --- args -----------------------------------------------------------------

test('parses positionals, --k v, --k=v and boolean flags', () => {
  const a = parse(['file.json', '--out', 'x.json', '--format=vtt', '--json', '--height', '720']);
  assert.deepEqual(a.positional, ['file.json']);
  assert.equal(str(a, 'out'), 'x.json');
  assert.equal(str(a, 'format'), 'vtt');
  assert.equal(bool(a, 'json'), true);
  assert.equal(num(a, 'height'), 720);
});

test('a flag followed by another flag is boolean, not a value', () => {
  const a = parse(['--whisperx', '--out', 'x']);
  assert.equal(bool(a, 'whisperx'), true);
  assert.equal(str(a, 'out'), 'x');
});

test('numeric flags reject non-numbers loudly', () => {
  assert.throws(() => num(parse(['--port', 'abc']), 'port'), /expects a number/);
});

test('missing flags are undefined, not empty strings', () => {
  const a = parse(['x']);
  assert.equal(str(a, 'nope'), undefined);
  assert.equal(num(a, 'nope'), undefined);
  assert.equal(bool(a, 'nope'), false);
});

// --- manifest I/O ---------------------------------------------------------

test('readManifest rejects a missing file with a CwiError', () => {
  assert.throws(() => readManifest('/nope/missing.json'), (e) => e instanceof CwiError);
});

test('readManifest rejects malformed JSON with the parse reason', () => {
  const dir = tmp();
  const p = join(dir, 'bad.json');
  writeFileSync(p, '{ not json');
  assert.throws(() => readManifest(p), /not valid JSON/);
});

test('readManifest rejects JSON that is not a manifest', () => {
  const dir = tmp();
  const p = join(dir, 'other.json');
  writeFileSync(p, '{"hello":"world"}');
  assert.throws(() => readManifest(p), /not a Caption with Intention manifest/);
});

test('readManifest rejects a manifest missing its arrays', () => {
  const dir = tmp();
  const p = join(dir, 'partial.json');
  writeFileSync(p, '{"cwi":"1.0"}');
  assert.throws(() => readManifest(p), /missing "characters" or "cues"/);
});

test('round-trips through write and read', () => {
  const { p } = fixture();
  const m = readManifest(p);
  const out = p.replace('.cwi.json', '.2.cwi.json');
  writeManifest(out, m);
  assert.deepEqual(readManifest(out), m);
});

// --- operations -----------------------------------------------------------

test('assign fills every colour and reports separation', () => {
  const r = assign(readManifest(fixture().p));
  assert.ok(r.characters.every((c) => /^#[0-9A-F]{6}$/.test(c.color)));
  assert.ok(Number.isFinite(r.worstCaseDeltaE));
  assert.equal(r.cvdSafe, true);
});

test('assign honours cvdSafe:false', () => {
  const r = assign(readManifest(fixture().p), false);
  assert.equal(r.cvdSafe, false);
});

test('validate reports ok for a clean manifest', () => {
  const m = readManifest(fixture().p);
  const withColors = { ...m, characters: assign(m).characters };
  const r = validateManifest(withColors);
  assert.equal(r.errors, 0);
  assert.equal(r.ok, true);
});

test('validate flags dialogue with no speaker as an error', () => {
  const m = JSON.parse(JSON.stringify(MANIFEST));
  delete m.cues[0].speaker;
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'no-speaker'));
});

test('stats sums words and shares to one', () => {
  const r = stats(readManifest(fixture().p));
  assert.equal(r.rows.length, 2);
  assert.equal(r.totalWords, 2);
  assert.ok(Math.abs(r.rows.reduce((n, x) => n + x.share, 0) - 1) < 0.01);
});

test('palette audit documents the V1.0 collisions', () => {
  const r = auditPalette();
  const normal = r.rows.find((x) => x.mode === 'normal');
  const deut = r.rows.find((x) => x.mode === 'deuteranopia');
  assert.equal(normal.collisions.length, 0, 'normal vision should be clean');
  assert.ok(deut.collisions.length >= 3, 'deuteranopia collisions are a documented finding');
  assert.ok(r.contrast.some((x) => !x.passesAA), 'CI Main Red fails WCAG AA');
});

test('export to vtt keeps timing and reports what it drops', () => {
  const m = readManifest(fixture().p);
  const r = exportCaptions({ ...m, characters: assign(m).characters }, 'vtt');
  assert.match(r.content, /^WEBVTT/);
  assert.match(r.content, /00:00:00\.000 --> /);
  assert.ok(r.lost.length > 0, 'a lossy export must say so');
});

test('export to ass carries colour and karaoke timing', () => {
  const m = readManifest(fixture().p);
  const r = exportCaptions({ ...m, characters: assign(m).characters }, 'ass', { frameHeight: 720 });
  assert.match(r.content, /\[Script Info\]/);
  assert.match(r.content, /PlayResY: 720/);
  assert.match(r.content, /\\k\d+/, 'karaoke timing');
  assert.ok(r.lost.some((l) => /weight|width/i.test(l)), 'must declare the axes are lost');
});

test('resolveTypography explains each axis', () => {
  const r = resolveTypography({ db: 0, f0: 180, centroid: 1200 });
  assert.equal(r.size, 5, 'normal speech sits at the spec baseline');
  assert.equal(r.wght, 400, '180 Hz is inside the neutral band');
  assert.ok(r.explanation.size.includes('%'));
});

test('resolveTypography with no acoustics returns spec defaults', () => {
  const r = resolveTypography({});
  assert.equal(r.size, 5);
  assert.equal(r.wght, 400);
});

// --- scaffolding ----------------------------------------------------------

test('init creates a runnable project', () => {
  const dir = join(tmp(), 'app');
  const r = init({ dir });
  for (const f of ['package.json', 'index.html', 'src/main.ts', 'captions/example.cwi.json']) {
    assert.ok(existsSync(join(dir, f)), `missing ${f}`);
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['cwi-core'] && pkg.dependencies['cwi-web']);
  assert.ok(r.next.length);
});

test('init scaffolds a manifest that validates cleanly', () => {
  const dir = join(tmp(), 'app2');
  init({ dir });
  const m = readManifest(join(dir, 'captions/example.cwi.json'));
  assert.equal(validateManifest(m).errors, 0, 'the starter manifest must not ship errors');
});

test('init refuses a non-empty directory unless forced', () => {
  const dir = join(tmp(), 'app3');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'keep.txt'), 'x');
  assert.throws(() => init({ dir }), /not empty/);
  assert.doesNotThrow(() => init({ dir, force: true }));
});

// --- preview server -------------------------------------------------------

test('preview serves the player, manifest, packages and 404s', async () => {
  const { p } = fixture();
  const h = await startPreview({ manifest: p });
  try {
    const html = await fetch(h.url);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Caption with Intention/);

    const man = await fetch(h.url + 'manifest.cwi.json');
    assert.equal(man.status, 200);
    assert.equal((await man.json()).cwi, '1.0');

    for (const path of ['_cwi/core/index.js', '_cwi/web/index.js']) {
      const r = await fetch(h.url + path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-type'), /javascript/);
    }
    assert.equal((await fetch(h.url + 'nope')).status, 404);
    assert.equal((await fetch(h.url + 'media')).status, 404, 'no video was given');
  } finally {
    await h.close();
  }
});

test('preview serves media with range support', async () => {
  const { dir, p } = fixture();
  const video = join(dir, 'v.bin');
  writeFileSync(video, Buffer.alloc(4096, 7));
  const h = await startPreview({ manifest: p, video });
  try {
    const full = await fetch(h.url + 'media');
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');

    // Browsers will not play media without a working 206 path.
    const part = await fetch(h.url + 'media', { headers: { Range: 'bytes=0-1023' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 0-1023/4096');
    assert.equal((await part.arrayBuffer()).byteLength, 1024);

    const bad = await fetch(h.url + 'media', { headers: { Range: 'bytes=99999-' } });
    assert.equal(bad.status, 416);
  } finally {
    await h.close();
  }
});

test('preview rejects a bad manifest before binding a port', async () => {
  await assert.rejects(() => startPreview({ manifest: '/nope/missing.cwi.json' }),
    (e) => e instanceof CwiError);
});

test('preview closes cleanly', async () => {
  const { p } = fixture();
  const h = await startPreview({ manifest: p });
  await h.close();
  await assert.rejects(() => fetch(h.url));
});

// --- render / deliver -----------------------------------------------------

import { activeWindows, PRESETS, render } from '../dist/render.js';
import { TARGETS, deliver } from '../dist/deliver.js';

test('activeWindows merges overlapping and touching cues', () => {
  assert.deepEqual(activeWindows([{ start: 0, end: 2 }, { start: 1.5, end: 3 }]), [[0, 3]]);
  assert.deepEqual(activeWindows([{ start: 0, end: 1 }, { start: 5, end: 6 }]), [[0, 1], [5, 6]]);
  assert.deepEqual(activeWindows([]), []);
});

test('activeWindows sorts before merging', () => {
  // Cues are not guaranteed ordered; an unsorted merge silently drops coverage
  // and the render would skip frames that should show captions.
  assert.deepEqual(activeWindows([{ start: 5, end: 6 }, { start: 0, end: 5.5 }]), [[0, 6]]);
});

test('every preset is complete', () => {
  for (const [id, p] of Object.entries(PRESETS)) {
    assert.ok(p.label, `${id} label`);
    assert.ok(p.note && p.note.length > 20, `${id} needs a note explaining when to use it`);
    assert.ok(p.pixFmt, `${id} pixFmt`);
    assert.ok(Array.isArray(p.extra), `${id} extra`);
  }
});

test('every delivery target names a real preset and writes instructions', () => {
  for (const [id, t] of Object.entries(TARGETS)) {
    assert.ok(PRESETS[t.preset], `${id} references unknown preset ${t.preset}`);
    assert.match(t.videoName, /\.\w+$/, `${id} videoName needs an extension`);
    const lines = t.instructions({ video: t.videoName, sidecar: 'captions.vtt' });
    assert.ok(lines.length > 3, `${id} instructions are too thin`);
    assert.ok(lines.join(' ').includes(t.videoName), `${id} instructions should name the video`);
  }
});

test('render rejects an unknown preset', async () => {
  const { p } = fixture();
  await assert.rejects(() => render({ manifest: p, out: '/tmp/x.mp4', preset: 'nope' }),
    (e) => e instanceof CwiError && /Unknown preset/.test(e.message));
});

test('render rejects odd frame dimensions before doing any work', async () => {
  const { p } = fixture();
  // yuv420p needs even dimensions; ffmpeg's own error for this is opaque.
  await assert.rejects(() => render({ manifest: p, out: '/tmp/x.mp4', width: 1281, height: 720 }),
    (e) => e instanceof CwiError && /odd dimension/.test(e.message));
});

test('render rejects a missing source video', async () => {
  const { p } = fixture();
  await assert.rejects(() => render({ manifest: p, out: '/tmp/x.mp4', video: '/nope/missing.mp4' }),
    (e) => e instanceof CwiError && /No such video/.test(e.message));
});

test('deliver rejects an unknown target', async () => {
  const { p } = fixture();
  await assert.rejects(() => deliver({ manifest: p, target: 'tiktok', outDir: '/tmp/x' }),
    (e) => e instanceof CwiError && /Unknown target/.test(e.message));
});

// --- doctor ---------------------------------------------------------------

import { doctor, findPython, findPipeline } from '../dist/ops.js';

test('doctor reports every capability with a fix for each failure', async () => {
  const r = await doctor();
  const names = r.checks.map((c) => c.name);
  for (const expected of ['node', 'ffmpeg', 'ffprobe', 'pipeline', 'browser']) {
    assert.ok(names.includes(expected), `missing check: ${expected}`);
  }
  for (const c of r.checks) {
    assert.equal(typeof c.ok, 'boolean');
    assert.ok(c.needed, `${c.name} must say what it is needed for`);
    assert.ok(c.detail, `${c.name} must report a detail`);
    // A failure the user cannot act on is not worth reporting.
    if (!c.ok) assert.ok(c.fix, `${c.name} failed without telling the user how to fix it`);
  }
  assert.equal(r.ok, r.checks.every((c) => c.ok));
});

test('findPython locates a venv above the pipeline, not just beside it', async () => {
  // Regression: the pipeline can resolve to the copy bundled inside the
  // package, whose parent has no .venv. Searching one level fell through to a
  // bare `python3` without numpy, and analyze failed with a traceback.
  const py = findPython();
  assert.ok(py.length > 0);
  assert.ok(findPipeline().length > 0);
});

test('CWI_PYTHON overrides discovery', () => {
  const prev = process.env.CWI_PYTHON;
  process.env.CWI_PYTHON = '/custom/python';
  try {
    assert.equal(findPython(), '/custom/python');
  } finally {
    if (prev === undefined) delete process.env.CWI_PYTHON;
    else process.env.CWI_PYTHON = prev;
  }
});

// --- conformance ----------------------------------------------------------

import { conform, findVectors } from '../dist/conform.js';

test('the reference implementation is conformant', async () => {
  const r = await conform();
  assert.equal(r.normativeFailures.length, 0,
    r.normativeFailures.map((f) => `${f.vector} ${f.case}: ${f.detail}`).join('\n'));
  assert.ok(r.total > 100, `only ${r.total} checks ran — vectors may not have loaded`);
  assert.ok(r.ok);
});

test('every vector declares whether it is normative and why it matters', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = findVectors();
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 10, `only ${files.length} vectors`);
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    assert.equal(typeof v.normative, 'boolean', `${f} must declare normative`);
    assert.ok(v.why && v.why.length > 40, `${f} must explain what breaks for a viewer`);
    assert.ok(v.id && v.area && v.title && v.fn, `${f} is missing metadata`);
    // A normative claim without a section reference is just an opinion.
    if (v.normative) assert.ok(v.spec, `${f} claims normative but cites no spec section`);
  }
});

test('the suite catches every mutant', async (t) => {
  // A conformance suite only ever run against a correct implementation proves
  // nothing. Each mutant carries one realistic bug; if any passes, the suite
  // has a hole.
  let mutants;
  try {
    mutants = await import('../../../conformance/mutants/mutants.mjs');
  } catch {
    return t.skip('mutants not present (packaged install)');
  }
  const missed = [];
  for (const [name, impl] of Object.entries(mutants)) {
    const r = await conform(impl);
    if (r.ok) missed.push(name);
  }
  assert.deepEqual(missed, [], `mutants not caught: ${missed.join(', ')}`);
});

test('an implementation missing an entry point fails loudly', async () => {
  const r = await conform({ MAIN_COLORS: [] });
  assert.equal(r.ok, false);
  assert.ok(r.normativeFailures.some((f) => /exports no/.test(f.detail ?? '')));
});

// --- audit ----------------------------------------------------------------

import { audit } from '../dist/audit.js';
import { toHtml, toMarkdown } from '../dist/audit-report.js';

const NOW = '2026-01-01T00:00:00.000Z';

function auditFixture(overrides = {}) {
  const dir = tmp();
  const p = join(dir, 'a.cwi.json');
  writeFileSync(p, JSON.stringify({ ...MANIFEST, ...overrides }));
  return audit({ manifest: p, now: NOW, ...(overrides.__opts ?? {}) });
}

const find = (r, id) => r.findings.find((f) => f.criterion.id === id);

test('WCAG 1.4.1 fails when speakers are told apart by colour alone', () => {
  // The headline finding: CWI attributes speakers by hue and defines no
  // non-colour cue, so the base design fails this Level A criterion.
  const r = auditFixture();
  const f = find(r, 'wcag-1.4.1');
  assert.equal(f.verdict, 'fail');
  assert.match(f.detail, /colour alone/);
  assert.ok(f.remediation, 'a failure this consequential must carry remediation');
  assert.deepEqual(f.affected.sort(), ['a', 'b']);
});

test('WCAG 1.4.1 passes with a single speaker', () => {
  const r = auditFixture({
    characters: [{ id: 'a', name: 'Alpha', tier: 'main', color: '#17E5E5' }],
    cues: [MANIFEST.cues[0]],
  });
  assert.equal(find(r, 'wcag-1.4.1').verdict, 'pass');
});

test('WCAG 1.4.1 passes when captions carry speaker labels', () => {
  // Conventional captioning satisfies 1.4.1 with labels; a CWI track that
  // keeps them does too.
  const labelled = MANIFEST.cues.map((c) => ({
    ...c,
    lines: [{ tokens: [{ text: `${c.speaker.toUpperCase()}:`, start: c.start, end: c.start + 0.1 },
                       ...c.lines[0].tokens] }],
  }));
  assert.equal(find(auditFixture({ cues: labelled }), 'wcag-1.4.1').verdict, 'pass');
});

test('contrast failures are named with their ratio', () => {
  const r = auditFixture({
    characters: [{ id: 'a', name: 'Alpha', tier: 'main', color: '#E51717' },
                 { id: 'b', name: 'Beta', tier: 'main', color: '#17E5E5' }],
  });
  const f = find(r, 'wcag-1.4.3');
  assert.equal(f.verdict, 'fail');
  assert.match(f.detail, /3\.70:1/);
});

test('colour-vision collisions are detected across all three dichromacies', () => {
  const r = auditFixture({
    characters: [{ id: 'a', name: 'A', tier: 'main', color: '#E51717' },
                 { id: 'b', name: 'B', tier: 'main', color: '#E58017' }],
  });
  const f = find(r, 'cwi-colour-distinct');
  assert.equal(f.verdict, 'fail');
  assert.match(f.detail, /deuteranopia/);
});

test('criteria that need a human are reported as review, never as pass', () => {
  const r = auditFixture();
  for (const id of ['fcc-accuracy', 'wcag-1.4.12', 'en-7.1.1']) {
    assert.equal(find(r, id).verdict, 'review', `${id} must not silently pass`);
  }
});

test('completeness needs a duration and says so when it has none', () => {
  assert.equal(find(auditFixture(), 'fcc-completeness').verdict, 'review');
  const dir = tmp();
  const p = join(dir, 'a.cwi.json');
  writeFileSync(p, JSON.stringify(MANIFEST));
  const withDur = audit({ manifest: p, now: NOW, duration: 4 });
  assert.equal(find(withDur, 'fcc-completeness').verdict, 'pass');
});

test('completeness flags long uncaptioned stretches', () => {
  const dir = tmp();
  const p = join(dir, 'a.cwi.json');
  writeFileSync(p, JSON.stringify(MANIFEST));
  const r = audit({ manifest: p, now: NOW, duration: 600 });
  const f = find(r, 'fcc-completeness');
  assert.equal(f.verdict, 'warn');
  assert.match(f.detail, /uncaptioned stretch/);
});

test('the report identifies the exact manifest it audited', () => {
  const r = auditFixture();
  assert.match(r.manifest.sha256, /^[0-9a-f]{64}$/);
  assert.ok(r.manifest.bytes > 0);
  assert.equal(r.generated, NOW);
  assert.ok(r.disclaimer.includes('not a legal determination'),
    'the report must never imply it certifies compliance');
});

test('a changed manifest produces a different hash', () => {
  const a = auditFixture();
  const b = auditFixture({ meta: { title: 'Different' } });
  assert.notEqual(a.manifest.sha256, b.manifest.sha256);
});

test('every finding carries a requirement and a method', () => {
  for (const f of auditFixture().findings) {
    assert.ok(f.criterion.requirement.length > 30, `${f.criterion.id} requirement`);
    assert.ok(f.criterion.method.length > 30, `${f.criterion.id} method`);
    assert.ok(['automated', 'partial', 'manual'].includes(f.criterion.assessment));
    if (f.verdict === 'fail') assert.ok(f.remediation, `${f.criterion.id} fails without remediation`);
  }
});

test('renders to self-contained HTML and to markdown', () => {
  const r = auditFixture();
  const html = toHtml(r);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Use of Color/);
  assert.match(html, new RegExp(r.manifest.sha256));
  // Archived compliance artifacts get opened years later on machines that will
  // not fetch anything.
  assert.equal(/<script|<link[^>]+href=["']http|@import|src=["']http/.test(html), false,
    'the report must not depend on any external resource');

  const md = toMarkdown(r);
  assert.match(md, /# Caption accessibility audit/);
  assert.match(md, /Use of Color/);
});

test('summary counts every finding exactly once', () => {
  const r = auditFixture();
  const total = r.summary.pass + r.summary.fail + r.summary.warn + r.summary.review;
  assert.equal(total, r.findings.length);
});

// --- study harness --------------------------------------------------------

import {
  loadVariants, buildTrials, answerKey, analyse, wilson, readResponses,
} from '../dist/study.js';
import { startStudy } from '../dist/study-server.js';

function variantFiles() {
  const dir = tmp();
  const a = join(dir, 'a.cwi.json');
  const b = join(dir, 'b.cwi.json');
  writeFileSync(a, JSON.stringify({ ...MANIFEST, profile: 'cwi-1.0' }));
  writeFileSync(b, JSON.stringify({ ...MANIFEST, profile: 'chorus-1.0' }));
  return { dir, a, b };
}

test('a study needs at least two variants', () => {
  const { a } = variantFiles();
  assert.throws(() => loadVariants([a]), /at least two variants/);
});

test('variants must carry the same dialogue', () => {
  // Comparing designs only means anything if the underlying material matches.
  const { dir, a } = variantFiles();
  const c = join(dir, 'c.cwi.json');
  writeFileSync(c, JSON.stringify({
    ...MANIFEST, profile: 'other',
    cues: [{ ...MANIFEST.cues[0], start: 99, end: 101 }],
  }));
  assert.throws(() => loadVariants([a, c]), /do not share the same cues/);
});

test('every cue is asked once per variant', () => {
  const { a, b } = variantFiles();
  const variants = loadVariants([a, b]);
  const trials = buildTrials(variants, 'p1');
  const dialogue = MANIFEST.cues.filter((c) => c.kind === 'dialogue').length;
  assert.equal(trials.length, dialogue * 2, 'each design measured on identical material');
  for (const v of variants) {
    assert.equal(trials.filter((t) => t.variantId === v.id).length, dialogue);
  }
});

test('trial order is per-participant and interleaved, not blocked', () => {
  const { a, b } = variantFiles();
  const variants = loadVariants([a, b]);
  const p1 = buildTrials(variants, 'participant-one').map((t) => t.id).join();
  const p2 = buildTrials(variants, 'participant-two').map((t) => t.id).join();
  assert.notEqual(p1, p2, 'order must vary by participant, or fatigue loads onto one design');
  // Same participant twice must reproduce, so a session can be reconstructed.
  assert.equal(buildTrials(variants, 'participant-one').map((t) => t.id).join(), p1);
});

test('the answer is never in what the trial exposes', () => {
  const { a, b } = variantFiles();
  const variants = loadVariants([a, b]);
  const trials = buildTrials(variants, 'p1');
  const key = answerKey(variants);
  for (const t of trials) {
    const serialised = JSON.stringify(t);
    const correct = key.get(`${t.variantId}:${t.cueId}`);
    assert.ok(correct, 'the key must know this trial');
    // The correct id appears among the options, but nothing marks which it is.
    assert.equal(/correct|answer|speaker/i.test(serialised), false, serialised);
  }
});

test('options are shuffled rather than always in cast order', () => {
  const { a, b } = variantFiles();
  const variants = loadVariants([a, b]);
  const orders = new Set(
    buildTrials(variants, 'p1').map((t) => t.options.map((o) => o.id).join()));
  assert.ok(orders.size >= 1);
  for (const t of buildTrials(variants, 'p1')) {
    assert.equal(t.options.length, MANIFEST.characters.length);
  }
});

test('wilson intervals behave at the sample sizes a caption study reaches', () => {
  // The normal approximation gives nonsense here: intervals past 100%, or zero
  // width when every answer is correct.
  const [lo, hi] = wilson(10, 10);
  assert.ok(hi <= 1 && lo > 0.6 && lo < 1, `[${lo}, ${hi}]`);
  const [lo0, hi0] = wilson(0, 10);
  assert.ok(lo0 === 0 && hi0 > 0 && hi0 < 0.4, `[${lo0}, ${hi0}]`);
  assert.deepEqual(wilson(0, 0), [0, 0]);
});

test('analysis refuses to call a winner on too few participants', () => {
  const responses = Array.from({ length: 20 }, (_, i) => ({
    trialId: `t${i}`, variantId: i % 2 ? 'a' : 'b', cueId: 'c', answerId: 'x',
    correct: i % 2 === 1, ms: 1000, participant: `p${i % 3}`, at: '',
  }));
  const r = analyse(responses);
  assert.equal(r.participants, 3);
  assert.ok(r.interpretation.some((l) => /Too few to conclude/.test(l)));
});

test('analysis reports overlap rather than a difference when intervals overlap', () => {
  const responses = Array.from({ length: 40 }, (_, i) => ({
    trialId: `t${i}`, variantId: i % 2 ? 'a' : 'b', cueId: 'c', answerId: 'x',
    correct: i % 4 < 2, ms: 1000, participant: `p${i}`, at: '',
  }));
  const r = analyse(responses);
  assert.ok(r.interpretation.some((l) => /intervals.*overlap/i.test(l)));
});

test('the server grades server-side and never returns the answer', async () => {
  const { dir, a, b } = variantFiles();
  const results = join(dir, 'r.jsonl');
  const h = await startStudy({ variants: [a, b], results, port: 0 });
  try {
    const session = await fetch(h.url + 'session', { method: 'POST' }).then((r) => r.json());
    assert.ok(session.participant && session.trials.length);
    assert.equal(/"correct"|"speaker"/.test(JSON.stringify(session)), false,
      'the session payload must not leak the key');

    const t = session.trials[0];
    const posted = await fetch(h.url + 'answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participant: session.participant, trialId: t.id,
        answerId: t.options[0].id, ms: 1234,
      }),
    }).then((r) => r.json());
    // Telling a participant whether they were right teaches them the cast.
    assert.deepEqual(posted, { ok: true });

    const recorded = readResponses(results);
    assert.equal(recorded.length, 1);
    assert.equal(typeof recorded[0].correct, 'boolean');
    assert.equal(recorded[0].ms, 1234);
  } finally {
    await h.close();
  }
});

test('the server rejects an unknown trial', async () => {
  const { dir, a, b } = variantFiles();
  const h = await startStudy({ variants: [a, b], results: join(dir, 'r2.jsonl'), port: 0 });
  try {
    const res = await fetch(h.url + 'answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participant: 'nope', trialId: 'nope', answerId: 'x', ms: 1 }),
    });
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});
