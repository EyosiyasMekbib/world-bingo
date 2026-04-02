# Admin Dashboard Redesign — Design Spec

**Date:** 2026-04-02
**Branch:** feature/accounting-hardening
**Status:** Approved

---

## Overview

Redesign the admin dashboard to provide clear financial observability, full fund traceability, better search/filter UX on operational tables, and honest house wallet accounting including negative balance support.

---

## 1. Navigation Restructure

Reorganize the sidebar into logical groups:

```
Overview
  └── Dashboard (/)

Finance
  ├── Deposits (/deposits)
  ├── Withdrawals (/withdrawals)
  ├── House Wallet (/house)
  └── Money Flow (/money-flow)  ← new page

Games
  ├── Active Games (/games)
  └── Game Templates (/settings/game-templates)

Players (/players)
Users (/users)
Providers (/providers)
Settings (/settings/profile)
```

The existing `/orders` page (transaction history) is absorbed into the Finance group as a sub-tab or merged into the Money Flow page to eliminate redundancy.

---

## 2. Dashboard Overview (`/`)

Two clearly separated sections on one scrollable page.

### Section A — Money In / Out

| Stat | Source | Color |
|------|--------|-------|
| Total Approved Deposits | `transaction` WHERE type=DEPOSIT, status=APPROVED | Green |
| Total Approved Withdrawals | `transaction` WHERE type=WITHDRAWAL, status=APPROVED | Red |
| Net Player Balance | Deposits − Withdrawals | Neutral |
| Total Prizes Paid Out | `transaction` WHERE type=PRIZE_WIN, status=APPROVED | Red |
| House Wallet Balance | `houseWallet.balance` | Yellow (red + warning badge if < 0) |
| Provider Net per row | `thirdPartyTransaction` grouped by provider | Green/Red per row |

Provider rows show: Provider Name | Total Gained (house won) | Total Lost (players won) | Net.

### Section B — Game Performance

| Stat | Source |
|------|--------|
| Games Completed | `game` WHERE status=COMPLETED |
| Games Cancelled | `game` WHERE status=CANCELLED |
| Total Bingo Prize Pools | Sum of (ticketPrice × entries) for completed games |
| House Commission Earned | `houseTransaction` WHERE type=COMMISSION, _sum.amount |
| Active Players | Distinct `userId` in `gameEntry` |

**Note:** `totalProfit` in the current stats endpoint is a theoretical calculation (house edge × pool). Replace it with the real `houseTransaction.COMMISSION` sum. The theoretical figure can be removed or shown separately as "Expected Commission."

### Backend change

Extend `GET /admin/stats` to return:
- `approvedDepositSum`, `approvedWithdrawalSum`, `totalPrizesSum`
- `houseBalance`, `houseCommissionEarned`
- `gamesCompleted`, `gamesCancelled`, `totalPrizePools`, `activePlayers`
- `providerStats`: `[{ name, gained, lost, net }]` — aggregated from `thirdPartyTransaction`

---

## 3. Deposits & Withdrawals Search/Filter Toolbar

Both `/deposits` and `/withdrawals` get a consistent filter toolbar:

```
[ Search: username or phone ] [ User ID (serial) ] [ Date From ] [ Date To ] [ Amount Min ] [ Amount Max ] [ Status ▼ ] [ Reset ]
```

- **Search**: debounced 400ms, matches `user.username` or `user.phone` (existing param)
- **User ID**: exact match on `user.serial` (5-digit padded ID)
- **Date From / Date To**: filters `createdAt` range
- **Amount Min / Max**: filters `amount` range
- **Status**: existing dropdown (Pending / Approved / Declined)
- **Reset**: clears all filters, reloads

### Backend changes

`AdminService.getTransactions()` gains optional params:
- `from: Date`
- `to: Date`
- `minAmount: number`
- `maxAmount: number`
- `userSerial: number`

Applied as Prisma `where` conditions. Both `GET /admin/transactions/pending` and `GET /admin/withdrawals` pass these through from query string.

---

## 4. Money Flow Audit Page (`/money-flow`) — New

