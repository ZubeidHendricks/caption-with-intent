# Billing for the hosted service

The payment layer only. Hosting, storage, auth and the job queue are a separate
project; this package is the part where a mistake costs somebody money, so it is
self-contained and tested without a network, a database or a Stripe key.

Not published. `private: true`, and it should stay that way — nothing here
belongs in a package anyone installs.

## What it decides

**Entitlement comes from stored state, never from the client.** A browser
claiming to be on the studio plan is a browser making a claim. Every check runs
against what Stripe said through a signed webhook.

| plan | included | per file | overage |
|---|---|---|---|
| Free | 10 min | 5 min | refuses rather than charging |
| Creator | 300 min | 60 min | 8p/min |
| Studio | 3000 min | 240 min | 5p/min |

The free plan's overage is zero on purpose: it refuses the job. A free tier that
quietly bills is how people stop trusting a product.

## The parts that are easy to get wrong

**Webhook signatures** are the security boundary of the whole system — the
difference between "a customer subscribed" and "someone posted JSON at your
endpoint". Verified in constant time, against the raw body, with a timestamp
window. Without the window, a captured `subscription.deleted` can be replayed
for ever; without constant time, the signature leaks a byte at a time.

**Duplicate deliveries.** Stripe sends each event at least once and resends on
any non-2xx, including a timeout after the work succeeded. Handled event ids are
recorded, and a duplicate returns 2xx rather than an error — an error would make
Stripe retry it again, for ever.

**Out-of-order events.** They arrive out of order more often than anyone
expects. State carries the event's own timestamp and an older event never
overwrites a newer one, so a late `active` cannot resurrect a cancellation.

**Checkout does not grant a plan.** `checkout.session.completed` means a
checkout finished, not that a subscription is active and paid. Only the
subscription events grant a plan; doing it at checkout is how an abandoned or
failed payment ends up entitled.

**Double billing.** Every recorded unit carries a job id, and recording the same
id twice is a no-op — a retry, a duplicate webhook and a double-clicked button
all collapse to one charge. Usage is recorded on *completion*, so a job that
dies in transcription costs the customer nothing.

**Seconds, not minutes.** Rounding each job up to a minute overcharges anyone
captioning short clips by up to sixty times.

**A failed payment does not cut access off.** Stripe retries for weeks; taking
the tools away on the first failed retry punishes an expired card rather than a
non-payer. `past_due` keeps the plan; `canceled` drops to free.

## Configuration

Everything comes from the environment and nothing is committed:

```
STRIPE_SECRET_KEY=sk_test_...        # test keys until you mean it
STRIPE_WEBHOOK_SECRET=whsec_...      # no default: a missing one accepts forgeries
STRIPE_PRICE_ID=price_...
STRIPE_METERED_PRICE_ID=price_...    # optional, for per-minute usage
```

`configFromEnv` throws on a missing webhook secret rather than falling back,
because the fallback would accept every forged webhook.

## What is not here

Storage is an interface with an in-memory implementation for tests. The real one
is Postgres or whatever the service settles on. `MemoryStore` says it is for
tests and local runs, because an in-memory store that reaches production loses
every subscription on restart.
