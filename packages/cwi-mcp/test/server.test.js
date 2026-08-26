/**
 * MCP server integration test — spawns the real server and speaks JSON-RPC to
 * it over stdio, rather than importing the handlers directly. The wiring is
 * what breaks (schemas, transport, error shape), so that is what gets tested.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'dist', 'server.js');
const repoRoot = resolve(here, '..', '..', '..');

let proc, pending, nextId, buf;

function connect() {
  proc = spawn('node', [serverPath], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  pending = new Map();
  nextId = 0;
  buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch { /* not our frame */ }
    }
  });
}

function send(method, params) {
  return new Promise((res, rej) => {
    const msg = { jsonrpc: '2.0', id: ++nextId, method, params };
    pending.set(msg.id, res);
    proc.stdin.write(JSON.stringify(msg) + '\n');
    setTimeout(() => {
      if (pending.has(msg.id)) { pending.delete(msg.id); rej(new Error(`timeout: ${method}`)); }
    }, 20000);
  });
}

async function call(name, args) {
  const r = await send('tools/call', { name, arguments: args });
  assert.ok(!r.error, `RPC error on ${name}: ${JSON.stringify(r.error)}`);
  return r.result;
}

const payload = (result) => JSON.parse(result.content[1].text);

let manifestPath;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cwi-mcp-'));
  manifestPath = join(dir, 'm.cwi.json');
  writeFileSync(manifestPath, JSON.stringify({
    cwi: '1.0',
    characters: [
      { id: 'a', name: 'Alpha', tier: 'main', role: 'hero', rank: 0 },
      { id: 'b', name: 'Beta', tier: 'main', role: 'villain', rank: 1 },
    ],
    cues: [
      { start: 0, end: 2, speaker: 'a', kind: 'dialogue',
        lines: [{ tokens: [{ text: 'Hello', start: 0, end: 0.6, db: 0, f0: 190 }] }] },
      { start: 2.5, end: 4, speaker: 'b', kind: 'dialogue',
        lines: [{ tokens: [{ text: 'Goodbye', start: 2.5, end: 3.2, db: 0, f0: 100 }] }] },
    ],
  }));

  connect();
  const init = await send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(init.result.serverInfo.name, 'caption-with-intention');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(() => { proc?.kill(); });

test('advertises the full toolset with descriptions', async () => {
  const { result } = await send('tools/list', {});
  const names = result.tools.map((t) => t.name);
  const EXPECTED = [
    'cwi_validate', 'cwi_assign_colors', 'cwi_stats', 'cwi_palette_audit',
    'cwi_resolve_typography', 'cwi_export', 'cwi_analyze', 'cwi_build_scene',
    'cwi_render', 'cwi_deliver', 'cwi_conform', 'cwi_conform_render', 'cwi_audit', 'cwi_init_app',
    'cwi_preview', 'cwi_preview_stop',
  ];
  // Exact, not a subset: a tool added without being documented is a tool
  // nobody discovers, and the README claims a specific count.
  assert.equal(names.length, EXPECTED.length,
    `advertised ${names.length} tools, expected ${EXPECTED.length}: ${names.join(', ')}`);
  for (const expected of EXPECTED) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  for (const t of result.tools) {
    assert.ok(t.description && t.description.length > 40, `${t.name} needs a usable description`);
    assert.ok(t.inputSchema, `${t.name} needs an input schema`);
  }
});

test('resolve_typography is pure and matches the spec baseline', async () => {
  const r = payload(await call('cwi_resolve_typography', { db: 0, f0: 180, centroid: 1200 }));
  assert.equal(r.size, 5);
  assert.equal(r.wght, 400);
});

test('palette_audit reports the documented V1.0 collisions', async () => {
  const r = payload(await call('cwi_palette_audit', {}));
  const deut = r.rows.find((x) => x.mode === 'deuteranopia');
  assert.ok(deut.collisions.length >= 3);
  assert.equal(r.rows.find((x) => x.mode === 'normal').collisions.length, 0);
});

test('assign then validate round-trips through the filesystem', async () => {
  const a = payload(await call('cwi_assign_colors', { manifest: manifestPath }));
  assert.equal(a.characters.length, 2);
  assert.ok(a.characters.every((c) => /^#[0-9A-F]{6}$/.test(c.color)));

  const v = payload(await call('cwi_validate', { manifest: manifestPath }));
  assert.equal(v.errors, 0);
});

test('stats reflects the manifest', async () => {
  const r = payload(await call('cwi_stats', { manifest: manifestPath }));
  assert.equal(r.rows.length, 2);
  assert.equal(r.totalWords, 2);
});

test('export declares what the target format cannot carry', async () => {
  const r = payload(await call('cwi_export', { manifest: manifestPath, format: 'vtt' }));
  assert.ok(r.lost.length > 0);
  assert.match(r.content, /^WEBVTT/);
});

test('a missing file returns a tool error, not a transport error', async () => {
  const r = await call('cwi_validate', { manifest: '/definitely/not/here.cwi.json' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /No such manifest/);
});

test('conform reports the reference implementation as conformant', async () => {
  const r = payload(await call('cwi_conform', {}));
  assert.equal(r.ok, true);
  assert.equal(r.normativeFailures.length, 0);
  assert.ok(r.total > 100);
});

test('audit reports the colour-only attribution failure', async () => {
  const r = payload(await call('cwi_audit', { manifest: manifestPath }));
  const useOfColor = r.findings.find((f) => f.criterion.id === 'wcag-1.4.1');
  assert.equal(useOfColor.verdict, 'fail', 'two speakers distinguished by hue alone');
  assert.ok(useOfColor.remediation);
  assert.ok(r.disclaimer.includes('not a legal determination'));
});

test('preview starts, serves, and stops', async () => {
  const r = payload(await call('cwi_preview', { manifest: manifestPath }));
  assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal((await fetch(r.url)).status, 200);

  await call('cwi_preview_stop', { url: r.url });
  await assert.rejects(() => fetch(r.url));
});
