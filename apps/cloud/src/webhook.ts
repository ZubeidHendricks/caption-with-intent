/**
 * Turning Stripe's events into account state.
 *
 * Everything a customer is entitled to comes from here. Nothing a browser
 * sends changes a plan, because a browser is not a source of truth about who
 * has paid.
 *
 * Two properties the handler must have, both learned by the industry the
 * expensive way:
 *
 *   - **Idempotent.** Stripe delivers each event at least once and will resend
 *     on any non-2xx, including a timeout after the work succeeded. Handling
 *     `subscription.created` twice must not create two subscriptions.
 *   - **Order-independent.** Events arrive out of order more often than anyone
 *     expects. A `deleted` that lands before its `updated` must not be undone
 *     by the late arrival, so state carries the event's own timestamp and an
 *     older event never overwrites a newer one.
 */
import {
  type Account, type PlanId, type Store, type SubscriptionStatus,
  newAccount, rollPeriod,
} from './billing.js';
import { verifySignature } from './stripe.js';

export interface WebhookResult {
  handled: boolean;
  /** Why, in words, for the log. Never contains customer details. */
  detail: string;
  accountId?: string;
}

export interface HandlerOptions {
  store: Store;
  webhookSecret: string;
  /** Stripe price id -> plan. A price not in here grants nothing. */
  priceToPlan: Record<string, PlanId>;
  now?: () => number;
}

const STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  paused: 'canceled',
};

/**
 * Handle one webhook delivery.
 *
 * `rawBody` must be exactly the bytes that arrived. Parsing and re-serialising
 * changes them and every signature then fails — which presents as "Stripe is
 * sending bad signatures" and is not.
 */
export async function handleWebhook(
  rawBody: string,
  signatureHeader: string,
  opts: HandlerOptions,
): Promise<WebhookResult> {
  const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  const verified = verifySignature(rawBody, signatureHeader, opts.webhookSecret, 300, now);
  if (!verified.ok) {
    // Deliberately terse. A verbose rejection tells someone probing the
    // endpoint exactly which part of their forgery to fix.
    return { handled: false, detail: `signature rejected: ${verified.reason}` };
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { handled: false, detail: 'body is not JSON' };
  }
  if (!event?.id || !event?.type) return { handled: false, detail: 'not a Stripe event' };

  if (await opts.store.seenEvent(event.id)) {
    // A duplicate is success, not an error: returning non-2xx would make Stripe
    // retry it again, for ever.
    return { handled: true, detail: `${event.type} already handled`, accountId: undefined };
  }

  const result = await apply(event, opts);
  await opts.store.markEvent(event.id);
  return result;
}

async function apply(event: any, opts: HandlerOptions): Promise<WebhookResult> {
  const o = event.data?.object ?? {};
  const eventTime: number = event.created ?? 0;

  switch (event.type) {
    case 'checkout.session.completed': {
      // client_reference_id is our own account id, set when the session was
      // created. Never trust an id that came back through the browser instead.
      const accountId = o.client_reference_id;
      if (!accountId) return { handled: false, detail: 'checkout without a client_reference_id' };

      const account = (await opts.store.get(accountId)) ?? newAccount(accountId, o.customer_details?.email);
      await opts.store.put({
        ...account,
        email: account.email ?? o.customer_details?.email,
        stripeCustomerId: o.customer ?? account.stripeCustomerId,
        subscriptionId: o.subscription ?? account.subscriptionId,
        // The plan is NOT set here. This event says a checkout finished, not
        // that a subscription is active and paid; the subscription events say
        // that, and letting checkout grant a plan is how an abandoned or failed
        // payment ends up entitled.
      });
      return { handled: true, detail: 'checkout completed, awaiting subscription', accountId };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const customerId = typeof o.customer === 'string' ? o.customer : o.customer?.id;
      if (!customerId) return { handled: false, detail: 'subscription without a customer' };
      const account = await opts.store.findByCustomer(customerId);
      if (!account) return { handled: false, detail: 'no account for that customer' };

      const lastSeen = (account as Account & { lastEventAt?: number }).lastEventAt ?? 0;
      if (eventTime && eventTime < lastSeen) {
        return { handled: true, detail: 'older than the state we hold; ignored', accountId: account.id };
      }

      const item = o.items?.data?.[0];
      const priceId = item?.price?.id;
      const plan = opts.priceToPlan[priceId ?? ''];
      const deleted = event.type === 'customer.subscription.deleted';
      const status: SubscriptionStatus = deleted ? 'canceled' : (STATUS[o.status] ?? 'none');

      // A period boundary resets the allowance. Stripe gives it on the
      // subscription, so usage never has to be reset by a clock we own.
      const periodStart = o.current_period_start
        ? new Date(o.current_period_start * 1000).toISOString().slice(0, 10)
        : account.periodStart;

      const rolled = rollPeriod(account, periodStart);
      await opts.store.put({
        ...rolled,
        subscriptionId: deleted ? undefined : (o.id ?? rolled.subscriptionId),
        subscriptionItemId: deleted ? undefined : (item?.id ?? rolled.subscriptionItemId),
        // An unknown price cannot grant a plan. Keeping the old one is the safe
        // failure: it neither strands a paying customer nor upgrades anyone by
        // accident.
        plan: deleted ? 'free' : (plan ?? rolled.plan),
        status,
        ...(eventTime ? { lastEventAt: eventTime } : {}),
      } as Account);

      return {
        handled: true,
        detail: `subscription ${status}${plan ? ` on ${plan}` : ''}`,
        accountId: account.id,
      };
    }

    case 'invoice.payment_failed': {
      const customerId = typeof o.customer === 'string' ? o.customer : o.customer?.id;
      const account = customerId ? await opts.store.findByCustomer(customerId) : undefined;
      if (!account) return { handled: false, detail: 'no account for that customer' };
      // Marked, not cut off. Stripe retries for weeks; taking the tools away on
      // the first failed retry punishes an expired card, not a non-payer.
      await opts.store.put({ ...account, status: 'past_due' });
      return { handled: true, detail: 'payment failed, marked past_due', accountId: account.id };
    }

    default:
      // Unrecognised events are acknowledged rather than rejected, or Stripe
      // retries every event this service does not care about, for ever.
      return { handled: true, detail: `ignored ${event.type}` };
  }
}

/** The events this endpoint needs. Anything else is noise and retries. */
export const SUBSCRIBED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
] as const;
