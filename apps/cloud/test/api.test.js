/**
 * The API, tested for the ways one customer reaches another customer's data.
 *
 * This layer adds no rules of its own; it decides the order the rules are
 * applied in. That order is where multi-tenant services leak. Being signed in
 * is not permission to read *this* job, and a service that conflates the two
 * hands one production another production's unreleased footage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  MemoryStore, MemoryAuthStore, MemoryJobStore, DiskStore,
  issueToken, handle, billCompleted, newAccount, enqueue, keys,
} from '../dist/index.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'api-'));
  const deps = {
    accounts: new MemoryStore(),
    auth: new MemoryAuthStore(),
    jobs: new MemoryJobStore(),
    objects: new DiskStore(root),
    probeDuration: async () => 60,
  };
  return { deps, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const call = (deps, method, path, opts = {}) => handle({
  method,
  path,
  query: new URLSearchParams(opts.query ?? ''),
  headers: { authorization: opts.token ? `Bearer ${opts.token}` : undefined, ...opts.headers },
  body: opts.body,
}, deps);

async function signedIn(deps, accountId = 'acct_1') {
  await deps.accounts.put(newAccount(accountId));
  const { token } = await issueToken(deps.auth, { accountId, kind: 'apikey' });
  return token;
}

// --- authentication ---------------------------------------------------------

test('an anonymous caller gets nowhere', async () => {
  const { deps, cleanup } = setup();
  try {
    for (const [m, p] of [['GET', '/v1/account'], ['GET', '/v1/jobs'], ['POST', '/v1/jobs']]) {
      const r = await call(deps, m, p);
      assert.equal(r.status, 401, `${m} ${p} was not refused`);
    }
  } finally { cleanup(); }
});

test('a revoked or bogus token gets nowhere', async () => {
  const { deps, cleanup } = setup();
  try {
    const r = await call(deps, 'GET', '/v1/account', { token: 'chk_made_up' });
    assert.equal(r.status, 401);
  } finally { cleanup(); }
});

// --- tenancy ----------------------------------------------------------------

test('one account cannot read another account\'s job', async () => {
  // The check that matters most in the whole service.
  const { deps, cleanup } = setup();
  try {
    const mine = await signedIn(deps, 'acct_mine');
    await signedIn(deps, 'acct_theirs');
    const theirs = await enqueue(deps.jobs, {
      accountId: 'acct_theirs', input: 'x.mp4', seconds: 10, id: 'job_secret',
    });

    const r = await call(deps, 'GET', `/v1/jobs/${theirs.id}`, { token: mine });
    assert.equal(r.status, 404);
    // Not 403: the difference tells someone enumerating ids which ones exist.
    assert.equal(r.body.error, 'not found');
  } finally { cleanup(); }
});

test('one account cannot download another account\'s output', async () => {
  const { deps, cleanup } = setup();
  try {
    const mine = await signedIn(deps, 'acct_mine');
    const key = keys.output('acct_theirs', 'job_secret', '.mp4');
    await deps.objects.put(key, Readable.from(['their footage']));
    await deps.jobs.put({
      id: 'job_secret', accountId: 'acct_theirs', state: 'done', input: 'i', options: {},
      seconds: 10, attempts: 1, createdAt: new Date().toISOString(), output: key,
    });
    const r = await call(deps, 'GET', '/v1/jobs/job_secret/output', { token: mine });
    assert.equal(r.status, 404);
    assert.equal(r.stream, undefined, 'no bytes were streamed');
  } finally { cleanup(); }
});

test('a job cannot be started against somebody else\'s upload', async () => {
  // Naming another account's key would have it captioned — and then downloaded
  // through a job this caller owns.
  const { deps, cleanup } = setup();
  try {
    const mine = await signedIn(deps, 'acct_mine');
    const theirKey = keys.input('acct_theirs', 'job_x', '.mp4');
    await deps.objects.put(theirKey, Readable.from(['their footage']));

    const r = await call(deps, 'POST', '/v1/jobs', {
      token: mine, body: { key: theirKey, jobId: 'job_new' },
    });
    assert.equal(r.status, 404);
    assert.equal(await deps.jobs.get('job_new'), undefined, 'nothing was queued');
  } finally { cleanup(); }
});

test('one account cannot cancel another account\'s job', async () => {
  const { deps, cleanup } = setup();
  try {
    const mine = await signedIn(deps, 'acct_mine');
    await enqueue(deps.jobs, { accountId: 'acct_theirs', input: 'x', seconds: 5, id: 'job_t' });
    const r = await call(deps, 'DELETE', '/v1/jobs/job_t', { token: mine });
    assert.equal(r.status, 404);
    assert.equal((await deps.jobs.get('job_t')).state, 'queued');
  } finally { cleanup(); }
});

// --- quota ------------------------------------------------------------------

test('an upload is quoted before any work is queued', async () => {
  const { deps, cleanup } = setup();
  try {
    const token = await signedIn(deps);
    const r = await call(deps, 'POST', '/v1/uploads', {
      token, query: 'filename=clip.mp4', body: Readable.from(['media bytes']),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.seconds, 60);
    assert.equal(r.body.allowed, true);
    assert.match(r.body.key, /^accounts\/acct_1\/jobs\/job_[\w-]+\/input\.mp4$/);
  } finally { cleanup(); }
});

test('a job beyond the plan is refused with 402, not 403', async () => {
  // Not forbidden — unpaid for. The difference is what tells a client to show
  // an upgrade rather than an error.
  const { deps, cleanup } = setup();
  try {
    const token = await signedIn(deps);
    deps.probeDuration = async () => 20 * 60;          // free plan allows 5
    const key = keys.input('acct_1', 'job_1', '.mp4');
    await deps.objects.put(key, Readable.from(['x']));

    const r = await call(deps, 'POST', '/v1/jobs', { token, body: { key, jobId: 'job_1' } });
    assert.equal(r.status, 402);
    assert.equal(r.body.upgrade, true);
    assert.equal(await deps.jobs.get('job_1'), undefined, 'nothing was queued');
  } finally { cleanup(); }
});

test('a file with no readable media is refused and not left in storage', async () => {
  const { deps, cleanup } = setup();
  try {
    const token = await signedIn(deps);
    deps.probeDuration = async () => 0;
    const r = await call(deps, 'POST', '/v1/uploads', {
      token, query: 'filename=notes.txt', body: Readable.from(['not media']),
    });
    assert.equal(r.status, 400);
    // Otherwise it costs storage for ever for something unusable.
    assert.equal(await deps.objects.exists(r.body.key ?? 'x'), false);
  } finally { cleanup(); }
});

// --- billing boundaries -----------------------------------------------------

test('a job is billed on completion, never on acceptance', async () => {
  // A job that dies in transcription has cost the customer nothing.
  const { deps, cleanup } = setup();
  try {
    const token = await signedIn(deps);
    const key = keys.input('acct_1', 'job_1', '.mp4');
    await deps.objects.put(key, Readable.from(['x']));
    await call(deps, 'POST', '/v1/jobs', { token, body: { key, jobId: 'job_1' } });

    assert.equal((await deps.accounts.get('acct_1')).secondsUsed, 0, 'queuing must not bill');

    const job = await deps.jobs.get('job_1');
    await billCompleted(deps.accounts, 'acct_1', job);
    assert.equal((await deps.accounts.get('acct_1')).secondsUsed, 60);
  } finally { cleanup(); }
});

test('billing the same job twice counts once', async () => {
  const { deps, cleanup } = setup();
  try {
    await signedIn(deps);
    const job = await enqueue(deps.jobs, {
      accountId: 'acct_1', input: 'x', seconds: 90, id: 'job_1',
    });
    assert.equal((await billCompleted(deps.accounts, 'acct_1', job)).counted, true);
    assert.equal((await billCompleted(deps.accounts, 'acct_1', job)).counted, false);
    assert.equal((await deps.accounts.get('acct_1')).secondsUsed, 90);
  } finally { cleanup(); }
});

test('a retried start does not queue a second job', async () => {
  const { deps, cleanup } = setup();
  try {
    const token = await signedIn(deps);
    const key = keys.input('acct_1', 'job_1', '.mp4');
    await deps.objects.put(key, Readable.from(['x']));
    const body = { key, jobId: 'job_1' };
    const a = await call(deps, 'POST', '/v1/jobs', { token, body });
    const b = await call(deps, 'POST', '/v1/jobs', { token, body });
    assert.equal(a.body.id, b.body.id);
    assert.equal((await deps.jobs.listForAccount('acct_1')).length, 1);
  } finally { cleanup(); }
});

// --- what a client sees -----------------------------------------------------

test('the fleet\'s internals are not in the response', async () => {
  const { deps, cleanup } = setup();
  try {
    const token = await signedIn(deps);
    await deps.jobs.put({
      id: 'job_1', accountId: 'acct_1', state: 'running', input: 'secret/key.mp4',
      options: { hidden: true }, seconds: 60, attempts: 2,
      createdAt: new Date().toISOString(), leaseOwner: 'worker-7',
      leaseUntil: new Date().toISOString(),
    });
    const r = await call(deps, 'GET', '/v1/jobs/job_1', { token });
    const body = JSON.stringify(r.body);
    for (const leak of ['worker-7', 'leaseUntil', 'attempts', 'secret/key.mp4']) {
      assert.equal(body.includes(leak), false, `${leak} leaked to the client`);
    }
    assert.equal(r.body.state, 'running');
  } finally { cleanup(); }
});

test('an unfinished job has nothing to download', async () => {
  const { deps, cleanup } = setup();
  try {
    const token = await signedIn(deps);
    await enqueue(deps.jobs, { accountId: 'acct_1', input: 'x', seconds: 5, id: 'job_1' });
    const r = await call(deps, 'GET', '/v1/jobs/job_1/output', { token });
    assert.equal(r.status, 409);
  } finally { cleanup(); }
});
