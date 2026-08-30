/**
 * Who is allowed to process what, and what it costs.
 *
 * The rule this module exists to enforce: **entitlement is decided here, from
 * stored state, never from anything the client says**. A browser that claims to
 * be on the studio plan is a browser making a claim. Every check runs against
 * what Stripe told us through a signed webhook.
 *
 * Metering is billed per minute of media processed, so two failure modes matter
 * more than the rest and both are silent:
 *
 *   - Billing twice for one job. A retried request, a webhook Stripe delivers
 *     again, a user refreshing a page mid-upload. Every recorded unit carries a
 *     job id and recording the same id twice is a no-op.
 *   - Billing for work that failed. A job that dies in transcription has cost
 *     the customer nothing and must cost them nothing. Usage is recorded on
 *     completion, never on acceptance.
 */
export type PlanId = 'free' | 'creator' | 'studio';

export interface Plan {
  id: PlanId;
  label: string;
  /** Minutes included each period. */
  includedMinutes: number;
  /** Longest single upload, in minutes. */
  maxMinutesPerJob: number;
  /** Pence per minute beyond the included allowance. Zero means hard stop. */
  overagePencePerMinute: number;
  features: {
    burnIn: boolean;
    alphaOverlay: boolean;
    multiLanguage: boolean;
    /** The accessibility audit report, as a deliverable a broadcaster accepts. */
    complianceReport: boolean;
  };
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    label: 'Free',
    includedMinutes: 10,
    maxMinutesPerJob: 5,
    // Zero means the job is refused rather than silently charged. A free plan
    // that quietly bills is how people stop trusting a product.
    overagePencePerMinute: 0,
    features: { burnIn: true, alphaOverlay: false, multiLanguage: false, complianceReport: false },
  },
  creator: {
    id: 'creator',
    label: 'Creator',
    includedMinutes: 300,
    maxMinutesPerJob: 60,
    overagePencePerMinute: 8,
    features: { burnIn: true, alphaOverlay: true, multiLanguage: true, complianceReport: false },
  },
  studio: {
    id: 'studio',
    label: 'Studio',
    includedMinutes: 3000,
    maxMinutesPerJob: 240,
    overagePencePerMinute: 5,
    features: { burnIn: true, alphaOverlay: true, multiLanguage: true, complianceReport: true },
  },
};

export type SubscriptionStatus =
  | 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'none';

export interface Account {
  id: string;
  email?: string;
  stripeCustomerId?: string;
  subscriptionId?: string;
  subscriptionItemId?: string;
  plan: PlanId;
  status: SubscriptionStatus;
  /** Start of the billing period usage is counted against, as an ISO date. */
  periodStart: string;
  /** Seconds of media processed this period. Seconds, not minutes: rounding to
   *  minutes per job overcharges someone captioning many short clips. */
  secondsUsed: number;
  /** Job ids already counted, so a retry cannot bill twice. */
  countedJobs: string[];
}

export interface Store {
  get(accountId: string): Promise<Account | undefined>;
  put(account: Account): Promise<void>;
  findByCustomer(stripeCustomerId: string): Promise<Account | undefined>;
  /** Webhook event ids already handled. Stripe delivers events more than once. */
  seenEvent(eventId: string): Promise<boolean>;
  markEvent(eventId: string): Promise<void>;
}

export function newAccount(id: string, email?: string, now = new Date()): Account {
  return {
    id,
    email,
    plan: 'free',
    status: 'none',
    periodStart: now.toISOString().slice(0, 10),
    secondsUsed: 0,
    countedJobs: [],
  };
}

/**
 * A paid plan only counts while the subscription is actually paying.
 *
 * `past_due` deliberately keeps the plan's features. A card that expired on a
 * Tuesday should not strand a production mid-delivery; Stripe will retry, and
 * dunning is a better tool than a locked door. `canceled` does drop to free.
 */
export function effectivePlan(a: Account): Plan {
  const paying = a.status === 'active' || a.status === 'trialing' || a.status === 'past_due';
  return PLANS[paying ? a.plan : 'free'];
}

export interface Quote {
  allowed: boolean;
  plan: Plan;
  reason?: string;
  /** What this job will cost beyond the allowance, in pence. */
  overagePence: number;
  minutesRemaining: number;
}

/**
 * May this account process `seconds` of media, and what will it cost?
 *
 * Called before work starts, so the answer can be shown to the person rather
 * than discovered on an invoice.
 */
export function quote(a: Account, seconds: number): Quote {
  const plan = effectivePlan(a);
  const usedMin = a.secondsUsed / 60;
  const jobMin = seconds / 60;
  const remaining = Math.max(0, plan.includedMinutes - usedMin);

  if (jobMin > plan.maxMinutesPerJob) {
    return {
      allowed: false,
      plan,
      reason: `${plan.label} handles up to ${plan.maxMinutesPerJob} minutes per file; `
        + `this one is ${jobMin.toFixed(1)}.`,
      overagePence: 0,
      minutesRemaining: remaining,
    };
  }

  const beyond = Math.max(0, jobMin - remaining);
  if (beyond > 0 && plan.overagePencePerMinute === 0) {
    return {
      allowed: false,
      plan,
      reason: `${plan.label} includes ${plan.includedMinutes} minutes and `
        + `${usedMin.toFixed(1)} are used. This file needs ${jobMin.toFixed(1)} more.`,
      overagePence: 0,
      minutesRemaining: remaining,
    };
  }

  return {
    allowed: true,
    plan,
    overagePence: Math.ceil(beyond * plan.overagePencePerMinute),
    minutesRemaining: remaining,
  };
}

/**
 * Record a completed job.
 *
 * Idempotent on `jobId`, and that is the whole point: a retry, a duplicate
 * webhook or a double-clicked button must not bill twice. Returns whether this
 * call was the one that counted, so a caller reporting usage to Stripe knows
 * not to report it again.
 */
export function recordUsage(a: Account, jobId: string, seconds: number): { counted: boolean; account: Account } {
  if (a.countedJobs.includes(jobId)) return { counted: false, account: a };
  return {
    counted: true,
    account: {
      ...a,
      secondsUsed: a.secondsUsed + Math.max(0, seconds),
      // Bounded, so an account processing thousands of clips does not grow a
      // record that has to be read in full on every request.
      countedJobs: [...a.countedJobs, jobId].slice(-500),
    },
  };
}

/** Reset the allowance at the start of a new billing period. */
export function rollPeriod(a: Account, periodStart: string): Account {
  if (a.periodStart === periodStart) return a;
  return { ...a, periodStart, secondsUsed: 0, countedJobs: [] };
}

/** Map a Stripe price id onto a plan. Unknown prices do not silently grant one. */
export function planForPrice(priceId: string | undefined, map: Record<string, PlanId>): PlanId | undefined {
  return priceId ? map[priceId] : undefined;
}
