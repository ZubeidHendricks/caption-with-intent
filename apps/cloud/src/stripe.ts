/**
 * The Stripe calls this service actually makes, and the webhook check.
 *
 * Written against the REST API with `fetch` rather than pulling in the SDK.
 * Three reasons, in order of how much they matter: webhook signature
 * verification is the security boundary of the whole billing system and is
 * forty lines of HMAC that I would rather be able to read; the tests can then
 * construct valid and invalid signatures directly, offline, with no network and
 * no keys; and a payment dependency that updates itself under a service is a
 * thing to avoid, not embrace.
 *
 * No key is ever read from anywhere but the environment, and nothing here logs
 * a key, a card, or a customer's details.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** Price to subscribe customers to. A Stripe price id, not an amount. */
  priceId?: string;
  /** Metered price for per-minute usage, if usage is billed separately. */
  meteredPriceId?: string;
  baseUrl?: string;
}

export class StripeError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'StripeError';
  }
}

/**
 * Read configuration from the environment.
 *
 * Throws rather than falling back to a default, because every plausible default
 * is wrong: a missing secret key means unconfigured, and a *silently* missing
 * webhook secret means every forged webhook is accepted.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey) throw new StripeError('STRIPE_SECRET_KEY is not set.');
  if (!webhookSecret) {
    throw new StripeError(
      'STRIPE_WEBHOOK_SECRET is not set. Without it webhook signatures cannot be '
      + 'verified, and anyone who finds the endpoint can grant themselves a subscription.');
  }
  return {
    secretKey,
    webhookSecret,
    priceId: env.STRIPE_PRICE_ID,
    meteredPriceId: env.STRIPE_METERED_PRICE_ID,
    baseUrl: env.STRIPE_BASE_URL ?? 'https://api.stripe.com/v1',
  };
}

/** Is this key a test key? Used to keep test and live data from mixing. */
export function isTestKey(secretKey: string): boolean {
  return secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_');
}

/**
 * Verify a Stripe webhook signature.
 *
 * This is the only thing standing between "a customer subscribed" and "someone
 * posted JSON at your endpoint". The scheme is documented by Stripe: the header
 * carries a timestamp and one or more v1 signatures, each an HMAC-SHA256 of
 * `timestamp.payload` under the endpoint secret.
 *
 * Three properties matter and each is easy to get wrong:
 *
 *   - Compare in constant time. A plain `===` leaks the signature a byte at a
 *     time to anyone willing to measure.
 *   - Check the timestamp. Without it a valid webhook captured once can be
 *     replayed for ever, which for a `subscription.deleted` event means a
 *     cancellation that keeps re-applying, and for `checkout.completed` means a
 *     subscription that can be re-granted at will.
 *   - Verify against the *raw* body. Parsing and re-serialising changes the
 *     bytes and every signature fails, so the caller must hand over what
 *     arrived on the wire.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300,
  now: number = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  if (!signatureHeader) return { ok: false, reason: 'no signature header' };

  const parts = new Map<string, string[]>();
  for (const piece of signatureHeader.split(',')) {
    const [k, v] = piece.split('=', 2);
    if (!k || !v) continue;
    const key = k.trim();
    parts.set(key, [...(parts.get(key) ?? []), v.trim()]);
  }

  const timestamp = parts.get('t')?.[0];
  const signatures = parts.get('v1') ?? [];
  if (!timestamp) return { ok: false, reason: 'no timestamp in signature header' };
  if (!signatures.length) return { ok: false, reason: 'no v1 signature in header' };

  const age = Math.abs(now - Number(timestamp));
  if (!Number.isFinite(age)) return { ok: false, reason: 'unreadable timestamp' };
  if (age > toleranceSeconds) {
    return { ok: false, reason: `timestamp is ${age}s away, outside the ${toleranceSeconds}s window` };
  }

  const expected = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  // Stripe may send several signatures during a secret rotation; any match is
  // enough. Compared in constant time, and length-checked first because
  // timingSafeEqual throws on a length mismatch.
  const expectedBuf = Buffer.from(expected, 'utf8');
  for (const candidate of signatures) {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    if (candidateBuf.length !== expectedBuf.length) continue;
    if (timingSafeEqual(candidateBuf, expectedBuf)) return { ok: true };
  }
  return { ok: false, reason: 'no signature matched' };
}

/** Sign a payload the way Stripe would. Exists so the tests can be honest. */
export function signPayload(rawBody: string, secret: string, timestamp: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

// --- API calls --------------------------------------------------------------

type Form = Record<string, string | number | undefined>;

async function post(cfg: StripeConfig, path: string, form: Form, idempotencyKey?: string): Promise<any> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (v !== undefined) body.set(k, String(v));
  }
  const res = await fetch(`${cfg.baseUrl ?? 'https://api.stripe.com/v1'}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Stripe retries on network failure, and a retried checkout without this
      // creates a second subscription for the same customer.
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new StripeError(json?.error?.message ?? `Stripe returned ${res.status}`,
      res.status, json?.error?.code);
  }
  return json;
}

/**
 * Start a subscription checkout.
 *
 * `clientReference` is this service's own account id. It comes back on the
 * completed event and is how a Stripe customer is tied to an account without
 * trusting anything the browser sends back.
 */
export async function createCheckoutSession(
  cfg: StripeConfig,
  opts: { accountId: string; email?: string; successUrl: string; cancelUrl: string },
): Promise<{ id: string; url: string }> {
  if (!cfg.priceId) throw new StripeError('STRIPE_PRICE_ID is not set.');
  const s = await post(cfg, '/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': cfg.priceId,
    'line_items[0][quantity]': 1,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.accountId,
    customer_email: opts.email,
  }, `checkout:${opts.accountId}`);
  return { id: s.id, url: s.url };
}

/** A link to Stripe's own billing portal, so this service never shows a card. */
export async function createPortalSession(
  cfg: StripeConfig,
  opts: { customerId: string; returnUrl: string },
): Promise<{ url: string }> {
  const s = await post(cfg, '/billing_portal/sessions', {
    customer: opts.customerId,
    return_url: opts.returnUrl,
  });
  return { url: s.url };
}

/**
 * Report metered usage.
 *
 * `action: 'set'` rather than the default increment, and one record per period,
 * so a retry cannot bill the same minutes twice. Stripe's increment semantics
 * plus network retries is a double-billing incident waiting to happen.
 */
export async function reportUsage(
  cfg: StripeConfig,
  opts: { subscriptionItemId: string; quantity: number; timestamp?: number; idempotencyKey?: string },
): Promise<void> {
  await post(cfg, `/subscription_items/${opts.subscriptionItemId}/usage_records`, {
    quantity: Math.max(0, Math.round(opts.quantity)),
    timestamp: opts.timestamp,
    action: 'set',
  }, opts.idempotencyKey);
}
