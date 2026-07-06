# Deposit Auto-Verification Engine — Design

**Date:** 2026-07-06
**Status:** Draft (design), pending user review → implementation plan
**Scope:** Automatically verify Telebirr deposits by fetching the canonical receipt
from `https://transactioninfo.ethiotelecom.et/receipt/{transactionId}`, parsing it,
and auto-crediting the wallet when everything matches (under a configurable cap).
Fall back to the existing manual review queue on any mismatch, not-found, unreachable,
or edge case. Feature ships behind a flag (default **off**) and never blocks or breaks
the current deposit flow.

## Problem

Deposits today are fully manual (see current flow below). Every deposit sits in
`PENDING_REVIEW` until a clerk opens `apps/admin/pages/deposits.vue`, eyeballs the
uploaded receipt image, and clicks Approve / Adjust / Decline. This is slow for the
player and a constant load on staff, even though the overwhelming majority of Telebirr
deposits are clean and verifiable against a public, authoritative source.

The receipt page is bilingual (Amharic + English); the parser keys off the **English
labels only** — sufficient for every field we need.

Telebirr publishes a canonical receipt for every transaction at
`https://transactioninfo.ethiotelecom.et/receipt/{transactionId}`. If we fetch and read
that receipt ourselves, we can auto-approve the clean common case in seconds and reserve
human attention for the genuine exceptions.

### Current deposit flow (unchanged by this design, except where noted)

```
Player → DepositModal (web) → POST /wallet/deposit  (amount, receipt image,
        transactionId, senderName, senderAccount, methodCode)
   → WalletController.deposit()
   → WalletService.initiateDeposit()  → Transaction @ PENDING_REVIEW
   → (today) waits for a human

Admin → GET /admin/transactions/pending → deposits.vue
   → POST /admin/transactions/:id/approve { amount? }
   → AdminService.reviewTransaction() → WalletService.approveDeposit(txId, adjustedAmount?)
        - SELECT FOR UPDATE on transaction + wallet rows
        - credits realBalance, records balance snapshots
        - first-deposit bonus, referral bonus, metrics, notification, wallet:updated socket
```

Key existing facts this design relies on:

- `Transaction.paymentTransactionId` is `@unique` and uppercase-normalized at
  `initiateDeposit()` — this is our idempotency / replay guard, already in place.
- `WalletService.approveDeposit(transactionId, adjustedAmount?)` is the single atomic
  credit path (row locks, snapshots, bonuses, notifications). **The engine reuses it
  verbatim** — it does not introduce a second way to credit a wallet.
- `PaymentMethod` already has `code`, `name`, `merchantName`, `merchantAccount`,
  `enabled`. These hold our receiving-account identity — no new table needed.
- Infra: BullMQ workers, native `fetch` (no axios), Redis. No OCR library, and this
  design **adds none** (see §"No OCR").

## The idea in one line

`transactionId → fetch official ethiotelecom URL → parse HTML → decision engine →
approveDeposit() (if clean & ≤ cap) else leave for manual with a reason`.

## No OCR — reconstruct from the transaction ID

The original ask mentioned OCR. During design we confirmed the receipt page is
**server-rendered HTML** (bilingual Amharic/English table), so it is parsed directly —
OCR would be strictly less reliable and is unnecessary.

We also decided the engine **never reads the player's uploaded image**. It always
reconstructs the receipt from the official URL using the `transactionId` the player
typed. The uploaded image is retained only for the human reviewer. Consequence: **no OCR
dependency anywhere**, and the only "input" the engine trusts is the transaction ID as a
lookup key into the canonical source. When the official URL is unavailable, the deposit
simply falls to manual.

## Trust model

- **The transaction ID is the credential.** The player supplies only the ID; the engine
  fetches the *canonical* receipt from ethiotelecom. Forged screenshots are irrelevant —
  we never read a user-supplied document.
- **Transaction IDs are high-entropy** (`DG61L089CL` — ~36¹⁰ space), so not feasibly
  enumerable.
- **Replay** is bounded by the existing `@unique` constraint: first valid submission
  wins; a second submission of the same ID is rejected as duplicate (loser, if genuine,
  is resolved by a human).
- **"Paid to someone else"** is defeated by the receiver-account gate (§Decision engine):
  the receipt's credit party must match one of *our* active receiving accounts.
- **"On behalf of / claiming another player's payment to us"** is mitigated by high-entropy
  IDs plus an optional payer soft-match; residual cases fall to manual.

## What a real receipt gives us

Fetched live during design (`.../receipt/DG61L089CL`, a telebirr→telebirr transfer):

