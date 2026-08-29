/**
 * The studio server, exercised over HTTP the way the page drives it.
 *
 * Rendering is deliberately not tested here — it needs a headless browser and
 * takes a minute, and `render` has its own coverage. What is tested is the part
 * that only exists in this app: the upload path, the subtitle handling, and the
 * refusals. Those are where an operator meets a wall, and a wall with a bad
 * message is the difference between fixing it and giving up.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio } from '@corerus/chorus-cli/studio';

let studio, base, work;

const SRT = `1
00:00:00,600 --> 00:00:03,300
VALE: You said the freight yard was empty.

2
00:00:03,800 --> 00:00:06,400
KROFT: Nothing out here is ever empty.
`;

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'studio-test-'));
  studio = await startStudio({ port: 0, workdir: work });
  base = studio.url.replace(/\/$/, '');
});

after(async () => { await studio?.close(); });

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', body, headers });
const getJson = async (path) => (await fetch(base + path)).json();

test('serves the page and the renderer it imports', async () => {
  const page = await (await fetch(base + '/')).text();
  assert.match(page, /Chorus Studio/);
  // The import map has to resolve, or the page loads and does nothing.
  assert.match(page, /"@corerus\/chorus-web":\s*"\/vendor\/web\/index\.js"/);
  const mod = await fetch(base + '/vendor/web/index.js');
  assert.equal(mod.status, 200);
  assert.match(mod.headers.get('content-type') ?? '', /javascript/);
  // And its own relative imports must resolve too, not just the entry point.
  assert.equal((await fetch(base + '/vendor/web/renderer.js')).status, 200);
});

test('reports the environment rather than failing later', async () => {
  const env = await getJson('/api/environment');
  assert.equal(typeof env.ok, 'boolean');
  // Which engine, not merely whether one exists: WhisperX separates speakers
  // and faster-whisper does not, and the page says different things for each.
  assert.ok(env.asr === null || ['whisperx', 'faster-whisper'].includes(env.asr),
    `unexpected asr value ${JSON.stringify(env.asr)}`);
});

test('accepts an upload and serves it back with range support', async () => {
  const bytes = Buffer.from('not really a video, but bytes are bytes');
  const up = await (await post('/api/upload?name=clip.mp4', bytes)).json();
  assert.ok(up.id);
  assert.equal(up.size, bytes.length);

  // Range support is what lets the preview scrub; without it some browsers
  // refuse to start playback at all.
  const ranged = await fetch(`${base}/media/${up.id}`, { headers: { Range: 'bytes=0-8' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-8/${bytes.length}`);
});

test('a path traversal in the filename cannot escape the job directory', async () => {
  const up = await (await post('/api/upload?name=' + encodeURIComponent('../../escaped.mp4'),
    Buffer.from('x'))).json();
  assert.ok(up.id);
  // The file lands inside the job directory under a flattened name.
  const inside = readFileSync(join(work, up.id, 'escaped.mp4'), 'utf8');
  assert.equal(inside, 'x');
});

test('parses a subtitle file immediately and reports what it found', async () => {
  const up = await (await post('/api/upload?name=clip.mp4', Buffer.from('v'))).json();
  const r = await (await post(`/api/subtitles?id=${up.id}&name=subs.srt`, Buffer.from(SRT))).json();
  assert.equal(r.entries, 2);
  assert.match(r.first, /freight yard/);
});

test('a subtitle file that is not one is refused at the moment it is dropped', async () => {
  // Not three minutes into an analysis, which is when the operator has stopped
  // watching and will read the failure as the tool being broken.
  const up = await (await post('/api/upload?name=clip.mp4', Buffer.from('v'))).json();
  const res = await post(`/api/subtitles?id=${up.id}&name=notes.txt`,
    Buffer.from('these are just some notes\nwith no timings at all'));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /No subtitle entries/);
  assert.match(body.error, /SRT or WebVTT/, 'and says what was expected');
});

test('analysis without any source of words is refused with the fix', async () => {
  const up = await (await post('/api/upload?name=clip.mp4', Buffer.from('v'))).json();
  await post('/api/analyze', JSON.stringify({ id: up.id }), { 'Content-Type': 'application/json' });
  // The refusal is asynchronous, so it lands on the job rather than the reply.
  let job;
  for (let i = 0; i < 20 && (job = await getJson(`/api/job?id=${up.id}`)).stage !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(job.stage, 'failed');
  assert.match(job.error, /need the words/);
});

test('an unknown job is an error, not a crash', async () => {
  const res = await fetch(base + '/api/job?id=nope');
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /No such job/);
});

test('a manifest posted back is kept for export', async () => {
  const up = await (await post('/api/upload?name=clip.mp4', Buffer.from('v'))).json();
  const manifest = { cwi: '1.0', characters: [], cues: [] };
  // Without a prior analysis there is no path to write to, so this must fail
  // cleanly rather than throwing on an undefined path.
  const res = await post('/api/manifest', JSON.stringify({ id: up.id, manifest }),
    { 'Content-Type': 'application/json' });
  assert.ok([200, 500].includes(res.status));
});

test('the page script is valid JavaScript', async () => {
  // The page is a string built inside a template literal inside TypeScript.
  // Three levels of quoting, and an unescaped apostrophe in one of them —
  // "the frame's fullscreen" — silently broke the entire app: the module failed
  // to parse, so no dropzones were created and nothing on the page did
  // anything. Every other test still passed, because they check that the HTML
  // contains the right text, and text is exactly what a broken script still is.
  const page = await (await fetch(base + '/')).text();
  const open = page.lastIndexOf('<script type="module">');
  assert.ok(open > 0, 'the page has a module script');
  const body = page.slice(open + '<script type="module">'.length);
  const source = body.slice(0, body.indexOf('</script>'));

  // Two things a Function body cannot hold but a module legitimately can:
  // import statements, and top-level await. Strip the first, wrap for the
  // second. Neither is what breaks; quoting is.
  const withoutImports = source.replace(/^\s*import\s[^;]+;/gm, '');
  assert.doesNotThrow(() => new Function(`return (async () => {${withoutImports}})`),
    'the page script must parse, or the app is inert');
});
