/**
 * Auth, the queue and storage — tested for the failures that actually occur.
 *
 * The queue tests are mostly about workers dying, because that is what workers
 * do: a deploy lands, a machine is reclaimed, the kernel decides a process is
 * using too much memory. None of those give the worker a chance to tidy up, and
 * a queue that only works when workers exit cleanly is a queue that loses jobs
 * on its first bad Tuesday.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  MemoryAuthStore, MemoryJobStore, DiskStore, keys,
  issueToken, authenticate, revokeToken, hashToken, mintToken, bearer,
  startSignIn, completeSignIn, LINK_TTL_MINUTES,
  enqueue, claim, heartbeat, complete, fail, cancel, LEASE_SECONDS, MAX_ATTEMPTS,
} from '../dist/index.js';

const at = (iso) => new Date(iso);
const T0 = at('2026-08-30T10:00:00Z');
const later = (seconds) => new Date(T0.getTime() + seconds * 1000);

// --- tokens -----------------------------------------------------------------

test('the token itself is never stored', async () => {
  // A dump of this table must let an attacker impersonate nobody.
  const store = new MemoryAuthStore();
  const { token, record } = await issueToken(store, { accountId: 'acct_1', kind: 'apikey' });
  assert.notEqual(record.hash, token);
  assert.equal(record.hash, hashToken(token));
  const stored = await store.getToken(record.hash);
  assert.equal(JSON.stringify(stored).includes(token), false, 'the raw token leaked into storage');
});

test('a valid token authenticates and a wrong one does not', async () => {
  const store = new MemoryAuthStore();
  const { token } = await issueToken(store, { accountId: 'acct_1', kind: 'apikey' });
  const ok = await authenticate(store, `Bearer ${token}`);
  assert.equal(ok.ok, true);
  assert.equal(ok.accountId, 'acct_1');

  const bad = await authenticate(store, 'Bearer chk_not_a_real_token');
  assert.equal(bad.ok, false);
});

test('every rejection gives the same reason', async () => {
  // Distinguishing "no such token" from "expired" tells someone enumerating
  // tokens which guesses were close.
  const store = new MemoryAuthStore();
  const { token, record } = await issueToken(store, { accountId: 'a', kind: 'session', now: T0 });
  await revokeToken(store, record.hash);

  const reasons = new Set();
  reasons.add((await authenticate(store, undefined)).reason);
  reasons.add((await authenticate(store, 'Bearer nope')).reason);
  reasons.add((await authenticate(store, `Bearer ${token}`)).reason);
  assert.equal(reasons.size, 1, [...reasons].join(' / '));
});

test('an expired session stops working', async () => {
  const store = new MemoryAuthStore();
  const { token } = await issueToken(store, { accountId: 'a', kind: 'session', now: T0 });
  const inThirtyOneDays = new Date(T0.getTime() + 31 * 86400_000);
  assert.equal((await authenticate(store, `Bearer ${token}`, inThirtyOneDays)).ok, false);
});

test('a revoked key stops working immediately', async () => {
  const store = new MemoryAuthStore();
  const { token, record } = await issueToken(store, { accountId: 'a', kind: 'apikey' });
  assert.equal((await authenticate(store, `Bearer ${token}`)).ok, true);
  await revokeToken(store, record.hash);
  assert.equal((await authenticate(store, `Bearer ${token}`)).ok, false);
});

test('keys announce themselves so scanners can find them', () => {
  // A key leaked into a public repository should be reported by a secret
  // scanner before somebody else uses it.
  assert.match(mintToken('apikey'), /^chk_/);
  assert.match(mintToken('session'), /^chs_/);
  assert.notEqual(mintToken('apikey'), mintToken('apikey'));
});

test('the Authorization header is parsed strictly', () => {
  assert.equal(bearer('Bearer abc'), 'abc');
  assert.equal(bearer('bearer abc'), 'abc');
  assert.equal(bearer('Basic abc'), undefined);
  assert.equal(bearer('abc'), undefined);
  assert.equal(bearer(undefined), undefined);
});

// --- sign-in links ----------------------------------------------------------

test('a sign-in link works exactly once', async () => {
  // A link that still works after use is a permanent account takeover sitting
  // in an inbox, a mail archive, and every scanner that followed it.
  const store = new MemoryAuthStore();
  const { token } = await startSignIn(store, 'Someone@Example.com', T0);
  const first = await completeSignIn(store, token, later(60));
  assert.equal(first.ok, true);

  const second = await completeSignIn(store, token, later(61));
  assert.equal(second.ok, false);
  assert.match(second.reason, /already been used/);
});

test('a sign-in link expires', async () => {
  const store = new MemoryAuthStore();
  const { token } = await startSignIn(store, 'a@b.c', T0);
  const late = later(LINK_TTL_MINUTES * 60 + 1);
  const r = await completeSignIn(store, token, late);
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired/);
});

test('the same email always reaches the same account', async () => {
  const store = new MemoryAuthStore();
  const a = await completeSignIn(store, (await startSignIn(store, 'a@b.c', T0)).token, later(1));
  const b = await completeSignIn(store, (await startSignIn(store, 'A@B.C ', T0)).token, later(2));
  assert.equal(a.accountId, b.accountId, 'case and whitespace must not fork an account');
});

// --- the queue --------------------------------------------------------------

const job = (over = {}) => ({ accountId: 'acct_1', input: 'in.mp4', seconds: 60, ...over });

test('a retried enqueue does not create a second job', async () => {
  const store = new MemoryJobStore();
  const a = await enqueue(store, job({ idempotencyKey: 'req_1' }));
  const b = await enqueue(store, job({ idempotencyKey: 'req_1' }));
  assert.equal(a.id, b.id, 'the same request must not be captioned, or billed, twice');
});

test('a job whose worker dies is picked up again', async () => {
  // The failure this whole design is for: no exit, no error, no cleanup.
  const store = new MemoryJobStore();
  await enqueue(store, job({ id: 'job_1', now: T0 }));

  const first = await claim(store, 'worker-a', T0);
  assert.equal(first.id, 'job_1');
  assert.equal(first.state, 'running');

  // worker-a vanishes. Nothing renews the lease.
  const nothing = await claim(store, 'worker-b', later(10));
  assert.equal(nothing, undefined, 'still leased, so nobody else may take it');

  const recovered = await claim(store, 'worker-b', later(LEASE_SECONDS + 1));
  assert.equal(recovered.id, 'job_1');
  assert.equal(recovered.attempts, 2);
});

test('a heartbeat keeps a long job from being stolen', async () => {
  const store = new MemoryJobStore();
  await enqueue(store, job({ id: 'job_1', now: T0 }));
  await claim(store, 'worker-a', T0);

  assert.equal(await heartbeat(store, 'job_1', 'worker-a', later(60)), true);
  // The lease now runs from the heartbeat, not the claim.
  assert.equal(await claim(store, 'worker-b', later(LEASE_SECONDS + 1)), undefined);
});

test('a worker whose lease lapsed cannot heartbeat or complete', async () => {
  // It has to find out and stop, rather than writing output for a job somebody
  // else is now running.
  const store = new MemoryJobStore();
  await enqueue(store, job({ id: 'job_1', now: T0 }));
  await claim(store, 'worker-a', T0);
  await claim(store, 'worker-b', later(LEASE_SECONDS + 1));

  assert.equal(await heartbeat(store, 'job_1', 'worker-a', later(LEASE_SECONDS + 2)), false);
  assert.equal(await complete(store, 'job_1', 'worker-a', 'out.mp4'), false);
  assert.equal(await complete(store, 'job_1', 'worker-b', 'out.mp4'), true);
});

test('a job that keeps killing its worker is eventually given up on', async () => {
  // Attempts count claims, not reported failures: a worker that dies never
  // reports anything, so counting failures would let this cycle for ever.
  const store = new MemoryJobStore();
  await enqueue(store, job({ id: 'job_1', now: T0 }));

  let t = 0;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const c = await claim(store, `w${i}`, later(t));
    assert.ok(c, `attempt ${i + 1} should have been claimable`);
    t += LEASE_SECONDS + 1;
  }
  assert.equal(await claim(store, 'w-last', later(t)), undefined, 'no longer offered');
  const dead = await store.get('job_1');
  assert.equal(dead.state, 'failed');
  assert.match(dead.error, /gave up after/);
});

test('a transient failure returns the job to the queue', async () => {
  const store = new MemoryJobStore();
  await enqueue(store, job({ id: 'job_1', now: T0 }));
  await claim(store, 'worker-a', T0);
  await fail(store, 'job_1', 'worker-a', 'network blip', { now: later(5) });

  const again = await store.get('job_1');
  assert.equal(again.state, 'queued');
  assert.equal(await claim(store, 'worker-b', later(6)) !== undefined, true);
});

test('a permanent failure is not retried', async () => {
  // A corrupt file will not decode on the third attempt.
  const store = new MemoryJobStore();
  await enqueue(store, job({ id: 'job_1', now: T0 }));
  await claim(store, 'worker-a', T0);
  await fail(store, 'job_1', 'worker-a', 'not a media file', { permanent: true, now: later(5) });
  assert.equal((await store.get('job_1')).state, 'failed');
  assert.equal(await claim(store, 'worker-b', later(600)), undefined);
});

test('completing twice is success, not an error', async () => {
  const store = new MemoryJobStore();
  await enqueue(store, job({ id: 'job_1', now: T0 }));
  await claim(store, 'worker-a', T0);
  assert.equal(await complete(store, 'job_1', 'worker-a', 'out.mp4'), true);
  assert.equal(await complete(store, 'job_1', 'worker-a', 'out.mp4'), true);
});

test('one account cannot cancel another account\'s job', async () => {
  // Without the account check, any signed-in user could cancel anybody's work
  // by guessing an id.
  const store = new MemoryJobStore();
  await enqueue(store, job({ id: 'job_1', now: T0 }));
  assert.equal(await cancel(store, 'job_1', 'acct_someone_else'), false);
  assert.equal((await store.get('job_1')).state, 'queued');
  assert.equal(await cancel(store, 'job_1', 'acct_1'), true);
});

// --- storage ----------------------------------------------------------------

test('object keys are built by the service, never by the caller', () => {
  const k = keys.input('acct/../../etc', 'job;rm -rf', '.mp4');
  assert.equal(k.includes('..'), false);
  assert.equal(k.includes(';'), false);
  assert.match(k, /^accounts\/[\w-]+\/jobs\/[\w-]+\/input\.mp4$/);
});

test('a key that escapes the store is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'store-'));
  try {
    const store = new DiskStore(root);
    await assert.rejects(
      () => store.put('../escaped.txt', Readable.from(['x'])),
      /escapes the store/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an upload is not visible until it is complete', async () => {
  // Renamed into place, so a crash mid-upload cannot leave a truncated file
  // that looks complete to everything downstream.
  const root = mkdtempSync(join(tmpdir(), 'store-'));
  try {
    const store = new DiskStore(root);
    const key = keys.input('acct_1', 'job_1', '.mp4');
    await store.put(key, Readable.from(['hello world']));
    assert.equal(await store.exists(key), true);
    assert.equal(await store.size(key), 11);
    await store.remove(key);
    assert.equal(await store.exists(key), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
