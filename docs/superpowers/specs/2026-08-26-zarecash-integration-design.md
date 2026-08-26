# ZareCash integration

**Date:** 2026-08-26
**Status:** draft — awaiting review
**Scope of this document:** design only. No code is written until this and the
implementation plan are approved.

## Problem

Every deposit and withdrawal in world-bingo is settled by hand. A player transfers to a
merchant account we own, submits the transaction ID, and a clerk approves it in the admin
panel. `DepositVerificationService` softens this for TeleBirr by scraping the canonical
receipt and auto-crediting under a cap, but everything else — every bank method, every
payout, every edge case — is a human in a queue.

ZareCash (repo: `paymentmgmtv2`, product name `PMV2`) is deposit-and-withdrawal-as-a-service
for ETB operators, and it is ours. It runs the collection accounts, receipt verification,
the review queues, settlement, and per-tenant float accounting. World-bingo becomes a
tenant: it reports player payments, requests payouts, and reacts to signed webhooks.

## Why the fit is close

The contract ZareCash imposes on a tenant is, almost line for line, what world-bingo
already does. This is not a coincidence — both were built here — but it means the
integration is mostly wiring, not restructuring.

| world-bingo today | ZareCash |
|---|---|
| `Transaction` DEPOSIT created `PENDING_REVIEW` | `POST /v1/deposits` |
| `WalletService.approveDeposit(id, adjustedAmount)` | webhook `deposit.approved` → `approvedAmount` |
| admin rejects deposit, no wallet change | webhook `deposit.rejected` |
| `requestWithdrawal()` debits the wallet, *then* creates the pending row | `POST /v1/withdrawals` — the contract requires exactly that order |
| admin approves withdrawal | webhook `withdrawal.approved` + `settlementRef` |
| admin rejects → re-credit + `REFUND` compensation row | webhook `withdrawal.rejected` / `withdrawal.cancelled` |
| one pending withdrawal per user, enforced under the wallet lock | `409 withdrawal_pending` |
| `paymentTransactionId`, trimmed and upper-cased, unique | `receiptRef`, same normalisation, `409 duplicate_receipt` |
| `user.isActive = false` freeze blocks payouts | `POST /v1/players/{ref}/freeze` |
| `DepositVerificationService` TeleBirr scraper | ZareCash's own verification engine |

Two consequences follow from this table and drive the whole design.

**The webhook must land on `approveDeposit`, not on a new credit path.** That function is
not a credit. Inside its `$transaction` it credits the wallet, grants the first-deposit
bonus via `BonusService.grant`, and evaluates the daily/weekly rules via
`DepositBonusService.evaluateAndGrant`; in the chained post-commit block it pushes the
balance over the socket, increments `wbDepositsTotal`, sends notifications, and triggers
`ReferralService.processFirstDepositBonus`. A parallel "credit from webhook" function
would silently stop doing all of it. Its existing `PENDING_REVIEW` guard also
makes webhook replay safe at no extra cost.

**Withdrawals are the dangerous half.** We debit the player before calling ZareCash, which
is correct per the contract, but it means a failed call leaves a debited player and no
payout. That edge gets a retrying job and an automatic local refund on permanent failure.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Rollout | Per-payment-method opt-in | Mirrors the existing `autoVerify` per-method flag. Migrate one method at a time; kill-switch is one DB update. `PaymentMethod.type` already splits DEPOSIT/WITHDRAWAL, so it covers both directions with no new concept. |
| Phase | Test first (`pk_test_…`) | The contract promises live is the same base URL, same paths, same payloads — only the key changes. |
| Abstraction | New `ZareCashClient` + `ZareCashService`; leave `PaymentGateway` alone | The existing `PaymentGateway` interface models Chapa-style redirect checkout (`initiatePayment` → `checkoutUrl`). ZareCash is record-and-review. Force-fitting would mean three misleading method signatures on an interface that currently has exactly one implementation (`manual`) and no callers to satisfy. |
| Idempotency keys | `dep_<our transaction.id>` / `wd_<our transaction.id>` | Deterministic from a row we already own, so every retry is automatically safe and no key table is needed. |
| Verification | Skip `DepositVerificationService` for zarecash-routed methods | ZareCash owns verification for those. Scraping the same receipt twice wastes the rate limit and invites two engines disagreeing. See *Live phase* for the wrinkle. |
| `playerRef` | `user.id` (uuid) | Opaque and stable, which is all the contract asks. |
| Method codes | Explicit `PaymentMethod.gatewayMethodCode` column | Our codes (`telebirr`, `cbe`) do not all match ZareCash's enum (`telebirr`, `cbe_birr`, `bank_transfer`). Map explicitly rather than guessing. |

