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
