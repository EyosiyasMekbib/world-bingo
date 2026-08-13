# Prediction Market — Design

**Date:** 2026-08-13
**Branch:** `feat/prediction-market`
**Status:** Approved for implementation

## Summary

A parimutuel prediction market on real-world events (football, politics, crypto,
entertainment). Players stake wallet funds on one of N mutually-exclusive outcomes. All
stakes on a market form a single pool; when the market resolves, the house takes a rake
snapshot off the top and the remainder is split pro-rata among the players who backed the
winning outcome.

The house carries **no position risk**. It cannot lose money on a market — its take is a
fixed percentage of a pot funded entirely by players. This is the reason parimutuel was
chosen over fixed odds or an order book.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Subject | Admin-created real-world events | Broadest audience |
| Mechanism | Parimutuel pool | Zero house risk, no matching engine, reuses existing pot/rake patterns |
| Market shape | N mutually-exclusive outcomes (N ≥ 2) | One schema covers Yes/No, 1X2, and multi-team markets |
| Resolution | Admin resolves + dispute window before payout | Recoverable from a misclick, no third-party feed dependency |
| Default rake | 10% | Matches `Tournament.houseEdgePct` — one house number across the platform |
| Degenerate pools | Full refund, rake 0 | Player-fair, no confiscation |

### Explicitly out of scope

Parlay/combo bets, selling out of a position before resolution, user-created markets,
automated resolution from an external data feed, and market comments. Each is a separate
project on top of these rails.

## Architecture

A standalone module beside the existing tournament and jackpot features. The bingo `Game`
model is **not** reused — it is coupled to cartelas, ball draws, and the leader-elected
game engine, and every prediction market stored as a `Game` would be a row the engine has
to learn to skip.

```
apps/api/src/
  services/prediction/
    market.service.ts       lifecycle + admin CRUD
    bet.service.ts          stake placement, player reads
    settlement.service.ts   payout math, settle, void, refunds
    index.ts                re-exports
  routes/prediction/index.ts        player API
  routes/admin/prediction/index.ts  admin API
  workers/prediction.worker.ts      auto-close + delayed settle
  gateways/prediction.gateway.ts    socket pool broadcasts
packages/shared-types/src/prediction/   Zod contracts + socket payloads
apps/web/pages/predictions/             player UI
apps/admin/pages/predictions/           admin UI
```

## Data Model

New Prisma models. Money columns follow the existing convention: `Decimal(12,2)` for
per-user amounts, `Decimal(14,2)` for pools, `Decimal(5,2)` for percentages.

```prisma
enum PredictionMarketStatus {
  DRAFT
  OPEN
  CLOSED
  RESOLVING
  SETTLED
  VOIDED
}

enum PredictionCategory {
  SPORTS
  POLITICS
  ENTERTAINMENT
  CRYPTO
  OTHER
}

enum PredictionBetStatus {
  PLACED
  WON
  LOST
  REFUNDED
}

model PredictionMarket {
  id               String                 @id @default(uuid())
  question         String
  description      String?
  category         PredictionCategory     @default(OTHER)
  imageUrl         String?
  status           PredictionMarketStatus @default(DRAFT)
  closesAt         DateTime
  resolvesAt       DateTime?
  rakePct          Decimal                @default(10) @db.Decimal(5, 2)
  minStake         Decimal                @default(10) @db.Decimal(12, 2)
  maxStake         Decimal                @default(10000) @db.Decimal(12, 2)
  totalPool        Decimal                @default(0) @db.Decimal(14, 2)
  betCount         Int                    @default(0)
  winningOutcomeId String?
  resolvedById     String?
  resolvedAt       DateTime?
  disputeUntil     DateTime?
  settledAt        DateTime?
  voidReason       String?
  createdById      String?
  createdAt        DateTime               @default(now())
  updatedAt        DateTime               @updatedAt
  outcomes         PredictionOutcome[]
  bets             PredictionBet[]

  @@index([status, closesAt])
  @@index([category, status])
  @@map("prediction_markets")
}

model PredictionOutcome {
  id         String           @id @default(uuid())
  marketId   String
  label      String
  sortOrder  Int
  poolAmount Decimal          @default(0) @db.Decimal(14, 2)
  betCount   Int              @default(0)
  market     PredictionMarket @relation(fields: [marketId], references: [id], onDelete: Cascade)
  bets       PredictionBet[]

  @@unique([marketId, sortOrder])
  @@index([marketId])
  @@map("prediction_outcomes")
}

model PredictionBet {
  id        String              @id @default(uuid())
  marketId  String
  outcomeId String
  userId    String
  stake     Decimal             @db.Decimal(12, 2)
  realPart  Decimal             @default(0) @db.Decimal(12, 2)
  bonusPart Decimal             @default(0) @db.Decimal(12, 2)
  status    PredictionBetStatus @default(PLACED)
  payout    Decimal             @default(0) @db.Decimal(14, 2)
  settledAt DateTime?
  createdAt DateTime            @default(now())
  market    PredictionMarket    @relation(fields: [marketId], references: [id], onDelete: Cascade)
  outcome   PredictionOutcome   @relation(fields: [outcomeId], references: [id], onDelete: Cascade)
  user      User                @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, status])
  @@index([marketId, outcomeId])
  @@index([marketId, status])
  @@map("prediction_bets")
}
```