## Data model

Four changes in `apps/api/prisma/schema.prisma`, one migration.

```prisma
model PaymentMethod {
  // ...
  gateway           String  @default("manual")  // "manual" | "zarecash"
  gatewayMethodCode String?                     // ZareCash methodCode when gateway = "zarecash"
}

model Transaction {
  // ...
  gatewayRef String? @unique   // ZareCash id: dp_… / wd_…
}

/// One row per received webhook delivery. Delivery is at-least-once, so this
/// table is the dedupe key and the audit trail.
model ZareCashEvent {
  id          String    @id          // evt_… from ZareCash
  type        String
  payload     Json
  receivedAt  DateTime  @default(now())
  processedAt DateTime?
  error       String?

  @@index([type])
  @@index([processedAt])
  @@map("zarecash_events")
}
```

`gateway` as a string rather than an enum keeps a third provider from needing a migration.
The reconciliation cursor is a `SiteSetting` row (`zarecash_events_cursor`) — no new model.

## Configuration

Env vars in `apps/api/.env.example`, shaped like the existing `PALACE_*` block:

```
ZARECASH_ENABLED=false
ZARECASH_BASE_URL=https://api.zarecash.com
ZARECASH_API_KEY=
ZARECASH_WEBHOOK_SECRET=
ZARECASH_MODE=test
ZARECASH_TIMEOUT_MS=10000
```

`BrandSetting` is a singleton (`@id @default("default")`), so one deployment is one
ZareCash tenant and one API key. No hub/spoke election is needed: ZareCash is itself
multi-tenant, so each brand is its own tenant with its own key and its own webhook URL.

**Boot assertion.** On startup, when `ZARECASH_ENABLED=true`, call `GET /v1/float` and
compare the returned `mode` against `ZARECASH_MODE`. Mismatch is fatal — refuse to boot.
This is checklist item 9 of the contract and the cheapest possible guard against shipping
a test key to production, or a live key into CI.

## Components

```
apps/api/src/gateways/payment/zarecash/
  client.ts        HTTP: auth header, Idempotency-Key, timeout, error mapping
  types.ts         Request/response/webhook shapes from the contract
  signature.ts     pmv2-signature verify (HMAC-SHA256, 300s tolerance, timing-safe)
apps/api/src/services/zarecash.service.ts    domain mapping, both directions
apps/api/src/routes/zarecash/webhook.ts      POST /v1/zarecash/webhook
apps/api/src/workers/zarecash-*.ts           submit retries, event processing, nightly sweep
```

`client.ts` knows only HTTP and the contract. `zarecash.service.ts` is the only file that
knows about both `Transaction` rows and ZareCash payloads. The route does signature
verification and nothing else.

Route prefix `/v1/zarecash/webhook` follows `/v1/palace/callback`, the existing convention
for inbound provider callbacks.

## Deposit flow

1. `WalletService.initiateDeposit` creates the local `PENDING_REVIEW` row exactly as today.
2. Resolve the method. If `gateway !== 'zarecash'`, behave exactly as today — including
   `DepositVerificationService.enqueue()`. Nothing about the manual path changes.
3. For zarecash methods: **do not** enqueue local verification. `POST /v1/deposits` with
   `Idempotency-Key: dep_<transaction.id>`, `playerRef: userId`,
   `receiptRef: paymentTransactionId`, `methodCode: gatewayMethodCode`, plus `payerName`
   and `payerAccount` from `senderName` / `senderAccount`.
4. Persist `gatewayRef` from the response.
5. If the response is already `APPROVED` — which is the common case in test mode for any
   ref outside the trigger table — credit immediately via `approveDeposit(id, approvedAmount)`
   rather than waiting for the webhook. The webhook will still arrive; the `PENDING_REVIEW`
   guard makes it a no-op.
6. If the call fails, the local row stays `PENDING_REVIEW` and a retry job takes over. A
   deposit stuck in review is a safe failure — no money has moved.

`409 duplicate_receipt` maps onto our existing 409 for a reused transaction ID, so the
player sees the same message they see today.

## Withdrawal flow

This is where a bug costs real money, so it is specified tightly.

1. `WalletService.requestWithdrawal` runs unchanged: validate, lock the wallet row, debit,
   create the `PENDING_REVIEW` row. The player is debited **before** ZareCash is called,
   which is what the contract demands.
2. After the local transaction commits, enqueue a submit job (BullMQ, capped exponential
   backoff). Submitting inside the DB transaction would hold the wallet lock across a
   network call — never do that.
