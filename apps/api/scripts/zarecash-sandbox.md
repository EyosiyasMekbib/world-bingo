# ZareCash sandbox verification runbook

Operator runbook for verifying the ZareCash integration against **staging**,
not local dev. ZareCash (`paymentmgmtv2`) must be able to POST webhooks to a
public HTTPS URL, so this cannot be done against `localhost`.

Written from the code as of commit `ed82bd4` on `feat/zarecash-integration`.
Re-run this whenever ZareCash changes their contract, or after any change to
`apps/api/src/services/zarecash.service.ts`, `apps/api/src/gateways/payment/zarecash/`,
or the two ZareCash workers.

---

## 1. Prerequisites

Set these on the **staging** API process (`apps/api/.env` there, or your
deploy platform's env panel — never commit real values). Names and defaults
below are copied from `apps/api/.env.example:163-176`.

| Variable | Default | Where it comes from |
|---|---|---|
| `ZARECASH_ENABLED` | `false` | Set to `true` for this exercise. Everything ZareCash-related is a no-op — including the boot check in step 2 — when this is `false` or unset. |
| `ZARECASH_BASE_URL` | `https://api.zarecash.com` | The public base URL of the `paymentmgmtv2` deployment you're testing against (its own ops team / DEPLOY.md has this — it is **not** a real `zarecash.com` domain, that default is a placeholder). |
| `ZARECASH_API_KEY` | *(empty)* | Tenant's **test**-mode API key (`pk_test_...`), issued from the ZareCash console's **API & Webhooks** panel (`ApiWebhooks.vue`, "API Keys" section → generate/reveal). Shown once — copy it immediately. |
| `ZARECASH_WEBHOOK_SECRET` | *(empty)* | Same **API & Webhooks** panel, "Webhook signing secret" → **Rotate**. Also shown once. See the one-time dashboard step below — rotating it here invalidates the old value everywhere. |
| `ZARECASH_MODE` | `test` | Must literally be `test` for this exercise. `ZareCashService.assertMode` compares this against the mode the API key itself reports (see §2) — it is **not** just a label. |
| `ZARECASH_TIMEOUT_MS` | `10000` | Per-attempt HTTP timeout to ZareCash. Leave default unless staging's network to `paymentmgmtv2` is unusually slow. |
| `ZARECASH_WITHDRAWAL_ATTEMPTS` | `8` | Retry budget for a withdrawal submission before the worker's terminal refund fires (`apps/api/src/lib/queue.ts:58-88`). Must be a positive integer — anything else (`"eight"`, `0`, `-3`, `2.5`) is rejected with a `console.warn` and silently falls back to `8`. Leave default. |

**One-time ZareCash-side step.** In the ZareCash console, open the tenant's
**API & Webhooks** panel and set the **Webhook URL** field to:

```
https://<staging-host>/v1/zarecash/webhook
```

This is the only route that accepts ZareCash's webhooks
(`apps/api/src/index.ts:294`, prefix `/v1/zarecash/webhook`). It is public and
unauthenticated by JWT — the HMAC signature is the authentication
(`apps/api/src/routes/zarecash/webhook.ts:1-7`).

The **webhook signing secret** lives in the same panel, next to a **Rotate**
button. Rotating it immediately invalidates the previous secret for every
consumer, including this one — if you rotate it, update
`ZARECASH_WEBHOOK_SECRET` on staging in the same breath, or every webhook
starts failing signature verification (`401 invalid_signature`) until you do.

---

## 2. The boot assertion

On boot, if `ZARECASH_ENABLED=true`, `ZareCashService.assertMode()` calls
`GET /v1/float` and compares the mode it reports against `ZARECASH_MODE`
(`apps/api/src/services/zarecash.service.ts:101-123`). There are exactly two
outcomes, and the code deliberately treats them differently — do not expect
a mismatch and an outage to look the same.

**Success** — logged and boot continues:

```
[ZareCash] connected in test mode (available float: <N> ETB)
```
(exact format string, `zarecash.service.ts:122`: `'[ZareCash] connected in %s mode (available float: %s ETB)'`)

**Genuine mode mismatch — FATAL, refuses to start.** If the API key reports
a different mode than `ZARECASH_MODE` says (e.g. you were handed a live key
but `ZARECASH_MODE=test`), a `ZareCashModeMismatchError` is thrown with:

```
ZareCash mode mismatch: ZARECASH_MODE=test but the API key reports "live". Refusing to start.
```

`index.ts` rethrows only this specific error type
(`apps/api/src/index.ts:384-402`); the surrounding `try` calls
`process.exit(1)` on anything it can't swallow. You'll see the full error
(with stack) dumped by the Fastify/pino logger, then the process exits. This
is the **one** ZareCash boot failure that takes the API down — fix the key/mode
pairing and restart.

**ZareCash unreachable — NOT fatal, logs and continues unverified.** A
network error, timeout, 401, or 5xx from `GET /v1/float` tells us nothing
about whether the key is correct — only that ZareCash is unavailable right
now. Boot continues:

```
[ZareCash] could not verify keyspace at boot (continuing unverified): <error message>
```
(`zarecash.service.ts:108-114`) — also reported to Sentry with `phase: 'zarecash-assert-mode'`. The server binds the port and serves traffic normally; the ZareCash integration is simply unverified until the next restart or a manual check.

If you see the "unreachable" line when you expected "connected", the problem
is network/DNS/ZareCash-uptime, not your credentials — check `ZARECASH_BASE_URL`
is reachable from the staging host before touching the API key.

---

## 3. Opting a payment method into ZareCash

Routing is per-`PaymentMethod` row, keyed on two columns
(`apps/api/prisma/schema.prisma:559-560`):

```sql
-- Route deposits/withdrawals for "telebirr" through ZareCash.
UPDATE payment_methods
SET gateway = 'zarecash', "gatewayMethodCode" = 'telebirr'
WHERE code = 'telebirr';
```

```sql
-- Revert to the manual/admin-reviewed flow.
UPDATE payment_methods
SET gateway = 'manual', "gatewayMethodCode" = NULL
WHERE code = 'telebirr';
```

`gatewayMethodCode` is what's sent to ZareCash as `methodCode`; if left
`NULL` it falls back to our own `code` (`method-config.ts:42`). `gateway`
defaults to `'manual'` at the schema level — that's the value to revert to,
not `NULL`.

**The routing decision is cached for up to 60 seconds** —
`CACHE_TTL_MS = 60_000` in `apps/api/src/gateways/payment/zarecash/method-config.ts:30`.
There is no admin-facing cache-bust: `clearMethodCache()` exists
(`method-config.ts:67-69`) but nothing in the running app calls it — it's a
test seam only. After running either `UPDATE` above, **wait up to 60 seconds**
before submitting a deposit/withdrawal that depends on the new routing, or
restart the API process to pick it up immediately.

---

## 4. Deposit trigger table

Sandbox outcomes are keyed on the `receiptRef` — i.e. the transaction ID the
player types in — normalized trim + uppercase, matched by prefix. Source of
truth: `paymentmgmtv2/apps/api/src/common/sandbox.ts:28-52,83-99`. The
collection account shown to the player is irrelevant here; only the ref
matters.

| `receiptRef` prefix | ZareCash outcome | Local (world-bingo) result |
|---|---|---|
| `TEST-REJECT-*` | Rejected inline, verdict `AMOUNT_MISMATCH`, webhook `deposit.rejected` fires | `transactions.status = REJECTED` via `onDepositRejected`. No wallet change — a deposit is never credited before approval. |
| `TEST-STALE-*` | Rejected inline, verdict `STALE_RECEIPT`, webhook `deposit.rejected` fires | Same as above — `REJECTED`, no wallet change. |
| `TEST-REVIEW-*` | Stays in manual review **forever** — no webhook ever fires for it (this is deliberate sandbox behaviour: "so you can test the waiting state") | `transactions.status = PENDING_REVIEW` indefinitely. See §8 — this is expected, not a bug. |
| anything else (e.g. `CLEAN-001`) | Approved inline, test float credited, webhook `deposit.approved` fires | `submitDeposit` sees `res.status === 'APPROVED'` and calls `WalletService.approveDeposit` **inline**, before the webhook even arrives (`zarecash.service.ts:363-378`). The later webhook finds the row already non-`PENDING_REVIEW` and logs `"deposit %s already %s, skipping redelivery"` — harmless. |

**Verify the clean-approval case fully** — this is the one that proves
approvals are actually going through `WalletService.approveDeposit` and not
some shortcut:

```sql
-- The deposit itself, credited.
SELECT id, type, amount, status, note, "createdAt"
FROM transactions
WHERE "userId" = '<uid>' AND type = 'DEPOSIT'
ORDER BY "createdAt" DESC LIMIT 1;

-- Proof the first-deposit bonus fired (only on that player's first APPROVED deposit).
SELECT id, type, amount, note
FROM transactions
WHERE "userId" = '<uid>' AND type = 'FIRST_DEPOSIT_BONUS'
ORDER BY "createdAt" DESC LIMIT 1;

SELECT id, "ruleId", amount, remaining, status, "createdAt"
FROM bonus_grants
WHERE "userId" = '<uid>'
ORDER BY "createdAt" DESC LIMIT 1;  -- ruleId is NULL for a first-deposit grant

-- The credited balance, including the bonus.
SELECT "realBalance", "bonusBalance" FROM wallets WHERE "userId" = '<uid>';
```

**Why this check matters, specifically:** `ZareCashService.submitDeposit` and
`onDepositApproved` both route every credit through
`WalletService.approveDeposit` rather than crediting the wallet directly
(`zarecash.service.ts:1-7`, module docstring). That single function is also
what grants the first-deposit bonus, evaluates daily/weekly deposit-bonus
rules, fires the referral payout, and emits the `wb_deposits_total` metric
(`wallet.service.ts:110-291`). If a future change ever credits the wallet
without going through it, deposits will still work but bonuses, referrals,
and metrics silently stop firing — this SQL is the fastest way to catch that.

---

## 5. Withdrawal trigger table

Sandbox outcomes are keyed on the **cents** of the amount, matched
independent of the integer birr amount. Source of truth:
`paymentmgmtv2/apps/api/src/common/sandbox.ts:58-80,101-109`.

> **Use a distinct player for every row.** Two independent single-open-withdrawal
> guards apply in test mode: ZareCash's own tenant-side check
> (`OPEN_WITHDRAWAL_STATES` = `PENDING_REVIEW`, `QUEUED_FLOAT`, `RISK_HOLD` —
> `withdrawals.service.ts:22-26`) rejects a second withdrawal for the same
> player with `409 withdrawal_pending`, **and** our own
> `WalletService.requestWithdrawal` has an unconditional one-pending-withdrawal
> rule per user (`wallet.service.ts:307-315`, gateway-agnostic — it blocks
> *any* second withdrawal, ZareCash-routed or not). Reusing a player burns it
> for every row after the first.

| Amount ending in | ZareCash outcome | Local (world-bingo) result |
|---|---|---|
| `.01` | Rejected **inline** (verdict `SANDBOX_REJECTED`), reservation released; webhook `withdrawal.rejected` also fires shortly after | `submitWithdrawal` gets `res.state === 'rejected'` in the POST response itself and refunds immediately via `refundWithdrawalIfPending` → `transactions.status = REJECTED`, wallet re-credited, a `REFUND` transaction row written. The later webhook lands on an already-resolved row and logs `"withdrawal %s already resolved, skipping duplicate refund"` — harmless. |
| `.02` | Parked as `queued_float` **regardless of test float balance**; webhook `withdrawal.queued_float` fires, and — because the sandbox treats this exactly like a real low-float situation — a `float.low` webhook fires alongside it (useful for exercising that alert path in the same request) | Stays `PENDING_REVIEW` (`submitWithdrawal`'s `default` branch — queued_float is not one of the three handled terminal states). `onWithdrawalQueued` sends the player a "Withdrawal Processing" notification but does not change status. |
| `.03` | Stays `pending`, "claimed by nobody" — **this never resolves in test mode**, by design (there is no clerk in the sandbox to act on it) | Stays `PENDING_REVIEW` forever. Because `gateway = 'zarecash'`, `AdminService.reviewTransaction`'s gateway-managed guard (`admin.service.ts:25-28`) refuses to let an admin approve or reject it manually — and it will never resolve on ZareCash's side either. See the recovery SQL below before you burn a test player on this trigger. |
| anything else (e.g. `500.00`) | Settled immediately with a synthetic `settlementRef` (`SBX...`); webhook `withdrawal.approved` also fires | `submitWithdrawal` gets `res.state === 'approved'` inline and calls `settleApprovedWithdrawal` immediately → `transactions.status = APPROVED`, `note` carries the `settlementRef`. The later webhook is a harmless redelivery. |

**Recovering a wedged `.03` row.** The admin guard is armed by
`Transaction.gateway`, not `gatewayRef` — clearing `gateway` releases it
without touching the wallet, so the normal reject-and-refund path (admin UI,
or `AdminService.reviewTransaction`) can then run its usual, correct
wallet-credit + `REFUND`-row logic instead of you hand-rolling the balance
math:

```sql
UPDATE transactions
SET gateway = NULL
WHERE id = '<transaction-id>' AND status = 'PENDING_REVIEW';
```
Then reject it through the normal admin flow.

---

## 6. Verifying the outage paths

There are **two** independent scheduled passes, both started by
`scheduleZareCashSweep()` at boot when ZareCash is enabled
(`apps/api/src/workers/zarecash-sweep.worker.ts:67-76`), both on queue
`zarecash-sweep`:

| Job name | Pattern | Purpose |
|---|---|---|
| `sweep` (jobId `zarecash-nightly-sweep`) | `0 3 * * *` (nightly, 03:00) | **Reconciliation sweep** — `ZareCashService.sweepEvents()`. Pulls from `GET /v1/events` (newest-first, paging forward within the run) and records/enqueues anything in `zarecash_events` that a webhook never delivered. |
| `requeue-stranded` (jobId `zarecash-stranded-requeue`) | `*/15 * * * *` (every 15 min) | **Stranded-event pass** — `ZareCashService.requeueStrandedEvents()`. Re-enqueues events we already recorded (`processedAt IS NULL`) but whose BullMQ processing job died and was never revisited — the webhook route already returned 200, so ZareCash will never redeliver these on its own. |

Both are logged by `processSweepJob` (`zarecash-sweep.worker.ts:18-34`):
```
[ZareCashSweep] scanned=<N> replayed=<N> pages=<N> truncated=<bool>
[ZareCashSweep] stranded found=<N> requeued=<N>
```

**Triggering by hand.** All four `zarecash-*` queues are registered on the
BullMQ dashboard at `/admin/queues` (behind admin auth), so you can inspect
jobs and promote a delayed repeatable there. If you would rather not go
through the UI — or the dashboard is unreachable — call the underlying
service function directly from `apps/api/`:

```bash
# Reconciliation sweep
pnpm exec tsx --env-file ../../.env -e "
import { ZareCashService } from './src/services/zarecash.service.js'
console.log(await ZareCashService.sweepEvents())
process.exit(0)
"

# Stranded-event pass
pnpm exec tsx --env-file ../../.env -e "
import { ZareCashService } from './src/services/zarecash.service.js'
console.log(await ZareCashService.requeueStrandedEvents())
process.exit(0)
"
```
This runs the identical code path the scheduled job runs (the worker is a
thin dispatcher — `zarecash-sweep.worker.ts:18-34`), just without waiting for
the cron. Point `--env-file` at whatever `.env` has staging's
`DATABASE_URL`/`REDIS_URL`/`ZARECASH_*` values.

**To exercise the reconciliation sweep specifically:** stop the API (or just
the sweep worker), submit a sandbox deposit/withdrawal so its webhook fires
into the void, restart, then run the `sweepEvents` command above.

**To exercise the stranded-event pass specifically:** the harder part is
producing a row stuck at `processedAt = null` — normally that means
`processEvent` threw on every BullMQ attempt. The `UnknownGatewayRefError`
path is the easiest reliable way: send a webhook whose `gatewayRef` matches
no local transaction (e.g. replay an old event id from a previous test run
against a transaction that's since been deleted, or manually POST a crafted
payload to `/v1/zarecash/webhook` with a valid HMAC and a made-up `id`) —
`processEvent` leaves `processedAt` null for up to `UNKNOWN_REF_GRACE_MS`
(24h) specifically so this pass can retry it
(`zarecash.service.ts:525-568`). Then run `requeueStrandedEvents` — note it
only picks up rows older than `STRANDED_MIN_AGE_MS` (10 minutes,
`zarecash.service.ts:50`), so a freshly-stuck row won't show up immediately.

**What to check afterwards**, in `zarecash_events`:

```sql
SELECT id, type, "receivedAt", "processedAt", error
FROM zarecash_events
ORDER BY "receivedAt" DESC
LIMIT 20;
```
A healthy replay shows `processedAt` populated and `error` null. See §7 for
what it means when `processedAt` stays null with `error` populated.

---

## 7. Triage

All webhook and sweep-discovered events land in `zarecash_events`
(`prisma/schema.prisma:808-819`): `id` (ZareCash's own `evt_...`), `type`,
`payload` (full envelope), `receivedAt`, `processedAt`, `error`.

**`processedAt IS NULL` with `error` populated** means the last processing
attempt threw and the event has not been consumed — it is retryable, either
by BullMQ's own remaining attempts (3, from `defaultJobOptions` in
`lib/queue.ts:93-101` — no override on this queue) or, once those are
exhausted, by the stranded-event pass once the row passes the 10-minute
age cutoff. Two shapes of `error` matter:

- **`"<type> names gatewayRef <ref>, which matches no local transaction"`** —
  a terminal webhook arrived before our own `gatewayRef` write landed (a real
  race — see §6's "trigger the stranded pass" note). Left unprocessed on
  purpose for up to 24h so it can be retried once the ref exists; past that,
  it's stamped processed with the error kept and an `AuditLog` /
  Sentry alert raised (`zarecash.service.ts:534-561`).
- Anything else is a genuine processing failure (DB error, a real bug) —
  investigate the message directly.

**Where the withdrawal worker logs a skipped terminal refund.** When a
withdrawal job exhausts all `ZARECASH_WITHDRAWAL_ATTEMPTS` retries and the
final (or any prior) error was `withdrawal_pending`, the worker does **not**
refund — refunding here could double-pay a payout that's genuinely still in
flight at ZareCash. The line to grep application logs for:

```
[ZareCashWithdrawalWorker] tx <id> exhausted retries after seeing withdrawal_pending — NOT refunding (payout may be in flight). Left PENDING_REVIEW for the sweep/admin queue.
```
(`apps/api/src/workers/zarecash-withdrawal.worker.ts:181-194`). Also reported
to Sentry with `phase: 'withdrawal-pending-exhausted'`. A row in this state
needs a human to resolve it by consulting ZareCash directly, not an automatic
retry.

---

## 8. Expected, not bugs

- **A fresh live float starts empty**, so the very first live payouts land in
  `queued_float` until enough deposits have accumulated. This is the same
  mechanism as the `.02` test trigger, just for a real reason instead of a
  magic value.
- **Test-mode traffic never reaches a ZareCash review queue.** Per the
  sandbox's own contract comment: "Test-mode transactions use a separate
  float and never appear in the platform review queues"
  (`paymentmgmtv2/apps/api/src/common/sandbox.ts:1-12`). There is no clerk on
  the ZareCash side to act on test transactions — that's why `TEST-REVIEW-*`
  and the `.03` withdrawal trigger never resolve on their own.
- **A deposit left `PENDING_REVIEW` after `TEST-REVIEW-*`** is documented
  sandbox behaviour, not a stuck job. It will sit there until you resolve it
  by hand (normal admin approve/reject — deposits have no gateway-managed
  guard, unlike withdrawals, since `WalletService.approveDeposit` is always
  safe to call and never double-pays).

## 9. Hosted checkout

Hosted checkout is the second way a deposit can reach ZareCash. Instead of us
collecting the transaction number and posting `/v1/deposits`, we create a
session, redirect the player to ZareCash's own page, and they collect the
method choice, the collection account and the receipt — in English or Amharic,
picked from the player's `Accept-Language`.

### Turning it on

1. **Console:** set this tenant's **Custom URL** (API & webhooks page) to the
   same origin as `WEB_BASE_URL`. A `returnUrl` on any other origin is refused
   with `invalid_return_url`, and that is not relaxable per tenant.
2. **Database:** the seed ships a `zarecash` DEPOSIT method with
   `hostedCheckout = true` and `enabled = false`. Flip `enabled` on in
   Settings → Payment Methods. That toggle is the kill switch.

```sql
UPDATE payment_methods SET enabled = true WHERE code = 'zarecash';
```

The card appears at the top of the deposit modal (`sortOrder = -1`), above the
manual methods, which keep working unchanged.

### Walking the flow

With a `pk_test_` key, deposit from the player app and follow the redirect. On
the hosted page the receipt reference decides the outcome, using the same
trigger table as section 4:

| Reference you paste | What to expect back here |
|---|---|
| anything ordinary | `deposit.approved` → wallet credited, bonuses evaluated |
| `TEST-REJECT-…` | `deposit.rejected` → row `REJECTED`, no wallet change |
| `TEST-REVIEW-…` | stays `PENDING_REVIEW`; the "confirming your deposit" banner stays up |

Three things worth verifying deliberately, because each has its own code path:

- **The normal return.** You land on `/wallet?deposit=dp_…&status=pending`, the
  query is stripped, and a `PENDING_REVIEW` row appears with
  `gateway = 'zarecash'` and `gatewayRef = dp_…`. **Nothing is credited yet** —
  `pending` means the receipt was accepted, not that money arrived.
- **The player who never comes back.** Submit the receipt, then close the tab
  instead of following the redirect. The `deposit.approved` webhook adopts the
  open session by `playerRef` and creates the row itself. This is routine, not
  an edge case.
- **The abandoned session.** Open a session and never pay. No `Transaction` is
  ever created, so nothing reaches the admin deposit queue. The hourly
  `sweep-checkout-sessions` job marks it `dead` once it is 24 hours past
  `expiresAt`.

```sql
SELECT id, "sessionId", "depositId", "transactionId", status, "expiresAt"
FROM zarecash_checkout_sessions ORDER BY "createdAt" DESC LIMIT 10;
```

### Expected, not bugs

- **A session is `open` for only 20 minutes**, but the page keeps accepting a
  receipt for a further 24 hours from a player who already sent money. A return
  long after the redirect is normal.
- **Re-creating a session with the same idempotency key returns the same
  session with a *fresh* URL**, and the previous link stops working. The modal
  always redirects to the URL from the current response for this reason.
- **`invalid_return_url` surfaces to the player as a generic 503**, not a form
  error, and is reported to Sentry. It is a misconfiguration that fails every
  attempt until the console is fixed — check the Custom URL first.
