/**
 * Billing, tested for the ways it loses money or takes too much.
 *
 * The happy path is one test. The rest are the cases that cost real money or
 * real trust: a forged webhook, a replayed one, a duplicate delivery, events
 * arriving out of order, a job billed twice, a job billed after it failed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANS, newAccount, effectivePlan, quote, recordUsage, rollPeriod,
  MemoryStore, handleWebhook, verifySignature, signPayload, configFromEnv, isTestKey,
} from '../dist/index.js';

const SECRET = 'whsec_test_secret';
const PRICE_TO_PLAN = { price_creator: 'creator', price_studio: 'studio' };

const post = async (store, event, { secret = SECRET, at, now } = {}) => {
  const raw = JSON.stringify(event);
  const ts = at ?? Math.floor(Date.now() / 1000);
  return handleWebhook(raw, signPayload(raw, secret, ts), {
    store, webhookSecret: SECRET, priceToPlan: PRICE_TO_PLAN,
    now: () => now ?? ts,
  });
};

const subscription = (over = {}) => ({
  id: 'evt_' + Math.random().toString(36).slice(2),
  type: 'customer.subscription.updated',
  created: 1_700_000_000,
  data: {
    object: {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      current_period_start: 1_700_000_000,
      items: { data: [{ id: 'si_1', price: { id: 'price_creator' } }] },
      ...over,
    },
  },
});

// --- signature verification -------------------------------------------------

test('a valid signature verifies', () => {
  const body = '{"hello":"world"}';
  const ts = 1_700_000_000;
  const r = verifySignature(body, signPayload(body, SECRET, ts), SECRET, 300, ts);
  assert.equal(r.ok, true);
});

test('a forged signature is rejected', () => {
  const body = '{"hello":"world"}';
  const ts = 1_700_000_000;
  const forged = signPayload(body, 'whsec_wrong_secret', ts);
  assert.equal(verifySignature(body, forged, SECRET, 300, ts).ok, false);
});

test('a signature for different content is rejected', () => {
  // The attack this stops: capture a real webhook, change the plan, resend.
  const ts = 1_700_000_000;
  const header = signPayload('{"plan":"free"}', SECRET, ts);
  assert.equal(verifySignature('{"plan":"studio"}', header, SECRET, 300, ts).ok, false);
});

test('an old signature is rejected even though it is genuine', () => {
  // Replay protection. Without it a captured `subscription.deleted` can be
  // resent for ever, and so can a `checkout.completed`.
  const body = '{"a":1}';
  const ts = 1_700_000_000;
  const r = verifySignature(body, signPayload(body, SECRET, ts), SECRET, 300, ts + 4000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /window/);
});

test('a missing or malformed header is rejected, not thrown on', () => {
  for (const header of ['', 'nonsense', 't=123', 'v1=abc']) {
    const r = verifySignature('{}', header, SECRET);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(header)}`);
  }
});

test('any one of several signatures matching is enough', () => {
  // Stripe sends two during a secret rotation.
  const body = '{"a":1}';
  const ts = 1_700_000_000;
  const good = signPayload(body, SECRET, ts).split('v1=')[1];
  const header = `t=${ts},v1=${'0'.repeat(good.length)},v1=${good}`;
  assert.equal(verifySignature(body, header, SECRET, 300, ts).ok, true);
});

// --- webhook handling -------------------------------------------------------

test('an unsigned webhook changes nothing', async () => {
  const store = new MemoryStore();
  await store.put({ ...newAccount('acct_1'), stripeCustomerId: 'cus_1' });
  const raw = JSON.stringify(subscription());
  const r = await handleWebhook(raw, 't=1,v1=deadbeef', {
    store, webhookSecret: SECRET, priceToPlan: PRICE_TO_PLAN,
  });
  assert.equal(r.handled, false);
  assert.equal((await store.get('acct_1')).plan, 'free', 'no plan was granted');
});

test('a subscription grants the plan for its price', async () => {
  const store = new MemoryStore();
  await store.put({ ...newAccount('acct_1'), stripeCustomerId: 'cus_1' });
  const r = await post(store, subscription());
  assert.equal(r.handled, true);
  const a = await store.get('acct_1');
  assert.equal(a.plan, 'creator');
  assert.equal(a.status, 'active');
  assert.equal(a.subscriptionItemId, 'si_1');
});

test('a duplicate delivery is handled once and acknowledged twice', async () => {
  // Acknowledged, because a non-2xx makes Stripe retry it again for ever.
  const store = new MemoryStore();
  await store.put({ ...newAccount('acct_1'), stripeCustomerId: 'cus_1', secondsUsed: 120 });
  const event = subscription();
  await post(store, event);
  const again = await post(store, event);
  assert.equal(again.handled, true);
  assert.match(again.detail, /already handled/);
});

test('an event older than the state we hold does not overwrite it', async () => {
  // Out-of-order delivery. A late `active` must not resurrect a cancellation.
  const store = new MemoryStore();
  await store.put({ ...newAccount('acct_1'), stripeCustomerId: 'cus_1' });
  await post(store, { ...subscription(), created: 2_000 });
  await post(store, { ...subscription({ status: 'canceled' }), created: 3_000,
    type: 'customer.subscription.deleted' });
  assert.equal((await store.get('acct_1')).plan, 'free');

  await post(store, { ...subscription(), created: 1_000 });   // late arrival
  assert.equal((await store.get('acct_1')).plan, 'free', 'the stale event was ignored');
});

test('checkout completing does not by itself grant a plan', async () => {
  // It says a checkout finished, not that a subscription is active and paid.
  const store = new MemoryStore();
  const r = await post(store, {
    id: 'evt_checkout', type: 'checkout.session.completed', created: 1_700_000_000,
    data: { object: { client_reference_id: 'acct_new', customer: 'cus_9', subscription: 'sub_9',
                      customer_details: { email: 'a@b.c' } } },
  });
  assert.equal(r.handled, true);
  const a = await store.get('acct_new');
  assert.equal(a.plan, 'free', 'the subscription events grant the plan, not this');
  assert.equal(a.stripeCustomerId, 'cus_9', 'but the customer is now linked');
});

test('an unknown price does not grant a plan', async () => {
  const store = new MemoryStore();
  await store.put({ ...newAccount('acct_1'), stripeCustomerId: 'cus_1' });
  await post(store, subscription({ items: { data: [{ id: 'si_x', price: { id: 'price_unknown' } }] } }));
  assert.equal((await store.get('acct_1')).plan, 'free');
});

test('a failed payment marks past_due without cutting access off', async () => {
  const store = new MemoryStore();
  await store.put({ ...newAccount('acct_1'), stripeCustomerId: 'cus_1', plan: 'studio', status: 'active' });
  await post(store, {
    id: 'evt_fail', type: 'invoice.payment_failed', created: 1_700_000_000,
    data: { object: { customer: 'cus_1' } },
  });
  const a = await store.get('acct_1');
  assert.equal(a.status, 'past_due');
  // An expired card should not strand a production mid-delivery.
  assert.equal(effectivePlan(a).id, 'studio');
});

test('a cancelled subscription drops to free', async () => {
  const store = new MemoryStore();
  await store.put({ ...newAccount('acct_1'), stripeCustomerId: 'cus_1', plan: 'studio', status: 'active' });
  await post(store, { ...subscription({ status: 'canceled' }), type: 'customer.subscription.deleted' });
  const a = await store.get('acct_1');
  assert.equal(effectivePlan(a).id, 'free');
});

// --- quoting and metering ---------------------------------------------------

test('the free plan refuses rather than silently charging', () => {
  const a = { ...newAccount('x'), secondsUsed: 9 * 60 };
  const q = quote(a, 5 * 60);
  assert.equal(q.allowed, false);
  assert.equal(q.overagePence, 0);
  assert.match(q.reason, /includes 10 minutes/);
});

test('a file longer than the plan allows is refused before any work starts', () => {
  const q = quote(newAccount('x'), 20 * 60);
  assert.equal(q.allowed, false);
  assert.match(q.reason, /up to 5 minutes per file/);
});

test('a paid plan quotes the overage instead of refusing', () => {
  const a = { ...newAccount('x'), plan: 'creator', status: 'active', secondsUsed: 299 * 60 };
  const q = quote(a, 10 * 60);
  assert.equal(q.allowed, true);
  // 1 minute included, 9 over, at 8p.
  assert.equal(q.overagePence, 72);
});

test('the same job is never billed twice', () => {
  // A retry, a duplicate webhook, a double-clicked button.
  let a = newAccount('x');
  const first = recordUsage(a, 'job_1', 120);
  assert.equal(first.counted, true);
  const second = recordUsage(first.account, 'job_1', 120);
  assert.equal(second.counted, false);
  assert.equal(second.account.secondsUsed, 120);
});

test('usage is counted in seconds, not rounded-up minutes', () => {
  // Rounding each job up to a minute overcharges anyone captioning short clips
  // by up to 60x.
  let a = newAccount('x');
  for (let i = 0; i < 10; i++) a = recordUsage(a, `job_${i}`, 6).account;
  assert.equal(a.secondsUsed, 60, 'ten six-second clips are one minute, not ten');
});

test('a new billing period clears the allowance', () => {
  const a = { ...newAccount('x'), secondsUsed: 5000, countedJobs: ['job_1'] };
  const rolled = rollPeriod(a, '2026-09-01');
  assert.equal(rolled.secondsUsed, 0);
  assert.deepEqual(rolled.countedJobs, []);
  assert.equal(rollPeriod(rolled, '2026-09-01').secondsUsed, 0, 'and is idempotent');
});

test('the counted-jobs record cannot grow without bound', () => {
  let a = newAccount('x');
  for (let i = 0; i < 800; i++) a = recordUsage(a, `job_${i}`, 1).account;
  assert.ok(a.countedJobs.length <= 500);
  assert.equal(a.secondsUsed, 800, 'every one was still counted');
});

// --- configuration ----------------------------------------------------------

test('a missing webhook secret is refused, loudly', () => {
  // Defaulting here would accept every forged webhook.
  assert.throws(() => configFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }),
    /STRIPE_WEBHOOK_SECRET/);
  assert.throws(() => configFromEnv({}), /STRIPE_SECRET_KEY/);
});

test('test and live keys are distinguishable', () => {
  assert.equal(isTestKey('sk_test_abc'), true);
  assert.equal(isTestKey('sk_live_abc'), false);
});

test('every plan is internally coherent', () => {
  for (const p of Object.values(PLANS)) {
    assert.ok(p.maxMinutesPerJob <= p.includedMinutes,
      `${p.id} allows a single file bigger than its whole allowance`);
    assert.ok(p.overagePencePerMinute >= 0);
  }
});