3. The job calls `POST /v1/withdrawals` with `Idempotency-Key: wd_<transaction.id>`,
   `destinationAccount`, `destinationName`. It stores `gatewayRef`.
4. Outcomes:
   - `pending` — float reserved, awaiting settlement. Local row stays `PENDING_REVIEW`.
   - `queued_float` — parked until float is credited. Local row stays `PENDING_REVIEW`;
     notify the player that the payout is processing. This is a normal state, not a fault,
     and the contract warns it is expected on a fresh live float.
   - `risk_hold` — a human at ZareCash decides. Stays `PENDING_REVIEW`.
   - `rejected` — refund locally through the existing rejection path.
5. **Permanent failure** (`403 player_frozen`, `400 amount_out_of_range`, or retries
   exhausted): auto-reject locally through the existing refund path, which re-credits the
   wallet and writes the `REFUND` compensation row. The player must never stay debited for
   a payout that was never accepted.
6. `409 withdrawal_pending` should be unreachable, since we enforce one-pending under the
   wallet lock. If it happens, our local state and ZareCash's disagree: log it loudly,
   leave the local row pending, and let the reconciliation sweep resolve it. Do not refund
   on this error — a payout may genuinely be in flight.

## Webhook handling

`POST /v1/zarecash/webhook`, public, no JWT.

1. Route-scoped `addContentTypeParser` stashes `__rawBody`, copying the pattern already in
   `apps/api/src/routes/hub/spoke-callback.ts:16`. HMAC must be computed over the raw
   bytes, never a re-serialised object.
2. Verify `pmv2-signature: t=<unix>,v1=<hex>`: reject `t` older than 300 seconds, compute
   `HMAC-SHA256(secret, "<t>.<rawBody>")`, compare with `timingSafeEqual`. Reuse the
   length-check-then-compare shape from `gateways/game-provider/signature.middleware.ts`.
3. Insert into `ZareCashEvent` keyed on the event `id`. A unique-constraint violation means
   this is a redelivery: return 200 immediately and do nothing.
4. Return 200 and process asynchronously. The contract allows 10 seconds; we should use a
   fraction of that.

Event mapping:

| Event | Action |
|---|---|
| `deposit.approved` | `WalletService.approveDeposit(txId, data.approvedAmount)`. Trust `approvedAmount`, never the amount we submitted — a reviewer may have corrected it. |
| `deposit.rejected` | Mark `REJECTED`. No wallet change; nothing was ever credited. |
| `withdrawal.approved` | Mark `APPROVED`, store `settlementRef`, notify the player. |
| `withdrawal.rejected` | Existing refund path: re-credit + `REFUND` compensation row + notify. |
| `withdrawal.cancelled` | Same as rejected. |
| `withdrawal.queued_float` | Stay `PENDING_REVIEW`; notify "processing". |
| `withdrawal.risk_hold` | Stay `PENDING_REVIEW`; raise an admin alert. |
| `float.low` | Admin notification + Sentry warning. Operational, not player-facing. |
| `settlement.statement_ready` | Log only for now. |

Every handler resolves our row by `gatewayRef`, and every handler is idempotent because
the underlying status transitions are already atomic conditional claims.

## Freeze sync

When an admin sets `user.isActive = false`, call `POST /v1/players/{userId}/freeze` with
the reason; on reinstatement, `unfreeze`. Best-effort and logged — a failed sync must not
block the local freeze, because the local freeze is the one that protects our own balance.
Deposits are deliberately unaffected on both sides.

## Reconciliation

A nightly BullMQ job sweeps `GET /v1/events` from the stored cursor and replays anything
whose `id` is absent from `ZareCashEvent`. The contract explicitly recommends this
(checklist item 7) because it is the only thing that makes a webhook outage survivable.
Because events carry full payloads, the sweep needs no follow-up fetch, and because
processing is keyed on event `id`, replay is free of side effects.

## Error mapping

| ZareCash | Local behaviour |
|---|---|
| `400 invalid_request` / `invalid_amount` | Log; treat as permanent; do not retry. |
| `400 method_unavailable` | Method is misconfigured. Alert admin, fall back to manual review. |
| `400 amount_out_of_range` | Surface to the player. Signals our limits have drifted from ZareCash's. |
| `401 unauthorized` / `tenant_suspended` | Fatal config error. Alert loudly; stop submitting. |
| `403 player_frozen` | Withdrawal: refund locally and tell the player. |
| `409 duplicate_receipt` | Map to the existing "Transaction ID already used" 409. |
| `409 withdrawal_pending` | See withdrawal step 6. Never refund on this. |
| `409 float_insufficient` | Should surface as `queued_float`; if returned directly, keep pending and alert. |
| `429 rate_limited` | Honour `Retry-After`; back off. Fixed window, 60 req/60s per tenant, per method, per route. |