Relations added to `User`: `predictionBets PredictionBet[]`.

### Enum additions

`TransactionType` gains `PREDICTION_BET`, `PREDICTION_WIN`, `PREDICTION_REFUND`.

These are **separate from `GAME_ENTRY`/`PRIZE_WIN` by design**. The GGR query in
`analytics.service.ts:575` and the cashback loss calculation in `cashback.service.ts:124`
both filter on `GAME_ENTRY`; reusing it would silently fold prediction turnover into bingo
revenue and make prediction losses eligible for bingo cashback.

`HouseTransactionType` gains `PREDICTION_RAKE`.

`NotificationType` gains `PREDICTION_SETTLED` and `PREDICTION_VOIDED`.

### Why `realPart` / `bonusPart` are stored per bet

Stakes draw down bonus balance first, then real — the rule already used at
`game.service.ts:102`. A void must return bonus money **as bonus money**; refunding a
bonus-funded stake to real balance turns a promotional credit into withdrawable cash. The
existing refund path reconstructs this split by re-reading the original transaction
(`game.service.ts:214`); storing it on the bet row makes it a direct read instead.

### Denormalized counters

`totalPool`, `betCount`, and `PredictionOutcome.poolAmount` exist for cheap list/detail
reads and live odds. They are **never** used to compute payouts — settlement re-aggregates
from `PredictionBet` rows, so a drifted counter can misprice a *display*, never a payout.

## Money Flow

### Placing a bet

Single Prisma transaction, mirroring `game.service.ts:88`:

1. `SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = $1 FOR UPDATE`
2. Re-read the market **inside** the transaction; abort unless `status = 'OPEN'` and
   `now < closesAt`. A bet racing the close job must lose this check.
3. Validate `minStake <= stake <= maxStake`.
4. Deduct bonus first, then real. Throw `Insufficient funds` if the combined balance is
   short (same message as `game.service.ts:99`).
5. Insert `PredictionBet` with the funding split.
6. Increment `outcome.poolAmount`, `outcome.betCount`, `market.totalPool`,
   `market.betCount`.
7. Insert `Transaction` (`PREDICTION_BET`, `referenceId = marketId`) with
   `balanceBefore`/`balanceAfter` and `bonusBalanceBefore`/`bonusBalanceAfter`.

After commit, emit `prediction:pools` to the market room.

### Payout formula

Computed at settlement by aggregating `PredictionBet` rows, not from the counters:

```
grossPool = Σ stake over all PLACED bets on the market
winPool   = Σ stake over all PLACED bets on the winning outcome
rake      = floor2(grossPool × rakePct / 100)
netPool   = grossPool − rake
payout_i  = floor2(stake_i × netPool / winPool)
dust      = netPool − Σ payout_i
```

`floor2` truncates toward zero at 2 decimal places. Dust (always ≥ 0, always < one cent
per winner) is credited to the house wallet in the same `HouseTransaction` as the rake.

**Invariant, asserted by test:** `Σ payout_i + rake + dust == grossPool`, exactly, in
`Decimal` arithmetic. No floating point anywhere in this path — use `Prisma.Decimal`
throughout.

### Settlement

Runs in the `prediction` BullMQ worker, guarded by Redlock on
`lock:prediction:settle:<marketId>` in the same style as the game engine.

1. Load the market; abort unless `status = 'RESOLVING'` and `now >= disputeUntil`.
2. Aggregate `grossPool` and `winPool` from `PLACED` bets.
3. If `winPool == 0` (nobody backed the winner) **or** every bet sits on a single outcome,
   divert to the void path — full refund, rake 0.
4. Otherwise credit the house `rake + dust` once, writing one `HouseTransaction`
   (`PREDICTION_RAKE`).
