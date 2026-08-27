# ZareCash hosted checkout

**Date:** 2026-08-27
**Status:** approved
**Depends on:** `2026-08-26-zarecash-integration-design.md` (the record-and-review
integration this builds on top of, already merged on `feat/zarecash-integration`)
**Scope:** design only. No code until the implementation plan is approved.

## Problem

The deposit modal asks the player to do the payment provider's job. They leave the app,
pay a merchant account by hand, come back, and re-key the transaction number, their own
name, their own account, and a screenshot of the receipt. Five fields and a file upload
stand between wanting to deposit and having deposited, and every one of them is a place to
mistype or give up.

ZareCash now serves a hosted payment page. We create a session, redirect the player, and
ZareCash handles method choice, the collection account, the written instructions, receipt
capture and reference extraction — in English or Amharic, chosen from the player's own
`Accept-Language`. The player comes back having deposited.

This document covers that flow and the deposit UI it lands in. The existing per-method
record-and-review routing is untouched and keeps working exactly as it does today.

## Contract

The authoritative contract is `https://api.zarecash.com/llms.txt`. That host currently
404s on every path, so this design was written against the source of truth in the ZareCash
repo itself: `~/Developer/paymentmgmtv2/apps/api/src/docs/llms.txt` (commit `9d15ef5`).
**Re-read the published llms.txt before implementation starts** and reconcile any drift.

The three endpoints this design adds:

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/checkout/sessions` | Create a hosted payment page, get its URL. |
| GET | `/v1/checkout/sessions/{id}` | Read session status and the deposit it produced. |
| POST | `/v1/checkout/sessions/{id}/cancel` | Close a session. |

Create takes `{ playerRef, amount, returnUrl }` plus the usual `Idempotency-Key`, and
returns `{ id, url, status, amount, playerRef, expiresAt, depositId }`. The player is
redirected to `url` and returns to `returnUrl?deposit=dp_XXXX&status=pending`.

Four contract facts drive the whole design:

1. **`status=pending` on the return is not a result.** The receipt was accepted; the money
   has not been verified. Credit only on `deposit.approved`. This is stated twice in the
   contract and it is the one mistake that would cost us real money.
2. **The deposit it produces is an ordinary deposit.** Same verification, same float, same
   `deposit.approved` / `deposit.rejected` webhooks. Nothing downstream needs a new path.
3. **A session is `open` for 20 minutes, then still accepts a receipt for 24 hours.** A
   player can return long after the redirect. Nothing may assume a session resolves inside
   one web request.
4. **`returnUrl` must share an origin with the tenant's configured Custom URL**, or create
   fails `invalid_return_url`. This is an open-redirect defence and is not relaxable.

Also load-bearing: repeating an `Idempotency-Key` returns the **same** session with a
**fresh** URL, and the previous link stops working — so we always redirect to the URL from
the most recent response, never a cached one.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the UI lives | Restyle `DepositModal.vue` | Every "Deposit" entry point in the app already opens it. A new page would mean moving withdraw and history too, for no gain the player can see. |
| Card list source | `GET /payment-methods?type=DEPOSIT`, ordered by `sortOrder` | The catalog already exists and is already admin-editable. Hosted checkout becomes a row in it, not a special case in the template. |
| Enabling checkout | A `PaymentMethod` row with `hostedCheckout = true` | Mirrors the per-method opt-in the branch already uses for `gateway`. The kill switch is `enabled = false`, one toggle in the admin panel, no redeploy. |
| Transaction lifecycle | Session-first; create the `Transaction` on first sight of `depositId` | Most sessions are abandoned. Creating a `PENDING_REVIEW` row up front would fill the admin deposit queue with ghosts that a clerk could approve by hand. |
| Idempotency key | Our own `ZareCashCheckoutSession.id` (cuid) | Deterministic, owned by us, exists before the call. Same reasoning as `dep_<transaction.id>` in the parent design. |
| Crediting | Existing `WalletService.approveDeposit` via the existing webhook path | It is not a credit — it grants the first-deposit bonus, evaluates the daily/weekly rules, pushes the balance over the socket, increments `wbDepositsTotal`, notifies, and triggers the referral bonus. A parallel credit path would silently stop doing all of it. |
| Manual flow | Unchanged | The bottom card keeps whatever `PaymentMethod.gateway` says today, record-and-review included. |

## Data model

Two columns and one model. One migration.

```prisma
model PaymentMethod {
  // ...
  hostedCheckout Boolean @default(false)  // deposits go through ZareCash's page
  logoUrl        String?                  // card header image; falls back to `icon`
}

