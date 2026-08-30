/**
 * Jobs, and surviving the ways workers die.
 *
 * Captioning a feature takes minutes, so the work cannot happen inside a
 * request. That means a queue, and a queue means confronting the fact that
 * workers are killed mid-job — by a deploy, an out-of-memory kill, a spot
 * instance reclaimed, a machine that simply goes away. None of those give the
 * worker a chance to tidy up.
 *
 * So a claimed job is *leased*, not removed. A worker holds a lease it must
 * keep renewing; if it stops renewing, the lease lapses and the job returns to
 * the queue. Nothing is lost when a worker dies, and nothing is stuck forever
 * because a worker died quietly.
 *
 * The consequence is at-least-once delivery: a job can run twice, when a worker
 * finishes just as its lease lapses and a second worker has already picked it
 * up. That cannot be designed away, only handled — which is why billing records
 * usage against a job id and treats a repeat as a no-op. A queue that pretends
 * to be exactly-once is a queue that bills twice.
 */
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  accountId: string;
  state: JobState;
  /** Where the input lives in object storage. */
  input: string;
  /** Options for the captioning team. */
  options: Record<string, unknown>;
  /** Media duration in seconds, measured at upload. Drives billing. */
  seconds: number;
  attempts: number;
  createdAt: string;
  /** Set while running. The job returns to the queue if this passes. */
  leaseUntil?: string;
  /** Which worker holds it, for logs and for the dashboard. */
  leaseOwner?: string;
  finishedAt?: string;
  output?: string;
  error?: string;
  /** Supplied by the caller so a retried request does not enqueue twice. */
  idempotencyKey?: string;
}

export interface JobStore {
  put(job: Job): Promise<void>;
  get(id: string): Promise<Job | undefined>;
  /** Oldest queued job, or one whose lease has lapsed. */
  claimable(now: string): Promise<Job | undefined>;
  byIdempotencyKey(accountId: string, key: string): Promise<Job | undefined>;
  listForAccount(accountId: string, limit?: number): Promise<Job[]>;
}

/** How long a worker holds a job before it must renew. */
export const LEASE_SECONDS = 120;
/**
 * Attempts before a job is given up on. Three is a judgement: enough to survive
 * a deploy and a transient failure, few enough that a job which always crashes
 * a worker cannot take the fleet down with it.
 */
export const MAX_ATTEMPTS = 3;

export interface EnqueueOptions {
  accountId: string;
  input: string;
  seconds: number;
  options?: Record<string, unknown>;
  idempotencyKey?: string;
  id?: string;
  now?: Date;
}

/**
 * Add a job, or return the one this request already created.
 *
 * The idempotency key is what stops a retried upload from being captioned —
 * and billed — twice. Without it the second attempt looks exactly like a second
 * job, because that is all it is at the HTTP layer.
 */
export async function enqueue(store: JobStore, opts: EnqueueOptions): Promise<Job> {
  const now = opts.now ?? new Date();
  if (opts.idempotencyKey) {
    const existing = await store.byIdempotencyKey(opts.accountId, opts.idempotencyKey);
    if (existing) return existing;
  }
  const job: Job = {
    id: opts.id ?? `job_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    accountId: opts.accountId,
    state: 'queued',
    input: opts.input,
    options: opts.options ?? {},
    seconds: opts.seconds,
    attempts: 0,
    createdAt: now.toISOString(),
    idempotencyKey: opts.idempotencyKey,
  };
  await store.put(job);
  return job;
}

/**
 * Take the next job, if there is one.
 *
 * Claims either a queued job or one whose lease has lapsed — the second case
 * being a job whose worker died. `attempts` counts claims rather than failures,
 * so a job that repeatedly kills its worker still reaches the limit and stops.
 * Counting only explicit failures would let such a job cycle for ever, since a
 * worker that dies never reports anything.
 */
export async function claim(
  store: JobStore,
  worker: string,
  now: Date = new Date(),
): Promise<Job | undefined> {
  const job = await store.claimable(now.toISOString());
  if (!job) return undefined;

  const attempts = job.attempts + 1;
  if (attempts > MAX_ATTEMPTS) {
    const dead: Job = {
      ...job,
      state: 'failed',
      error: `gave up after ${MAX_ATTEMPTS} attempts`,
      finishedAt: now.toISOString(),
      leaseUntil: undefined,
      leaseOwner: undefined,
    };
    await store.put(dead);
    // Recurse rather than return: the caller asked for work, and this job is
    // not it. One dead job should not look like an empty queue.
    return claim(store, worker, now);
  }

  const claimed: Job = {
    ...job,
    state: 'running',
    attempts,
    leaseOwner: worker,
    leaseUntil: new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString(),
  };
  await store.put(claimed);
  return claimed;
}

/**
 * Extend a lease while work continues.
 *
 * Refuses if another worker now holds it: a worker whose lease lapsed while it
 * was still alive must find out and stop, rather than carrying on and writing
 * output for a job somebody else is also running.
 */
export async function heartbeat(
  store: JobStore,
  jobId: string,
  worker: string,
  now: Date = new Date(),
): Promise<boolean> {
  const job = await store.get(jobId);
  if (!job || job.state !== 'running' || job.leaseOwner !== worker) return false;
  await store.put({
    ...job,
    leaseUntil: new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString(),
  });
  return true;
}

/** Finish a job. Rejected if the lease has moved on, for the same reason. */
export async function complete(
  store: JobStore,
  jobId: string,
  worker: string,
  output: string,
  now: Date = new Date(),
): Promise<boolean> {
  const job = await store.get(jobId);
  if (!job) return false;
  // Checked before the lease, and the order is the whole point: completing
  // clears the lease owner, so a duplicate completion has no owner to match and
  // would be rejected — telling a worker its finished job failed. Duplicates
  // are normal here, because at-least-once is what a lease buys.
  if (job.state === 'done') return true;
  if (job.leaseOwner !== worker) return false;
  await store.put({
    ...job,
    state: 'done',
    output,
    finishedAt: now.toISOString(),
    leaseUntil: undefined,
    leaseOwner: undefined,
  });
  return true;
}

/**
 * Report a failure.
 *
 * Returns the job to the queue while attempts remain, because most failures are
 * transient — a network blip, a machine under pressure. `permanent` skips the
 * retries for failures that will never succeed: a corrupt file is not going to
 * decode on the third attempt, and retrying it just bills the customer's
 * patience.
 */
export async function fail(
  store: JobStore,
  jobId: string,
  worker: string,
  error: string,
  opts: { permanent?: boolean; now?: Date } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const job = await store.get(jobId);
  if (!job || job.leaseOwner !== worker) return;

  const exhausted = opts.permanent || job.attempts >= MAX_ATTEMPTS;
  await store.put({
    ...job,
    state: exhausted ? 'failed' : 'queued',
    error,
    ...(exhausted ? { finishedAt: now.toISOString() } : {}),
    leaseUntil: undefined,
    leaseOwner: undefined,
  });
}

/** Cancel a job. A running one is left to notice through its heartbeat. */
export async function cancel(store: JobStore, jobId: string, accountId: string,
                             now: Date = new Date()): Promise<boolean> {
  const job = await store.get(jobId);
  // The account check is authorisation, not validation: without it any signed-in
  // user could cancel anybody's job by guessing an id.
  if (!job || job.accountId !== accountId) return false;
  if (job.state === 'done' || job.state === 'failed') return false;
  await store.put({
    ...job,
    state: 'cancelled',
    finishedAt: now.toISOString(),
    leaseUntil: undefined,
    leaseOwner: undefined,
  });
  return true;
}
