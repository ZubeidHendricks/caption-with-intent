/**
 * The captioning team, and specifically its gates.
 *
 * A pipeline that runs every stage and reports success is easy. The value here
 * is entirely in the stages that refuse, so that is what these test: that a run
 * with no words stops rather than producing an empty track, that a track with
 * one speaker is flagged rather than shipped silently, and that a warning is
 * neither an error nor nothing.
 *
 * Without this, the team would be what Agent Opus is — eight stages that always
 * succeed and a human left to notice.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTeam } from '@corerus/chorus-cli/team';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VIDEO = join(repo, 'apps', 'demo', 'public', 'control-room.mp4');
const LABELLED = join(repo, 'examples', 'control-room.srt');

let work;
const available = existsSync(VIDEO) && existsSync(LABELLED);
const it = (name, fn) => test(name, async (t) => {
  if (!available) return t.skip('demo media not present');
  await fn(t);
});

before(() => { work = mkdtempSync(join(tmpdir(), 'team-')); });

const stage = (r, name) => r.reports.find((s) => s.stage === name);

it('a run with no source of words stops before transcribing', async () => {
  const r = await runTeam({ media: VIDEO, out: join(work, 'a.cwi.json') });
  assert.equal(r.ok, false);
  const t = stage(r, 'transcribe');
  assert.equal(t.verdict, 'stop');
  // The refusal has to say what to do, or it is just a wall.
  assert.match(t.advice, /--subtitles|--asr/);
  assert.equal(r.manifest, undefined, 'nothing was written');
});

it('later stages do not run once a stage has stopped', async () => {
  // A pipeline that keeps going after a stop wastes minutes and, worse,
  // produces output that looks like a result.
  const r = await runTeam({ media: VIDEO, out: join(work, 'b.cwi.json') });
  assert.equal(stage(r, 'audit'), undefined);
  assert.equal(stage(r, 'design'), undefined);
});

it('unlabelled subtitles are a warning, not a failure', async () => {
  // Every line becomes one speaker. The track is real and usable; the
  // attribution layer is idle. That is exactly a warning: it ships, and
  // somebody has to know.
  const plain = join(work, 'plain.srt');
  writeFileSync(plain, [
    '1', '00:00:00,330 --> 00:00:02,500', 'The gate opened from the inside.', '',
    '2', '00:00:02,722 --> 00:00:04,972', 'Then somebody here opened it.', '',
  ].join('\n'));

  const r = await runTeam({ media: VIDEO, subtitles: plain, out: join(work, 'c.cwi.json') });
  const a = stage(r, 'attribute');
  assert.equal(a.verdict, 'warn');
  assert.match(a.summary, /one speaker/);
  assert.ok(r.ok, 'a warning does not stop the run');
  assert.ok(r.open.some((o) => o.startsWith('attribute')), 'and it stays on the open list');
});

it('strict turns every warning into a stop', async () => {
  const plain = join(work, 'plain2.srt');
  writeFileSync(plain, [
    '1', '00:00:00,330 --> 00:00:02,500', 'The gate opened from the inside.', '',
  ].join('\n'));
  const r = await runTeam({ media: VIDEO, subtitles: plain, strict: true,
    out: join(work, 'd.cwi.json') });
  assert.equal(r.ok, false, 'unattended runs cannot rely on someone reading warnings');
  assert.ok(r.open.length > 0);
});

it('labelled subtitles carry through to separated speakers', async () => {
  const r = await runTeam({ media: VIDEO, subtitles: LABELLED, out: join(work, 'e.cwi.json') });
  const a = stage(r, 'attribute');
  assert.equal(a.verdict, 'ok');
  assert.equal(a.evidence.speakers.length, 4);

  const d = stage(r, 'design');
  assert.equal(d.verdict, 'ok');
  // The floor is the point of the design stage: two speakers a viewer with
  // colour blindness cannot tell apart is the defect this project was built on.
  assert.ok(d.evidence.worstDeltaE >= d.evidence.floor,
    `ΔE ${d.evidence.worstDeltaE} is under the floor of ${d.evidence.floor}`);
});

it('every stage says what it is answerable for', async () => {
  // A log that only says pass or fail is not evidence of anything.
  const r = await runTeam({ media: VIDEO, subtitles: LABELLED, out: join(work, 'f.cwi.json') });
  for (const s of r.reports) {
    assert.ok(s.role && s.role.length > 10, `${s.stage} has no stated role`);
    assert.ok(s.summary, `${s.stage} reported nothing`);
    assert.ok(['ok', 'warn', 'stop'].includes(s.verdict));
  }
  assert.deepEqual(r.reports.map((s) => s.stage),
    ['probe', 'transcribe', 'attribute', 'design', 'audit', 'validate']);
});
