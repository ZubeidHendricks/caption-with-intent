# The hosted service

Billing, auth, the job queue, object storage and the API that ties them
together. All of it self-contained and tested without a network, a database or
a Stripe key — 60 tests that run offline in under a second.

Not published. `private: true`, and it should stay that way.

**What is still missing is infrastructure, not code**: somewhere to run this, a
real database behind the store interfaces, an object store, a domain, and a
worker fleet. Those cost money and are decisions to make deliberately. The
interfaces exist so that choosing them is a configuration change rather than a
rewrite.

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


## Auth

**No passwords.** Not a simplification — a decision. A password store is a
liability that must be defended for as long as the service exists, and the two
things it buys are worth less than the breach it eventually becomes. An emailed
sign-in link for people, API keys for machines.

What is stored is a SHA-256 of a token, never the token, so a dump of that table
lets an attacker impersonate nobody. Comparisons are constant time. Sign-in
links are single use and expire in 15 minutes — a link that still works after
use is a permanent account takeover sitting in an inbox and every mail archive
that touched it. Every rejection returns the same message, because
distinguishing "no such token" from "expired" tells someone enumerating tokens
which guesses were close.

Keys carry a `chk_` prefix so a secret scanner can find one leaked into a public
repository before somebody else does.

## The queue

Captioning a feature takes minutes, so the work cannot happen in a request. A
queue means confronting the fact that workers are killed mid-job — a deploy, an
out-of-memory kill, a reclaimed spot instance — none of which give the worker a
chance to tidy up.

So a claimed job is **leased**, not removed. A worker renews its lease; if it
stops, the lease lapses and the job returns to the queue. Nothing is lost when a
worker dies, and nothing is stuck for ever because a worker died quietly.

The consequence is at-least-once delivery. A job can run twice, and that cannot
be designed away — only handled, which is why usage is recorded against a job id
and a repeat is a no-op. **A queue that claims to be exactly-once is a queue
that bills twice.**

Attempts count *claims*, not reported failures: a worker that dies never reports
anything, so counting failures would let a job that reliably kills workers cycle
for ever.

## Tenancy

The API adds no rules; it decides the order the rules apply in, and that order
is where multi-tenant services leak. Being signed in is not permission to read
*this* job. Every ownership check answers 404 rather than 403, because the
difference tells someone enumerating ids which ones exist.

Tested directly: one account reading another's job, downloading another's
output, starting a job against another's upload, cancelling another's work. Each
is refused and each refusal is indistinguishable from "no such thing".

A job is billed **on completion, never on acceptance** — a job that dies in
transcription costs the customer nothing.