/// One row per checkout attempt. Created before ZareCash is called, so its `id`
/// can serve as the Idempotency-Key. Carries no money and never credits.
model ZareCashCheckoutSession {
  id            String   @id @default(cuid())  // ours; also the Idempotency-Key
  sessionId     String?  @unique                // cs_… once ZareCash answers
  userId        String
  amount        Decimal  @db.Decimal(12, 2)
  status        String                          // open|submitted|expired|cancelled|dead
  depositId     String?  @unique                // dp_… once the player submits
  transactionId String?  @unique                // our Transaction, once created
  methodCode    String                          // our PaymentMethod.code
  returnUrl     String
  expiresAt     DateTime
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, status])
  @@index([status, expiresAt])
  @@map("zarecash_checkout_sessions")
}
```

`status` is a string rather than an enum for the same reason `PaymentMethod.gateway` is:
ZareCash owns the vocabulary and may add to it. We store what they send, plus `dead` for a
session our own sweep has retired.

A seed adds one `PaymentMethod`: code `zarecash`, name `ZareCash`, type `DEPOSIT`,
`gateway = "zarecash"`, `hostedCheckout = true`, `sortOrder = 0`, `enabled = false`. It
ships off. An operator turns it on when the tenant's Custom URL and webhook are configured.

`GET /payment-methods` gains `gateway`, `hostedCheckout` and `logoUrl` in its `select`.
The checkout row carries no `merchantAccount` — the collection account lives on ZareCash's
page, which is the entire point.

## Configuration

`WEB_BASE_URL` already exists in `apps/api/.env.example` and is the origin we send players
back to. It must equal the Custom URL configured in the ZareCash console for this tenant,
or every create fails `invalid_return_url`. This is per-brand: each brand is its own
ZareCash tenant with its own key, its own Custom URL and its own webhook. No new env var
is needed; the `.env.example` comment on `WEB_BASE_URL` gains a line saying so.

## Deposit UI

`apps/web/components/DepositModal.vue`. The modal body becomes a stack of method cards,
one per row from `GET /payment-methods?type=DEPOSIT`, in `sortOrder`. Each card is a white
logo strip (`logoUrl`, falling back to `icon` + name), the method name, an Amount field,
and a CONTINUE button. Exactly one card is expanded at a time; opening one collapses the
other.

**Hosted-checkout card** (`hostedCheckout = true`) expands to amount and CONTINUE, nothing
else. CONTINUE posts to `/wallet/deposit/checkout` and assigns `window.location` to the
returned `url`.

**Manual card** expands to what the modal shows today, unchanged: the merchant-account
banner, amount, transaction ID, sender name, sender account, receipt drop-zone, and the
submit button, posting the same multipart body to `/wallet/deposit`.

Everything already in the modal survives the restyle: the min/max hints, the daily and
weekly deposit-bonus hints from the promotions store, the quick-amount chips, the
`track()` analytics calls (`deposit_modal_opened`, `deposit_method_selected`,
`deposit_amount_entered`), the duplicate-transaction-ID 409 handling, and i18n for both
locales. New strings — the pending-confirmation copy in particular — land in both `en` and
`am`.

The component is at the size where one more flow would make it unreadable, so the card
list and the manual form each move into their own child component under
`components/deposit/`, leaving the modal to own state and submission.

## Flow

### Create

`POST /wallet/deposit/checkout`, authenticated, body `{ amount, methodCode }`.

1. Validate `amount` against the `min_deposit_amount` / `max_deposit_amount` site
   settings, the same two `WalletService.initiateDeposit` reads. The contract asks us to
   validate before creating: an amount outside every method's limits produces a page that
   tells the player nothing can accept it, which is a worse failure than a form error.
2. Resolve the method. It must exist, be `enabled`, be `type = DEPOSIT`, have
   `hostedCheckout = true` and `gateway = "zarecash"`. Anything else is a 400 — this
   endpoint never touches a manual method.
3. Insert the `ZareCashCheckoutSession` row (`status = "open"`).
4. `POST /v1/checkout/sessions` with `Idempotency-Key: <row id>`, `playerRef: userId`,
   `amount`, `returnUrl: ${WEB_BASE_URL}/wallet`.
5. Store `sessionId` and `expiresAt`. Return `{ url, expiresAt }`.

No `Transaction` row exists yet, and none is created if the player abandons the page.

### Return

The player lands on `/wallet?deposit=dp_XXXX&status=pending`. `wallet.vue` strips the
query from the URL, POSTs the `depositId` to `POST /wallet/deposit/checkout/claim`, and
shows a "we are confirming your deposit" state until the balance changes.

`claim` is authenticated and takes `{ depositId }`. Resolution is deterministic rather
than a guess about which of the caller's sessions this deposit belongs to: if a session
already carries this `depositId`, use it; otherwise poll `GET /v1/checkout/sessions/{id}`
for each of the caller's unlinked `open`/`submitted` sessions, newest first, and take the
one ZareCash reports the matching `depositId` for. A caller may legitimately have more
than one session in flight, so matching on "the most recent" would eventually attach a
deposit to the wrong one.

Once matched, it links the session and creates the `Transaction`:
`type = DEPOSIT`, `status = PENDING_REVIEW`, `gateway = "zarecash"`, `gatewayRef = dp_…`,
`note = methodCode`, and `amount` taken from the session, not from the client. Setting
`gateway` matters beyond bookkeeping: the admin double-pay
guard keys on it, so a clerk cannot hand-approve a deposit ZareCash also intends to
approve. `claim` **never credits** and is idempotent — a second call with the same
`depositId` returns the existing row.

A `depositId` that matches no session belonging to the caller is a 404. We do not trust a
query parameter to name someone else's deposit.

### Credit

`deposit.approved` and `deposit.rejected` arrive at the existing webhook route and resolve
our row by `gatewayRef`, exactly as they do today. `approveDeposit(txId, approvedAmount)`
credits, bonuses, notifies and pushes; the reject path marks `REJECTED` with no wallet
change.

One addition. When resolution by `gatewayRef` misses, the handler currently raises
`UnknownGatewayRefError` and quarantines the event for a retry window
(`zarecash.service.ts:52`) — designed for the race where our own `gatewayRef` write lands
a moment after the webhook. Hosted checkout adds a second, legitimate cause: the player
paid on ZareCash's page and closed the tab, so `claim` never ran and no row exists at all.

Before quarantining, the handler looks for a `ZareCashCheckoutSession` matching
`data.playerRef` with no linked transaction, and creates the `Transaction` from the
webhook payload (`data.playerRef` names the user, `data.statedAmount` the amount) — then
proceeds down the normal path. In both paths the credited figure comes from
`approvedAmount` on the event, never from the amount we recorded, because a reviewer may
have corrected it. Genuinely unknown refs still
quarantine. This is what makes "pay and never come back" credit correctly, which will be a
routine case, not an edge one.

### Sweep

The nightly `zarecash-sweep` worker gains two passes:

- Sessions past `expiresAt + 24h` with no `depositId` become `dead`.
- Sessions marked `submitted` with no linked `Transaction` are polled via
  `GET /v1/checkout/sessions/{id}`; if `depositId` is now set, the row is created as in
  `claim`.

The existing `GET /v1/events` backfill already covers a missed webhook, so this pass is
about sessions, not events.

## Error handling

| Condition | Behaviour |
|---|---|
| `invalid_return_url` | 500 to the player as a generic "deposits are unavailable"; log at error with the configured `WEB_BASE_URL` and raise to Sentry. This is a misconfiguration, not a player problem, and it fails every attempt until an operator fixes the Custom URL. |
| `rate_limited` (429) | Pass through with `Retry-After`. The card shows "too many attempts, try again shortly". |
| Timeout / 5xx on create | No session URL to redirect to; the local row stays `open` and unlinked, and the sweep retires it. The card shows an inline retry. We do **not** auto-retry inside the request — a second create with the same key would be safe, but the player is waiting. |
| ZareCash unreachable at boot | Unchanged from the parent design: it must not block boot. |
| Player deposits twice | Two sessions, two deposits, two credits. Correct — each is a real payment. |

## Testing

Vitest, following the existing `zarecash-*.test.ts` files:

- create: happy path, idempotency-key shape, below-min and above-max rejection, disabled
  method, non-checkout method, `invalid_return_url` mapping
- claim: creates the row with `gateway` set, is idempotent, 404s on another user's
  `depositId`, never credits
- webhook: `deposit.approved` for a claimed row credits through `approveDeposit`;
  `deposit.approved` for an unclaimed session creates the row then credits; an unknown ref
  with no session still quarantines
- sweep: expiry to `dead`, and `submitted`-without-transaction polling

The existing `apps/web/e2e/wallet-deposit-withdrawal.spec.ts` is updated for the card UI —
it currently asserts the flat TeleBirr form.

All of it runs against a `pk_test_` key using the documented sandbox triggers
(`TEST-REJECT-*`, `TEST-STALE-*`, `TEST-REVIEW-*`), and CI asserts `GET /v1/float` returns
`"mode": "test"`.

## Out of scope

- Withdrawals. ZareCash has no hosted payout page; `POST /v1/withdrawals` stays as built.
- Retiring the manual deposit flow. Both cards ship; the operator decides what is enabled.
- Operator branding on the payment page. The contract says it is not configurable.
