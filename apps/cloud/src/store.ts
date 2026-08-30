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
