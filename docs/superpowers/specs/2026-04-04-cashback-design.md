# Cashback Feature Redesign — Threshold-Based Auto-Trigger

## Overview

Replace the existing manual promotion-disburse cashback system with a threshold-based, automatically triggered cashback system. Admins configure promotions with a date range, a minimum loss threshold, a refund amount (percentage or fixed), and an evaluation frequency. A BullMQ worker checks hourly and automatically credits qualifying players.

---

## Data Model

### `CashbackPromotion` — schema changes

Replace the existing `percentage` field with four new fields:

| Field | Type | Description |
|-------|------|-------------|
| `lossThreshold` | `Decimal(12,2)` | Net real-balance loss (ETB) required to qualify, e.g. `500.00` |
| `refundType` | `CashbackRefundType` | `PERCENTAGE` or `FIXED` |
| `refundValue` | `Decimal(10,2)` | `10.00` = 10% if PERCENTAGE; `50.00` = 50 ETB if FIXED |
| `frequency` | `CashbackFrequency` | `DAILY`, `WEEKLY`, or `MONTHLY` |

Existing fields kept: `id`, `name`, `startsAt`, `endsAt`, `isActive`, `createdAt`.

New enums:
```prisma
enum CashbackRefundType {
  PERCENTAGE
  FIXED
}

enum CashbackFrequency {
  DAILY
  WEEKLY
  MONTHLY
}
```

### `CashbackDisbursement` — unique constraint change

Change `@@unique([promotionId, userId])` → `@@unique([promotionId, userId, periodStart])`.

This allows the same player to receive cashback in multiple periods under the same promotion. `periodStart` and `periodEnd` fields already exist and continue to store the exact window boundaries.

---

## Cashback Checker Worker

A new BullMQ repeatable job `cashback-checker` registered on server boot. Runs **every hour**.

### Algorithm (per run)

1. Fetch all promotions where `isActive = true AND startsAt <= now AND endsAt >= now`
2. For each active promotion, compute the **current frequency window**:
   - `DAILY` → UTC start of today to end of today
   - `WEEKLY` → UTC start of Monday this week to end of Sunday
   - `MONTHLY` → UTC start of this calendar month to end of month
3. For each promotion, find qualifying players:
   - No `CashbackDisbursement` exists for `(promotionId, userId, periodStart)` — not yet paid this period
   - Net real-balance loss in window ≥ `lossThreshold`:
     ```
     netLoss = sum(GAME_ENTRY, APPROVED, real balance) - sum(PRIZE_WIN, APPROVED, real balance)
     netLoss >= lossThreshold
     ```
   - Exclude bot users (username starts with `bot_t`)
4. For each qualifying player, within a `SELECT FOR UPDATE` DB transaction:
   - Compute cashback:
     - `PERCENTAGE` → `netLoss * (refundValue / 100)`
     - `FIXED` → `refundValue`
   - Increment `wallet.bonusBalance` by cashback amount
   - Create `Transaction` record: `type = CASHBACK_BONUS`, `status = APPROVED`, real balance unchanged, bonus balance updated
   - Create `CashbackDisbursement` with `periodStart`, `periodEnd`, `amount`
   - Send `CASHBACK_AWARDED` push notification (fire-and-forget)

### Idempotency

The `@@unique([promotionId, userId, periodStart])` constraint on `CashbackDisbursement` prevents double-payment if the job runs concurrently or retries.

---

## API Changes

### Removed
- `POST /admin/cashback/:id/disburse` — manual disbursement removed

### Updated
- `POST /admin/cashback` — accepts `lossThreshold`, `refundType`, `refundValue`, `frequency` (drops `percentage`)
- `GET /admin/cashback` — returns new fields

### Unchanged
- `PATCH /admin/cashback/:id/toggle` — activate/deactivate a promotion

---

## Service Changes (`CashbackService`)

| Method | Change |
|--------|--------|
| `createPromotion()` | Updated to accept new fields |
| `listPromotions()` | Returns new fields |
| `togglePromotion()` | Unchanged |
| `disburse()` | **Removed** |
| `checkAndDisburse(promotionId, periodStart, periodEnd)` | **New** — called by the worker for one promotion + one period window |

---

## Admin UI (`pages/cashback/index.vue`)

### Create Promotion Form — field changes

| Removed | Added |
|---------|-------|
| Cashback Percentage | Loss Threshold (ETB, number input) |
| | Refund Type (select: Percentage / Fixed Amount) |
| | Refund Value (number input; label: "%" or "ETB" based on type) |
| | Frequency (select: Daily / Weekly / Monthly) |

### Promotion Card — display changes

- Old: `"10% cashback · Jan 1 — Jan 31"`
- New: `"Lose 500 ETB → get 10% back · daily · Jan 1 — Jan 31"`

### Removed
- "Disburse" button — disbursement is now fully automatic

---

## Validation Rules

- `lossThreshold` must be > 0
- `refundValue` must be > 0; if `PERCENTAGE`, must be ≤ 100
- `startsAt` must be before `endsAt`
- Only one promotion should be active at a time for the same player (enforced by the unique constraint per period — overlapping promotions are allowed but each pays independently)

---

## Out of Scope

- Per-player cashback caps (max payout per period)
- Cashback on third-party game losses (TP_BET/TP_WIN) — only bingo game entries are considered
- Retroactive recalculation for past periods