| Receipt field            | Example value              | Use in engine |
|--------------------------|----------------------------|---------------|
| Credit party name        | `Zenu Abatamam Abamilki`   | must match an active method's `merchantName` |
| Credit party number      | `2519****2107` *(masked)*  | last-4 + prefix must be consistent with that method's `merchantAccount` |
| Settled Amount           | `500 Birr`                 | **the credited amount**; must equal player-stated amount |
| Total Paid               | `502 Birr` (incl. fee/VAT) | informational only — never credited |
| Status                   | `Completed`                | must be a success status |
| Receipt / invoice number | `DG61L089CL`               | equals `paymentTransactionId`; idempotency |
| Date / time              | `06-07-2026 10:43:19`      | optional freshness window |
| Debit (payer) name/number| `Natan Aklilu Abera` / `2519****2528` | optional payer soft-match |

Notes that shape the parser and matching:

- **Receiver numbers are masked** → we can never full-match a number. Identity =
  **credit-party name + last-4 (+ country prefix)** together, matched against the active
  method. This is why matching leans on `merchantName`.
- **Two amounts.** Match player-stated against **Settled Amount** (money we actually
  receive), not Total Paid.
- **Bilingual page** (Amharic + English) — parser keys off the **English labels only**.
- **Format varies** (telebirr→telebirr vs telebirr→bank); missing/ambiguous fields →
  manual, never a guess.
- **Invalid IDs** render a generic *"This request is not correct"* → `NOT_FOUND`.
- Endpoint has **TLS quirks** (needs relaxed cert verification for this host) and
  **rate-limits** (HTTP 429).

## Architecture

Verification runs **asynchronously in a BullMQ worker**, decoupled from the player's
submit request (the ethiotelecom endpoint is rate-limited, TLS-quirky, and variable
latency — it must never block or fail a deposit submission).

```
Player submits deposit
   → Transaction @ PENDING_REVIEW           (unchanged)
   → DepositVerification @ PENDING created
   → enqueue { transactionId } on DEPOSIT_VERIFICATION queue
        │
        ▼  worker (concurrency 1, Redis-spaced, BullMQ backoff on 429)
   load Transaction + resolve verifier by method
   → verifier.verify(transactionId)  ──fetch official URL, parse HTML──► ParsedReceipt | Unavailable
   → ReceiptDecisionEngine.evaluate(parsed, expected, config)  (pure fn)
        ├─ AUTO_CREDIT (clean match AND settledAmount ≤ cap)
        │     → WalletService.approveDeposit(txId, settledAmount)
        │     → DepositVerification @ AUTO_CREDITED
        │     → player sees "approved" within seconds
        ├─ MANUAL (mismatch / bad status / over cap / duplicate / not-our-account)
        │     → Transaction stays PENDING_REVIEW
        │     → DepositVerification @ MANUAL_REQUIRED, decisionReasons=[…]
        └─ UNAVAILABLE (not-found after retries / 429 / TLS / parse fail)
              → Transaction stays PENDING_REVIEW
              → DepositVerification @ UNAVAILABLE, decisionReasons=[…]

Admin queue (deposits.vue) shows the verification badge + parsed receipt panel so any
non-auto case is a one-glance / one-click human decision.
```

The engine only ever *removes* work in the happy path. It can never reject, lose, or
misdirect money on its own — the worst case is deferring to the manual path that exists
today.

### Components (each isolated, single-purpose, unit-testable)

1. **`DepositVerifier` interface** — `verify(transactionId) → ParsedReceipt |
   { unavailable: reason }`. Pure fetch + parse; matching is the decision engine's job,
   so the verifier takes no expectations. Registered per method code. Aligns with the existing
   `PaymentGateway.verifyPayment(transactionId)` seam. Telebirr is the first (and, in
   Phase 1, only) implementation; CBE/bank plug in later without touching the worker or
   decision engine.

2. **`TelebirrReceiptVerifier`** (`gateways/payment/telebirr-receipt.verifier.ts`) —
   - Fetches `https://transactioninfo.ethiotelecom.et/receipt/{id}` via native `fetch`
     with a host-scoped relaxed-TLS agent, a hard timeout, and a bounded response size.
   - Detects the not-found page → `{ unavailable: 'NOT_FOUND' }`.
   - Parses the HTML into a normalized `ParsedReceipt`
     `{ receiverName, receiverNumberMasked, settledAmount, totalPaid, status,
        receiptNumber, receiptTime, payerName, payerNumberMasked }`.
   - Handles both receipt formats; missing required fields → `{ unavailable: 'PARSE_FAILED' }`.
   - Parsing is label-driven off the **English labels** and tolerant; the raw HTML is
     snapshotted to `DepositVerification.rawSnapshot` for audit/debug.

3. **`ReceiptDecisionEngine`** (`services/deposit-verification/decision-engine.ts`) —
   a **pure function** `evaluate(parsed, expected, config) → { decision, creditAmount,
   reasons[] }`. No I/O. This is the heart of the feature and is exhaustively unit-tested.

