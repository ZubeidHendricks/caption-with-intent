/**
 * The service API: upload, enqueue, poll, download.
 *
 * Thin on purpose. Every rule it enforces lives in `auth`, `billing`, `queue`
 * or `storage`, and is tested there without a server. What this adds is the
 * order those rules are applied in, which is itself a decision:
 *
 *   1. Authenticate. Nothing else runs for an anonymous caller.
 *   2. Authorise the specific object. Being signed in is not permission to read
 *      *this* job — that check is separate and it is the one that, if skipped,
 *      hands one customer another customer's unreleased footage.
 *   3. Quote before working. The person finds out what a job costs before it
 *      runs, not on an invoice afterwards.
 *   4. Bill on completion, never on acceptance. A job that dies in
 *      transcription has cost the customer nothing.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { type Account, type Store, effectivePlan, newAccount, quote, recordUsage } from './billing.js';
import { type AuthStore, authenticate } from './auth.js';
import { type Job, type JobStore, cancel, enqueue } from './queue.js';
import { type ObjectStore, keys } from './storage.js';

export interface ApiDeps {
  accounts: Store;
  auth: AuthStore;
  jobs: JobStore;
  objects: ObjectStore;
  /** Measures a media file's duration. ffprobe in production. */
  probeDuration: (key: string) => Promise<number>;
  now?: () => Date;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Set for downloads, which stream rather than serialise. */
  stream?: Readable;
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body });

/**
 * Errors say little on purpose.
 *
 * "No such job" and "that job is not yours" are the same answer, because the
 * difference tells someone enumerating ids which ones exist.
 */
const notFound = () => json(404, { error: 'not found' });
const unauthorised = () => json(401, { error: 'not authenticated' });