A standalone page tracing every money movement on the platform.

### Part A — Flow Summary (top of page)

Visual chain of platform-wide lifetime totals:

```
Players Deposited → Wagered in Games → Prizes Paid Out → House Kept → Refunds Issued
      X ETB              Y ETB               Z ETB           W ETB         V ETB
```

Each figure is a clickable number that scrolls to the filtered ledger below (e.g., clicking "Prizes Paid Out" filters the ledger to `PRIZE_WIN`).

### Part B — Unified Transaction Ledger

A single paginated table merging `transaction`, `houseTransaction`, and `thirdPartyTransaction`, ordered by `createdAt DESC`.

**Columns:**

| Date | Type | Direction | Amount | Player | Game ID | Source | Balance After |
|------|------|-----------|--------|--------|---------|--------|---------------|

- **Type**: `DEPOSIT`, `WITHDRAWAL`, `GAME_ENTRY`, `PRIZE_WIN`, `COMMISSION`, `BOT_PRIZE_WIN`, `REFUND`, `ADMIN_ADJUSTMENT`, `PROVIDER_BET`, `PROVIDER_WIN`
- **Direction**: `IN` (money entered platform or house) / `OUT` (money left platform or house)
- **Source**: `Player Wallet`, `House Wallet`, `Provider`
- **Game ID**: clickable chip, navigates to `/games?id=<gameId>`

**Filters:**
- Type multi-select
- Direction (IN / OUT / All)
- Date range (From / To)
- Player search (username or phone)

### Backend — new endpoint

`GET /admin/money-flow`

Query params: `page`, `limit`, `type[]`, `direction`, `from`, `to`, `search`

Aggregates across all three transaction tables with a unified shape. Returns `{ rows, total, page, limit }`.

Each row has: `{ id, createdAt, type, direction, amount, playerName, playerId, gameId, source, balanceAfter }`.

`direction` is derived: DEPOSIT/PRIZE_WIN/COMMISSION/PROVIDER_WIN = IN to respective wallet; WITHDRAWAL/GAME_ENTRY/REFUND/BOT_PRIZE_WIN/PROVIDER_BET = OUT.

---

## 5. House Wallet — Negative Balance Support

### Display changes only (no DB migration, no new funding endpoint)

- Balance < 0: display in **red** with `⚠ House is in deficit` warning badge
- Balance ≥ 0: display in yellow as currently
- The existing 3 summary chips (Commissions Earned, Bot Wins Paid, Refunds Issued) remain — they are lifetime totals independent of current balance
- Transaction history gains **Date From / Date To** filters alongside the existing type filter

### Why it already works

`HouseWalletService.execDebit()` has no floor check — it will go negative freely. The only change needed is accurate display and the date filter on the transactions table.

---

## 6. Affected Files Summary

### Frontend (`apps/admin`)

| File | Change |
|------|--------|
| `layouts/default.vue` | Restructure sidebar into grouped nav |
| `pages/index.vue` | Full rewrite — two-section dashboard |
| `pages/deposits.vue` | Add filter toolbar |
| `pages/withdrawals.vue` | Add filter toolbar |
| `pages/house.vue` | Negative balance display + date filter |
| `pages/money-flow.vue` | New page — flow summary + unified ledger |
| `composables/useAdminApi.ts` | Add `getMoneyFlow()`, extend `getStats()`, extend transaction fetch params |

### Backend (`apps/api`)

| File | Change |
|------|--------|
| `services/admin.service.ts` | Extend `getStats()`, extend `getTransactions()` with new filter params |
| `controllers/admin.controller.ts` | Pass new query params through |
| `routes/admin/index.ts` | Add `GET /admin/money-flow` endpoint; update existing endpoint query parsing |

---

## 7. Out of Scope

- Time-range selector on the dashboard (all-time totals only)
- House wallet manual deposit/withdrawal UI (balance can go negative; admin monitors via Money Flow)
- Games table search/filter improvements (deferred)
- Real-time dashboard auto-refresh (manual refresh button stays)