4. **`deposit-verification.worker.ts`** — orchestrates load → verify → evaluate → act;
   writes `DepositVerification`; on `AUTO_CREDIT` calls `approveDeposit()`. Concurrency 1
   + Redis token-bucket spacing to respect ethiotelecom limits; BullMQ retry/backoff on
   429/timeout; after exhausting retries → `UNAVAILABLE` (manual).

5. **`deposit-verification.service.ts`** — enqueues jobs (called from
   `initiateDeposit()`), plus a small admin-facing "re-verify" action for a pending
   deposit.

6. **Admin surfacing** — `deposits.vue` gains a verification badge
   (Auto-credited / Verified·over-cap / Mismatch·<reason> / Unavailable) and a
   parsed-receipt panel (settled amount, receiver, status, payer, reasons) so the human
   decision is one glance and, for the over-cap-but-verified case, effectively one click
   (amount pre-filled from the authoritative settled amount).

## Decision engine — matching rules

`decision = AUTO_CREDIT` requires **all** of:

1. **Status** is a success value (`Completed` / `Success`).
2. **Receiver identity** matches an **active** (`enabled = true`, `autoVerify = true`)
   payment method of the deposit's provider:
   - `parsed.receiverName` matches that method's `merchantName`
     (normalized: trim, collapse whitespace, case-insensitive; diacritic-tolerant), **and**
   - `parsed.receiverNumberMasked` is consistent with that method's `merchantAccount`
     (compare last-4 and country prefix against the mask pattern).
   - Matched against **any** active auto-verify method (robust to the player picking the
     wrong tab). No active method matches (or it matches a **disabled / retired** method)
     → **hard fail → manual**, flagged `RECEIVER_MISMATCH`.
3. **Amount** — `parsed.settledAmount` equals the player-stated `amount`, exact to 2
   decimals. Mismatch → manual (`AMOUNT_MISMATCH`); the admin panel shows the true settled
   amount so Adjust-Approve is one tap.
4. **Not duplicate** — `receiptNumber` not already used by another transaction
   (existing `@unique`, re-checked under lock in `approveDeposit`). Duplicate →
   `DUPLICATE` → manual.
5. **Under cap** — `settledAmount ≤ deposit_auto_verify_max_amount`. Over cap →
   `OVER_CAP` → manual (but tagged "verified", so it's a trusted one-click approve).
6. *(optional, config-gated)* receipt **age** ≤ `deposit_auto_verify_max_age_hours`;
   payer **soft-match** (`payerName` vs the depositing account) → advisory reason, not a
   hard gate unless `deposit_auto_verify_require_payer_match = true`.

Any other outcome → `MANUAL` or `UNAVAILABLE` with a machine reason. Reason codes:
`AMOUNT_MISMATCH`, `RECEIVER_MISMATCH`, `BAD_STATUS`, `DUPLICATE`, `OVER_CAP`,
`STALE_RECEIPT`, `PAYER_MISMATCH`, `NOT_FOUND`, `UNREACHABLE`, `PARSE_FAILED`.

The engine **credits the settled amount** on auto-credit (the authoritative figure),
passed to `approveDeposit(txId, settledAmount)`; because it only auto-credits when
settled == stated, this equals the player's stated amount in the auto path.

## Receiving-account allow-list = the active `PaymentMethod`

Per decision: **no new table.** We validate against the existing `PaymentMethod` rows.

- Reuse `merchantName` (holder name → matches credit-party name) and `merchantAccount`
  (full receiving number → matched against the masked receipt number).
- Add one field: **`PaymentMethod.autoVerify` (Boolean, default false)** — opts a method
  into the engine. Only `enabled = true AND autoVerify = true` methods are considered.
- "Accounts change / old accounts" is handled naturally: rotate by toggling `enabled` /
  `autoVerify` and editing `merchantAccount` / `merchantName` in the existing admin
  Payment Methods UI. A receipt paid to a **different or now-retired** account matches no
  active method → **manual**, exactly as required. No migration of historical config,
  no separate allow-list to keep in sync.

If a method's `merchantAccount` is stored in a display format (e.g. `09xxxxxxxxxx` or
`251xxxxxxxxx`), the matcher normalizes both sides to compare country prefix + last-4
against the receipt mask. (Full equality is impossible because the receipt masks the
middle digits.)

## Data model

One new table (verification audit/state) + one new column (opt-in flag). No change to
`Transaction`, `Wallet`, or the credit path.