export async function handle(
  req: { method: string; path: string; query: URLSearchParams; headers: Record<string, string | undefined>; body?: Readable | unknown },
  deps: ApiDeps,
): Promise<ApiResponse> {
  const now = deps.now ? deps.now() : new Date();

  const who = await authenticate(deps.auth, req.headers.authorization, now);
  if (!who.ok) return unauthorised();
  const accountId = who.accountId;

  const account = (await deps.accounts.get(accountId)) ?? newAccount(accountId, undefined, now);

  // --- what am I allowed to do -------------------------------------------
  if (req.method === 'GET' && req.path === '/v1/account') {
    const plan = effectivePlan(account);
    return json(200, {
      id: account.id,
      plan: { id: plan.id, label: plan.label, includedMinutes: plan.includedMinutes },
      status: account.status,
      minutesUsed: Number((account.secondsUsed / 60).toFixed(2)),
      minutesRemaining: Math.max(0, plan.includedMinutes - account.secondsUsed / 60),
      features: plan.features,
    });
  }

  // --- upload -------------------------------------------------------------
  if (req.method === 'POST' && req.path === '/v1/uploads') {
    const ext = extensionOf(req.query.get('filename') ?? '');
    const jobId = `job_${randomUUID()}`;
    const key = keys.input(accountId, jobId, ext);
    if (!(req.body instanceof Readable)) return json(400, { error: 'expected a body' });

    await deps.objects.put(key, req.body);
    const seconds = await deps.probeDuration(key);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      // Cleaned up rather than left costing storage for something unusable.
      await deps.objects.remove(key);
      return json(400, { error: 'that file has no readable media' });
    }

    // Quoted before anything is queued, so the answer arrives before the work
    // and before the bill.
    const q = quote(account, seconds);
    return json(200, {
      jobId,
      key,
      seconds,
      allowed: q.allowed,
      reason: q.reason,
      overagePence: q.overagePence,
      plan: q.plan.id,
    });
  }

  // --- start a job --------------------------------------------------------
  if (req.method === 'POST' && req.path === '/v1/jobs') {
    const body = (req.body ?? {}) as { key?: string; jobId?: string; options?: Record<string, unknown> };
    if (!body.key || !body.jobId) return json(400, { error: 'key and jobId are required' });

    // The key must belong to this account. Without this check a caller could
    // name somebody else's upload and have it captioned — and downloaded.
    if (!body.key.startsWith(`accounts/${accountId.replace(/[^A-Za-z0-9_-]/g, '_')}/`)) {
      return notFound();
    }
    if (!(await deps.objects.exists(body.key))) return notFound();

    const seconds = await deps.probeDuration(body.key);
    const q = quote(account, seconds);
    if (!q.allowed) {
      // 402 rather than 403: this is not forbidden, it is unpaid for, and the
      // difference is what tells a client to show an upgrade rather than an
      // error.
      return json(402, { error: q.reason, plan: q.plan.id, upgrade: true });
    }

    const job = await enqueue(deps.jobs, {
      id: body.jobId,
      accountId,
      input: body.key,
      seconds,
      options: body.options ?? {},
      // The client's retry of this exact request must not queue a second job.
      idempotencyKey: req.headers['idempotency-key'] ?? body.jobId,
      now,
    });
    return json(202, publicJob(job));
  }

  // --- poll ---------------------------------------------------------------
  const jobMatch = /^\/v1\/jobs\/([\w.-]+)$/.exec(req.path);
  if (req.method === 'GET' && jobMatch) {
    const job = await deps.jobs.get(jobMatch[1]);
    // The ownership check and the existence check give the same answer.
    if (!job || job.accountId !== accountId) return notFound();
    return json(200, publicJob(job));
  }

  if (req.method === 'DELETE' && jobMatch) {
    const ok = await cancel(deps.jobs, jobMatch[1], accountId, now);
    return ok ? json(200, { cancelled: true }) : notFound();
  }

  if (req.method === 'GET' && req.path === '/v1/jobs') {
    const list = await deps.jobs.listForAccount(accountId, 50);
    return json(200, { jobs: list.map(publicJob) });
  }

  // --- download -----------------------------------------------------------
  const outMatch = /^\/v1\/jobs\/([\w.-]+)\/output$/.exec(req.path);
  if (req.method === 'GET' && outMatch) {
    const job = await deps.jobs.get(outMatch[1]);
    if (!job || job.accountId !== accountId) return notFound();
    if (job.state !== 'done' || !job.output) return json(409, { error: 'not finished' });
    if (!(await deps.objects.exists(job.output))) return notFound();
    return {
      status: 200,
      body: null,
      headers: { 'Content-Type': 'video/mp4' },
      stream: await deps.objects.get(job.output),
    };
  }

  return notFound();
}

/**
 * Record a finished job against the account.
 *
 * Called by the worker, not by a request. Idempotent on the job id, so the
 * at-least-once queue cannot bill twice — see `recordUsage`.
 */
export async function billCompleted(
  accounts: Store,
  accountId: string,
  job: Job,
): Promise<{ counted: boolean }> {
  const account = await accounts.get(accountId);
  if (!account) return { counted: false };
  const { counted, account: updated } = recordUsage(account, job.id, job.seconds);
  if (counted) await accounts.put(updated);
  return { counted };
}

/** What a client is allowed to see. Internals stay internal. */
function publicJob(job: Job) {
  return {
    id: job.id,
    state: job.state,
    seconds: job.seconds,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    error: job.error,
    // Deliberately absent: leaseOwner, leaseUntil, attempts, and the storage
    // keys. None of it is the customer's business and all of it describes the
    // shape of the fleet.
  };
}

function extensionOf(filename: string): string {
  const m = /(\.[A-Za-z0-9]{1,8})$/.exec(filename);
  return m ? m[1].toLowerCase() : '.bin';
}

/** Adapt a Node request/response pair onto `handle`. */
export async function nodeAdapter(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }

  let body: Readable | unknown = req;
  if (req.method !== 'POST' || !url.pathname.startsWith('/v1/uploads')) {
    if (req.method === 'POST' || req.method === 'DELETE') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    }
  }

  const out = await handle(
    { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers, body },
    deps,
  );

  res.writeHead(out.status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...out.headers,
  });
  if (out.stream) out.stream.pipe(res);
  else res.end(JSON.stringify(out.body));
}
