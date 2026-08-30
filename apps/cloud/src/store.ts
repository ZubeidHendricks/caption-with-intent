/**
 * Storage, behind an interface, with an in-memory implementation.
 *
 * The real one will be Postgres or whatever the hosted service settles on. The
 * point of the interface is that every billing rule in this package is testable
 * without a database, and that the rules cannot quietly come to depend on one.
 *
 * `MemoryStore` is for tests and local runs only. It says so rather than
 * pretending, because an in-memory store that ends up in production loses every
 * subscription on restart.
 */
import type { Account, Store } from './billing.js';
import type { AuthStore, SignInLink, TokenRecord } from './auth.js';
import type { Job, JobStore } from './queue.js';

export class MemoryStore implements Store {
  private accounts = new Map<string, Account>();
  private events = new Set<string>();

  async get(id: string): Promise<Account | undefined> {
    const a = this.accounts.get(id);
    return a ? { ...a, countedJobs: [...a.countedJobs] } : undefined;
  }

  async put(a: Account): Promise<void> {
    this.accounts.set(a.id, { ...a, countedJobs: [...a.countedJobs] });
  }

  async findByCustomer(customerId: string): Promise<Account | undefined> {
    for (const a of this.accounts.values()) {
      if (a.stripeCustomerId === customerId) return { ...a, countedJobs: [...a.countedJobs] };
    }
    return undefined;
  }

  async seenEvent(id: string): Promise<boolean> {
    return this.events.has(id);
  }

  async markEvent(id: string): Promise<void> {
    this.events.add(id);
  }

  /** Test helper. Not part of the interface on purpose. */
  all(): Account[] {
    return [...this.accounts.values()];
  }
}


export class MemoryAuthStore implements AuthStore {
  private tokens = new Map<string, TokenRecord>();
  private links = new Map<string, SignInLink>();
  private emails = new Map<string, string>();

  async putToken(t: TokenRecord): Promise<void> { this.tokens.set(t.hash, { ...t }); }
  async getToken(hash: string): Promise<TokenRecord | undefined> {
    const t = this.tokens.get(hash);
    return t ? { ...t } : undefined;
  }
  async listTokens(accountId: string): Promise<TokenRecord[]> {
    return [...this.tokens.values()].filter((t) => t.accountId === accountId).map((t) => ({ ...t }));
  }
  async putLink(l: SignInLink): Promise<void> { this.links.set(l.hash, { ...l }); }
  async getLink(hash: string): Promise<SignInLink | undefined> {
    const l = this.links.get(hash);
    return l ? { ...l } : undefined;
  }
  async accountForEmail(email: string): Promise<string> {
    const key = email.trim().toLowerCase();
    let id = this.emails.get(key);
    if (!id) {
      id = 'acct_' + Buffer.from(key).toString('hex').slice(0, 16);
      this.emails.set(key, id);
    }
    return id;
  }
}

export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, Job>();

  async put(job: Job): Promise<void> { this.jobs.set(job.id, { ...job }); }
  async get(id: string): Promise<Job | undefined> {
    const j = this.jobs.get(id);
    return j ? { ...j } : undefined;
  }

  /**
   * Oldest job that is either queued or whose lease has lapsed.
   *
   * The lapsed case is what makes a dead worker recoverable: its job looks
   * running, nobody is renewing the lease, and once it passes the job is fair
   * game again.
   */
  async claimable(now: string): Promise<Job | undefined> {
    const candidates = [...this.jobs.values()].filter((j) =>
      j.state === 'queued' || (j.state === 'running' && (j.leaseUntil ?? '') < now));
    candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const j = candidates[0];
    return j ? { ...j } : undefined;
  }

  async byIdempotencyKey(accountId: string, key: string): Promise<Job | undefined> {
    for (const j of this.jobs.values()) {
      if (j.accountId === accountId && j.idempotencyKey === key) return { ...j };
    }
    return undefined;
  }

  async listForAccount(accountId: string, limit = 50): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter((j) => j.accountId === accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }
}