```prisma
model DepositVerification {
  id             String                     @id @default(uuid())
  transactionId  String                     @unique
  transaction    Transaction                @relation(fields: [transactionId], references: [id], onDelete: Cascade)
  status         DepositVerificationStatus  @default(PENDING)
  source         DepositVerificationSource  @default(RECEIPT_FETCH)
  decision       String?                     // AUTO_CREDIT | MANUAL | UNAVAILABLE
  decisionReasons String[]                   // machine reason codes
  // parsed receipt snapshot (nullable until fetched)
  receiverName        String?
  receiverNumberMasked String?
  settledAmount       Decimal?  @db.Decimal(12, 2)
  totalPaid           Decimal?  @db.Decimal(12, 2)
  receiptStatus       String?
  receiptNumber       String?
  receiptTime         DateTime?
  payerName           String?
  payerNumberMasked   String?
  rawSnapshot         Json?      // raw HTML / parsed blob for audit + debugging
  attempts            Int        @default(0)
  createdAt           DateTime   @default(now())
  updatedAt           DateTime   @updatedAt

  @@index([status])
  @@map("deposit_verifications")
}

enum DepositVerificationStatus {
  PENDING
  AUTO_CREDITED
  MANUAL_REQUIRED
  UNAVAILABLE
}

enum DepositVerificationSource {
  RECEIPT_FETCH   // only source in Phase 1
}

// PaymentMethod gains:
//   autoVerify  Boolean  @default(false)
```

`siteSetting` keys (all read at job time; feature is inert unless enabled):

- `deposit_auto_verify_enabled` — master switch (default `false`).
- `deposit_auto_verify_max_amount` — auto-credit cap in ETB.
- `deposit_auto_verify_max_age_hours` — optional freshness window (0 = off).
- `deposit_auto_verify_require_payer_match` — optional hard payer gate (default `false`).

## Error handling & resilience

- **Fail-safe default:** any exception, timeout, unexpected format, or ambiguous parse →
  `UNAVAILABLE`/`MANUAL`. The engine cannot reject or lose money; the human path is
  always the floor.
- **Rate limits (429):** single-concurrency worker + Redis token-bucket spacing between
  outbound calls + BullMQ exponential backoff. Sustained 429 → `UNAVAILABLE` → manual.
- **TLS:** a host-scoped agent with relaxed verification **only** for
  `transactioninfo.ethiotelecom.et` (never global), plus a request timeout and a capped
  response body.
- **Endpoint drift:** parser is tolerant and label-driven; `rawSnapshot` retained so a
  format change surfaces as a wave of `PARSE_FAILED → manual` (visible, safe) rather than
  bad credits. A metrics counter on reason codes makes drift observable.
- **Idempotent worker:** if a job runs twice, the second sees the transaction already
  `APPROVED` (guarded inside `approveDeposit`'s status check under lock) and no-ops.

## Observability

- Prometheus counter `wb_deposit_autoverify_total{result}` where result ∈
  `auto_credited | manual | unavailable`, and a second dimension of reason code.
- Reuse existing `EventService` to record `deposit_auto_verified` / `deposit_auto_credited`.
- The existing `wbDepositsTotal` metric already fires from `approveDeposit()`, so
  auto-credited deposits show up in current dashboards labeled by method.

## Testing (TDD)

- **Decision engine** — exhaustive unit tests: one per reason code + the clean
  auto-credit case + the over-cap case + boundary amounts (settled vs total, 2dp
  rounding) + masked-number matching (match, wrong last-4, wrong prefix) + name
  normalization (case, whitespace, diacritics) + disabled/retired method.
- **Parser** — fixture tests from saved real receipt HTML (English labels):
  telebirr→telebirr, telebirr→bank, the not-found page, a masked-number sample, and a
  truncated/garbage page. No live network in tests.
- **Worker** — integration test with a mocked `DepositVerifier`, asserting: clean+under-cap
  calls `approveDeposit` once with the settled amount; over-cap leaves `PENDING_REVIEW`;
  unavailable retries then defers; double-run is idempotent.
- **Feature flag off** — asserts the deposit flow is byte-for-byte the current behavior.

## Rollout

1. Ship dark (`deposit_auto_verify_enabled = false`). Enqueue + verify + write
   `DepositVerification`, but **do not** auto-credit — run in "shadow" so we compare the
   engine's decision against what clerks actually do.
2. After a shadow period looks right, enable auto-credit with a **low cap**, raise it as
   confidence grows.
3. Per-brand: the flag and cap live in `siteSetting`, so each deployment opts in
   independently.

## Non-goals (Phase 1)

- OCR of any image (dropped entirely — reconstruct from ID only).
- CBE Birr / bank / other-method verifiers (designed-for via `DepositVerifier`, not built).
- Auto-**decline** — the engine never rejects a deposit; declines stay 100% human.
- Auto-crediting an amount that differs from the stated amount (mismatch → manual).

## Open items for the implementation plan

- Exact HTML selectors / English label strings for both receipt formats
  (captured as parser fixtures during implementation).
- `merchantAccount` normalization rules for the specific formats you store today.
- Where the Redis token-bucket lives and the chosen spacing / timeout constants.