5. Page through winning bets in batches of 200. Each batch is its own transaction and
   only touches bets still `PLACED`: lock the wallet, credit `payout` to **real** balance,
   write a `PREDICTION_WIN` `Transaction`, flip the bet to `WON`.
6. Bulk-update remaining `PLACED` bets on losing outcomes to `LOST`.
7. Set `status = 'SETTLED'`, `settledAt = now`.
8. Enqueue notifications after commit.

**Idempotency.** Every batch filters on `status = 'PLACED'`, so a crash-and-retry resumes
rather than double-paying. The house credit is guarded by a check for an existing
`PREDICTION_RAKE` `HouseTransaction` referencing the market.

### Void / refund

Refunds return `realPart` to real balance and `bonusPart` to bonus balance, batched and
idempotent on `status = 'PLACED'`, each writing a `PREDICTION_REFUND` `Transaction`. The
house takes nothing — no `HouseTransaction` is written on a void. Market ends `VOIDED`
with `voidReason` set.

## Lifecycle

| From → To | Trigger | Notes |
|---|---|---|
| `DRAFT → OPEN` | admin publishes | requires ≥ 2 outcomes and `closesAt` in the future |
| `OPEN → CLOSED` | worker at `closesAt`, or admin closes early | idempotent; also enforced lazily inside bet placement |
| `CLOSED → RESOLVING` | admin resolves | sets `winningOutcomeId`, `resolvedById`, `resolvedAt`, `disputeUntil = now + window`; enqueues a delayed settle job; writes `AuditLog` |
| `RESOLVING → CLOSED` | admin reverses within the window | clears resolution fields, removes the delayed job, writes `AuditLog` |
| `RESOLVING → SETTLED` | settle job after `disputeUntil` | terminal |
| `DRAFT/OPEN/CLOSED/RESOLVING → VOIDED` | admin voids, or auto-void on a degenerate pool | refunds every `PLACED` bet |

`SETTLED` and `VOIDED` are terminal — no transition out of either.

Dispute window length: `SiteSetting` key `prediction_dispute_minutes`, default `30`. Read
at resolve time and stamped onto `disputeUntil`, so changing the setting never moves an
already-scheduled payout.

### Immutability after open

Once a market is `OPEN`, `question`, `rakePct`, and the outcome set (labels, count) are
frozen. Only `description`, `imageUrl`, and *extending* `closesAt` remain editable.
Rewriting outcomes while money sits in the pool is indistinguishable from rigging the
market; the audit log must be able to demonstrate it never happened.

`rakePct` is snapshotted onto the market at creation from the `SiteSetting` default, so
changing the platform default never alters a live pot.

## API

### Player — `apps/api/src/routes/prediction/index.ts`