## Test plan

The contract's sandbox triggers make every branch reachable without a clerk:

**Deposits** (matched on normalised `receiptRef`):

| `receiptRef` | Expected |
|---|---|
| `TEST-REJECT-*` | `REJECTED`, verdict `AMOUNT_MISMATCH` — local row rejected, wallet untouched |
| `TEST-STALE-*` | `REJECTED`, verdict `STALE_RECEIPT` |
| `TEST-REVIEW-*` | Stays `PENDING_REVIEW` — exercises the waiting state |
| anything else | `APPROVED`, wallet credited, **first-deposit bonus fires** |

**Withdrawals** (matched on the cents of `amount`), each with a **distinct `playerRef`** —
the one-open-withdrawal rule applies in test too, so reusing one player makes every request
after the first fail with `409`:

| Amount ends in | Expected |
|---|---|
| `.01` | `rejected` → local refund + `REFUND` row |
| `.02` | `queued_float` → stays pending, player notified |
| `.03` | stays `pending`, held in `reserved` |
| anything else | settled immediately with a synthetic `settlementRef` |

Beyond the triggers, the plan must cover: signature rejection (bad HMAC, replayed
timestamp beyond 300s), webhook redelivery of the same event `id`, an idempotent resubmit
of the same deposit, submit-failure → auto-refund on the withdrawal path, and a
`GET /v1/events` backfill after simulated webhook downtime.

Existing tests live in `apps/api/src/test/`; `gasea-wallet.test.ts` is the closest model
for signature and raw-body coverage.

## Open decision — method configuration

ZareCash holds `collectionAccount`, `minDeposit`, `maxDeposit`, `minWithdrawal` and
`maxWithdrawal` on its `PaymentMethod` model, with per-tenant overrides in
`TenantMethodConfig`. **None of it is exposed on `/v1`.** The published OpenAPI surface is
deposits, withdrawals, transactions, events, float, sandbox and players — there is no
`GET /v1/methods`.

This matters twice:

- **Collection account.** A player routed to ZareCash must pay into *ZareCash's* collection
  account, not our own `PaymentMethod.merchantAccount`. If ZareCash rotates that account
  and we are mirroring it by hand, players keep paying a dead account and deposits fail
  silently. Note the stored format is `"Name · 0911552200"` — see
  `deposits.service.ts:allowedReceiver`.
- **Limits.** We read `min_deposit_amount` / `max_deposit_amount` from `SiteSetting`;
  ZareCash enforces its own and returns `400 amount_out_of_range`. Two sources of truth
  means a player can pass our validation and be rejected downstream.

**Recommendation:** add `GET /v1/methods` to ZareCash returning `code`, `name`,
`collectionAccount` and tenant-resolved min/max. It is a small addition to a repo we own
and it removes the entire drift class.

**Not blocking:** the design puts method config behind a `MethodConfigSource` interface
with a hand-mirrored implementation, so the test phase proceeds today and swapping in the
endpoint later is a one-file change.

## Live phase (out of scope, noted so the design does not preclude it)

`llms.txt` documents a `receipt` object on `POST /v1/deposits`, required in live mode for
auto-verification. The OpenAPI request body omits it, but
`CreateDepositDto` in `apps/api/src/deposits/deposits.service.ts:30` does accept
`receipt?: ParsedReceipt` — so `llms.txt` is correct and the Swagger decorator is
incomplete. **That decorator should be fixed in the ZareCash repo**, separately from this
work.

The consequence for us: ZareCash does not currently fetch TeleBirr receipts itself (its
README lists the live HTML fetcher and SPKI pinning as a production add-on), but
world-bingo already has a working fetcher and parser *with* SPKI pinning
(`DEPOSIT_VERIFY_SPKI_PINS`). So the live-phase design is not "delete our scraper" — it is
**keep the scraper, stop it deciding, and feed its parsed output to ZareCash as `receipt`**.
`ParsedReceipt` in `services/deposit-verification/types.ts` already carries every value
ZareCash's shape needs, under different names — `settledAmount` → `amount`,
`receiptNumber` → `receiptRef`, `receiverNumberMasked` → `receiverMasked` — with
`ageHours` derived from `receiptTime`. A field mapper, not new scraping. Step 3 of the deposit flow is where that gets added.

## Out of scope

- Admin UI for the per-method `gateway` toggle (set via SQL or seed for now).
- Web app changes beyond whatever the collection-account decision forces.
- Migrating historical transactions into ZareCash.
- Retiring the manual flow. It stays as the fallback for every non-opted-in method.