All under the `feature_prediction_market` flag. `authenticate` on everything except the
two read endpoints.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/prediction/markets` | `?status=&category=&limit=&cursor=` | markets with outcomes, pools, implied odds |
| GET | `/prediction/markets/:id` | — | single market + outcomes |
| POST | `/prediction/markets/:id/bets` | `{ outcomeId, stake }` | created bet + updated pools |
| GET | `/prediction/bets` | `?status=&limit=&cursor=` | caller's bets with market/outcome |

Implied odds are derived, never stored: `odds_j = netPool / outcome_j.poolAmount`, with
`null` when `poolAmount` is 0.

### Admin — `apps/api/src/routes/admin/prediction/index.ts`

All behind `server.requireAdmin`, matching `routes/tournament/index.ts:83`.

| Method | Path | Body |
|---|---|---|
| GET | `/admin/prediction/markets` | `?status=&category=&limit=&cursor=` |
| POST | `/admin/prediction/markets` | `{ question, description?, category, imageUrl?, closesAt, resolvesAt?, rakePct?, minStake?, maxStake?, outcomes: [{ label, sortOrder }] }` |
| PATCH | `/admin/prediction/markets/:id` | editable subset, enforced by status |
| POST | `/admin/prediction/markets/:id/publish` | — |
| POST | `/admin/prediction/markets/:id/close` | — |
| POST | `/admin/prediction/markets/:id/resolve` | `{ outcomeId }` |
| POST | `/admin/prediction/markets/:id/unresolve` | — |
| POST | `/admin/prediction/markets/:id/void` | `{ reason }` |
| GET | `/admin/prediction/markets/:id/bets` | `?limit=&cursor=` — exposure view |

Every state-changing admin action writes an `AuditLog` row with
`target = "prediction_market:<id>"`.

### Errors

| Condition | Response |
|---|---|
| bet on a non-`OPEN` market or past `closesAt` | 409 |
| stake outside `[minStake, maxStake]` | 400 |
| insufficient balance | thrown as `Insufficient funds`, mapped to 400 as today |
| resolve a market not in `CLOSED` | 409 |
| unresolve outside the dispute window | 409 |
| mutate a frozen field on an `OPEN` market | 409 |
| feature flag off | 404 |

## Realtime

`apps/api/src/gateways/prediction.gateway.ts`, alongside `game.gateway.ts`. Room
`prediction:<marketId>`, joined from the market detail page.

| Event | Payload |
|---|---|
| `prediction:pools` | `{ marketId, totalPool, betCount, outcomes: [{ id, poolAmount, betCount, odds }] }` |
| `prediction:status` | `{ marketId, status, winningOutcomeId?, disputeUntil? }` |
| `prediction:settled` | `{ marketId, winningOutcomeId, totalPool, rake }` |

Pool emits are coalesced to at most one per second per market so a hot market cannot flood
the Redis adapter.

## Background Work

`QUEUE_NAMES.PREDICTION = 'prediction'` added to `lib/queue.ts`. One worker,
`workers/prediction.worker.ts`, imported from `index.ts` next to the existing workers.

| Job | Schedule | Effect |
|---|---|---|
| `close-due-markets` | repeatable, every 30s | `OPEN → CLOSED` for markets past `closesAt` |
| `settle-market` | delayed, enqueued at resolve time with `jobId = settle:<marketId>` | runs settlement |
| `void-market` | on demand | runs the refund path |

Deterministic `jobId` lets `unresolve` remove the pending settle job by id.

On server boot the worker re-enqueues `settle-market` for any market stuck in `RESOLVING`,
matching the existing stuck-game recovery.

## Shared Contracts

`packages/shared-types/src/prediction/` exporting Zod schemas and inferred types for the
market, outcome, bet, all request bodies, and the three socket payloads. Re-exported from
`src/index.ts` alongside `./crm`.

## Frontend

### Web — `apps/web/pages/predictions/`

`index.vue` (market list, category filter) and `[id].vue` (detail, outcome selection, bet
slip, live pools). A `stores/prediction.ts` Pinia store holds markets and the socket
subscription. Strings in both `en` and `am`.

The bet slip must display the payout estimate as **live and non-binding** — the number
moves as money arrives, and the UI has to say so rather than implying a locked quote.

### Admin — `apps/admin/pages/predictions/`

`index.vue` (table across all statuses), `new.vue` (create with dynamic outcome rows), and
`[id].vue` (detail, exposure per outcome, resolve/void actions). Resolve and void both
require typed confirmation of the outcome label — they move real money and a misclick is
expensive even with the dispute window.

## Feature Flag

`feature_prediction_market`, default `'false'`, added to the defaults map in
`routes/settings/index.ts:6`. Off means player and admin routes 404 and the nav entry is
hidden. Lets the feature merge to main dark and be enabled per brand.

## Testing

Vitest with mocked Prisma, following `test/tournament.service.test.ts`.

**Settlement math**
- `Σ payout_i + rake + dust == grossPool` exactly, across several stake distributions
- uneven splits (three winners on a 100.00 pool) produce no lost or invented cents
- `rakePct` snapshot is used, not the current `SiteSetting`

**Degenerate pools**
- zero bets on the winning outcome → every bet `REFUNDED`, no `HouseTransaction`
- all bets on one outcome → same
- an empty market resolves without error

**Funding split**
- bonus drains before real
- void returns `bonusPart` to bonus and `realPart` to real
- a win credits real balance only

**Idempotency**
- settling twice pays once
- refunding twice refunds once
- a batch failure mid-settlement resumes without double-paying

**Guards**
- a bet at `closesAt + 1ms` is rejected
- resolving a market that is not `CLOSED` is rejected
- unresolve after `disputeUntil` is rejected
- editing outcomes on an `OPEN` market is rejected
- non-admin cannot reach admin routes
- routes 404 with the flag off

## Risks

**Insider resolution.** An admin who can resolve markets can also bet on them. Mitigated
here by the audit log, the dispute window, and the exposure view; not eliminated. A
policy-level ban on staff betting, or a code-level block on admin accounts placing bets,
is worth deciding before this is enabled in production.

**Thin pools.** A market with little money produces wild implied odds and a poor
experience. `minStake` and market curation are the only levers in this version; seeding
liquidity would require the house to take a position, which this design deliberately
avoids.

**Regulatory.** Betting on real-world events is a different product from bingo and may
carry different licensing obligations in each operating market. Out of scope for the
implementation; flagged for the operator.
