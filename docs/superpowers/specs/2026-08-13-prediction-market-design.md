# Prediction Market — Design (Order Book)

**Date:** 2026-08-13
**Branch:** `feat/prediction-market`
**Status:** Approved for implementation
**Supersedes:** the parimutuel design committed in `a5a0f4b`

## Summary

A binary order-book prediction market. Players buy shares in one of two outcomes at a limit
price they set. A share pays **1.00 ETB if its outcome wins** and 0 otherwise. Orders match
against players who bought the opposing outcome — never against the house.

First markets are the **ETFC Fight Night** card on **27 August 2026** at the Adwa Museum,
Addis Ababa:

| Bout | Discipline | Outcomes |
|---|---|---|
| Sedo vs Johnny (main event) | MMA, Heavyweight | Sedo / Johnny |
| Boyka vs Endris | MMA, Heavyweight | Boyka / Endris |
| Esubalew vs Biniyam | Boxing, Lightweight | Esubalew / Biniyam |

ETFC is a third-party event. The platform does not run it and has no result feed, so
markets resolve by admin action with a dispute window before payout.

## The mechanism

Someone wants Sedo at **0.35**. Someone else wants Johnny at **0.65**. Together that is
exactly **1.00 ETB**, so the system takes 1.00 from the pair and issues one share to each.
When the fight is called, the winning side's shares pay 1.00 each; the losing side's pay 0.

Buying Johnny at 0.65 *is* offering Sedo at 0.35, so both sides live in one book quoted in
outcome-A price, matched on price-time priority.

Two properties this design guarantees, and that the tests assert:

- **Zero house position.** The house is never a counterparty. It cannot lose money on a
  market regardless of the result.
- **Provable solvency.** Every share pair is backed by exactly 1.00 ETB of escrowed player
  money. Total payout obligation equals total escrow, always. The book cannot promise more
  than it holds.

### No early exit

v1 has **no sell orders and no cash-out**. A position is held until the market resolves.
This is what keeps the engine small: with buy-only orders there is no inventory to unwind,
no short side, and no exit pricing. Selling out early is the next version.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Mechanism | Binary order book, buy-only | Zero house risk, real price discovery, half the engine of a full CLOB |
| Share face value | 1.00 ETB | Price reads directly as probability |
| Price range | 0.01 – 0.99, tick 0.01 | 1.00 would be a free share; 0.00 a free option |
| Early exit | Not in v1 | Removes sells, inventory, and exit pricing from the build |
| Draw / no-contest | Market voids, everyone refunded | Standard for combat sports; keeps matching binary |
| House fee | 15% of **profit** on winning positions | Favourites stay tradeable at every price |
| Resolution | Admin resolves + dispute window | Third-party event, no result feed |
| Liquidity | Concentration — few markets, one card | Three books, not fifty; the only cold-start fix that costs nothing |

### Why the fee is on profit, not gross payout

At 15% of gross, a share bought at 0.90 returns 0.85 — the player is right about the fight
and still down. Every price above 0.85 becomes unwinnable, which silently caps the book
below where main-event favourites actually trade. On profit, the same position pays 98.50
on a 90.00 cost and works at every price.

Profit on a winning position is always positive: cost basis per share is at most 0.99 and
payout is exactly 1.00. The implementation still clamps at zero.

### Explicitly out of scope

Selling before resolution, market orders (limit only), three-way markets, parlays,
user-created markets, automated resolution, and market making incentives.

## Architecture

```
apps/api/src/
  services/prediction/
    market.service.ts       lifecycle + admin CRUD
    order.service.ts        placement, cancellation, reserve accounting
    matching.service.ts     the engine — pure matching logic + fill application
    settlement.service.ts   payout, fee, void, refunds
    book.service.ts         aggregated depth + last price reads
  routes/prediction/index.ts        player API
  routes/admin/prediction/index.ts  admin API
  workers/prediction.worker.ts      auto-close + delayed settle
  gateways/prediction.gateway.ts    book / trade / status broadcasts
packages/shared-types/src/prediction/
apps/web/pages/predictions/
apps/admin/pages/predictions/
```

The bingo `Game` model is not reused — it is coupled to cartelas, ball draws, and the
leader-elected engine.

## Data Model

```prisma
enum PredictionMarketStatus {
  DRAFT
  OPEN
  CLOSED
  RESOLVING
  SETTLED
  VOIDED
}

enum PredictionOrderStatus {
  OPEN
  PARTIALLY_FILLED
  FILLED
  CANCELLED
}

enum PredictionPositionStatus {
  OPEN
  WON
  LOST
  REFUNDED
}

model PredictionMarket {
  id               String                 @id @default(uuid())
  eventName        String                 // "ETFC Fight Night"
  question         String                 // "Sedo vs Johnny — who wins?"
  description      String?
  imageUrl         String?
  status           PredictionMarketStatus @default(DRAFT)
  closesAt         DateTime
  resolvesAt       DateTime?
  feePct           Decimal                @default(15) @db.Decimal(5, 2)
  minOrderShares   Int                    @default(1)
  maxOrderShares   Int                    @default(100000)
  totalShares      Int                    @default(0)   // matched share pairs
  totalVolume      Decimal                @default(0) @db.Decimal(14, 2) // ETB escrowed
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
  orders           PredictionOrder[]
  fills            PredictionFill[]
  positions        PredictionPosition[]

  @@index([status, closesAt])
  @@map("prediction_markets")
}

model PredictionOutcome {
  id        String               @id @default(uuid())
  marketId  String
  label     String               // "Sedo"
  sortOrder Int                  // 0 or 1
  lastPrice Decimal?             @db.Decimal(4, 2)
  market    PredictionMarket     @relation(fields: [marketId], references: [id], onDelete: Cascade)
  orders    PredictionOrder[]
  positions PredictionPosition[]

  @@unique([marketId, sortOrder])
  @@map("prediction_outcomes")
}

model PredictionOrder {
  id             String                @id @default(uuid())
  marketId       String
  outcomeId      String
  userId         String
  limitPrice     Decimal               @db.Decimal(4, 2)  // 0.01 .. 0.99
  quantity       Int
  filledQuantity Int                   @default(0)
  reservedReal   Decimal               @default(0) @db.Decimal(12, 2)
  reservedBonus  Decimal               @default(0) @db.Decimal(12, 2)
  status         PredictionOrderStatus @default(OPEN)
  createdAt      DateTime              @default(now())
  updatedAt      DateTime              @updatedAt
  market         PredictionMarket      @relation(fields: [marketId], references: [id], onDelete: Cascade)
  outcome        PredictionOutcome     @relation(fields: [outcomeId], references: [id], onDelete: Cascade)
  user           User                  @relation(fields: [userId], references: [id], onDelete: Cascade)

  // the matching hot path: resting orders on one side, best price first, oldest first
  @@index([marketId, outcomeId, status, limitPrice, createdAt])
  @@index([userId, status])
  @@map("prediction_orders")
}

model PredictionFill {
  id            String           @id @default(uuid())
  marketId      String
  quantity      Int
  takerOrderId  String
  makerOrderId  String
  takerOutcomeId String
  makerOutcomeId String
  takerPrice    Decimal          @db.Decimal(4, 2)
  makerPrice    Decimal          @db.Decimal(4, 2)   // takerPrice + makerPrice == 1.00
  createdAt     DateTime         @default(now())
  market        PredictionMarket @relation(fields: [marketId], references: [id], onDelete: Cascade)

  @@index([marketId, createdAt])
  @@map("prediction_fills")
}

model PredictionPosition {
  id             String                   @id @default(uuid())
  marketId       String
  outcomeId      String
  userId         String
  shares         Int                      @default(0)
  costBasisReal  Decimal                  @default(0) @db.Decimal(12, 2)
  costBasisBonus Decimal                  @default(0) @db.Decimal(12, 2)
  status         PredictionPositionStatus @default(OPEN)
  payout         Decimal                  @default(0) @db.Decimal(12, 2)
  feePaid        Decimal                  @default(0) @db.Decimal(12, 2)
  settledAt      DateTime?
  createdAt      DateTime                 @default(now())
  updatedAt      DateTime                 @updatedAt
  market         PredictionMarket         @relation(fields: [marketId], references: [id], onDelete: Cascade)
  outcome        PredictionOutcome        @relation(fields: [outcomeId], references: [id], onDelete: Cascade)
  user           User                     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([marketId, outcomeId, userId])
  @@index([userId, status])
  @@index([marketId, status])
  @@map("prediction_positions")
}
```

`User` gains `predictionOrders`, `predictionPositions`.

### Enum additions

`TransactionType` += `PREDICTION_ORDER_HOLD`, `PREDICTION_ORDER_RELEASE`, `PREDICTION_WIN`,
`PREDICTION_REFUND`.

Kept distinct from `GAME_ENTRY`/`PRIZE_WIN` because the GGR query at
`analytics.service.ts:575` and the cashback loss calculation at `cashback.service.ts:124`
filter on `GAME_ENTRY`; reusing it would fold prediction turnover into bingo revenue and
make prediction losses earn bingo cashback.

`HouseTransactionType` += `PREDICTION_FEE`.
`NotificationType` += `PREDICTION_SETTLED`, `PREDICTION_VOIDED`.

## Money Flow

All amounts are `Prisma.Decimal`. No floating point anywhere in this feature.

### Placing an order

One transaction, wallet locked as in `game.service.ts:88`:

1. `SELECT ... FROM wallets WHERE "userId" = $1 FOR UPDATE`
2. Re-read the market inside the transaction; require `status = 'OPEN'` and `now < closesAt`
3. Validate `0.01 <= limitPrice <= 0.99`, price is a whole number of ticks, and
   `minOrderShares <= quantity <= maxOrderShares`
4. Reserve `limitPrice × quantity`, drawn **bonus first, then real**, recorded as
   `reservedReal` / `reservedBonus` on the order. Throw `Insufficient funds` if short.
5. Insert the order, write a `PREDICTION_ORDER_HOLD` `Transaction`

The money leaves the wallet at order time, not at fill time. A resting order is always
fully funded, so matching can never fail for lack of funds.

Matching then runs (below). Any reserve the fills did not consume is released immediately.

### Matching

Runs under a Redlock on `lock:prediction:match:<marketId>` so only one order is matched
against a market's book at a time. Volume here is one event with a few thousand orders — a
DB-backed engine under a per-market lock is the right trade against an in-memory book that
would need its own recovery story.

For an incoming (taker) order on outcome X at price `p_t`:

1. Select resting orders on the **opposite** outcome with
   `status IN ('OPEN','PARTIALLY_FILLED')` and `limitPrice >= 1.00 - p_t`, ordered by
   `limitPrice DESC, createdAt ASC`. Skip orders belonging to the taker — no self-matching.
2. For each, fill `min(taker remaining, maker remaining)` shares:
   - maker pays its own `limitPrice` (`p_m`)
   - taker pays `1.00 - p_m`, which is `<= p_t` — **the taker gets the price improvement**
   - the pair contributes exactly `1.00` per share to escrow
3. Write a `PredictionFill`; update `filledQuantity` and status on both orders.
4. Upsert both `PredictionPosition` rows: `shares += qty`, and add the consumed reserve to
   `costBasisReal` / `costBasisBonus` **in the same proportion it was reserved**, so a
   position always remembers how much of it was bonus-funded.
5. Release the taker's price improvement (`p_t - (1.00 - p_m)` per share) back to the
   wallet in the original real/bonus proportion, as `PREDICTION_ORDER_RELEASE`.
6. Increment `market.totalShares`, `market.totalVolume`; set `lastPrice` on both outcomes.
7. Stop when the taker is filled or no resting order satisfies the price condition.

Ordering resting orders by `limitPrice DESC` serves the most aggressive counterparty first,
which is also the cheapest fill for the taker — standard price-time priority, expressed in
complementary prices.

### Cancelling

Releases `reserved × (unfilled / quantity)`, proportionally across real and bonus, and sets
the order `CANCELLED`. Only the owner can cancel, only while `OPEN`/`PARTIALLY_FILLED`, and
only while the market is `OPEN`. Filled shares are not affected — those are positions now.

### Settlement

In the worker, under a Redlock on `lock:prediction:settle:<marketId>`.

1. Require `status = 'RESOLVING'` and `now >= disputeUntil`.
2. Cancel and fully refund every remaining open order (unmatched money was never at risk).
3. Page winning positions in batches of 200, each its own transaction filtered on
   `status = 'OPEN'` so a retry cannot double-pay:
   ```
   gross  = shares × 1.00
   basis  = costBasisReal + costBasisBonus
   profit = max(gross − basis, 0)
   fee    = round2(profit × feePct / 100)
   net    = gross − fee
   ```
   Credit `net` to **real** balance, write `PREDICTION_WIN`, set the position `WON` with
   `payout` and `feePaid`.
4. Bulk-set losing positions to `LOST`, payout 0.
5. Credit the summed fees to the house as one `HouseTransaction` (`PREDICTION_FEE`),
   guarded against an existing row for the market.
6. Market → `SETTLED`. Notifications after commit.

**Solvency invariant, asserted by test:** for any market,
`Σ costBasis over all positions == totalShares × 1.00`, and gross payout to the winning
side is exactly `totalShares × 1.00`. Losers' escrow funds winners exactly; the fee is
carved from winners' profit, never from principal the book does not hold.

### Void — draw, no-contest, or cancelled bout

Refund every position at cost basis, `costBasisReal` → real and `costBasisBonus` → bonus,
and fully refund every open order. No fee, no `HouseTransaction`. Positions → `REFUNDED`,
market → `VOIDED` with `voidReason`. Batched and idempotent on status, same as settlement.

Returning bonus as bonus is the anti-laundering rule from `game.service.ts:214` — refunding
a bonus-funded position to real balance would turn promotional credit into withdrawable
cash.

## Lifecycle

| From → To | Trigger |
|---|---|
| `DRAFT → OPEN` | admin publishes; requires exactly 2 outcomes and `closesAt` in the future |
| `OPEN → CLOSED` | worker at `closesAt`, or admin closes early; idempotent |
| `CLOSED → RESOLVING` | admin resolves; sets `disputeUntil = now + window`, enqueues delayed settle, writes `AuditLog` |
| `RESOLVING → CLOSED` | admin reverses inside the window; removes the delayed job |
| `RESOLVING → SETTLED` | settle job after `disputeUntil` |
| any non-terminal → `VOIDED` | admin voids, or a draw / no-contest |

`SETTLED` and `VOIDED` are terminal. Orders can only be placed while `OPEN`.

Dispute window: `SiteSetting` `prediction_dispute_minutes`, default `30`, stamped onto
`disputeUntil` at resolve time so changing the setting never moves a scheduled payout.
`feePct` is likewise snapshotted onto the market at creation.

### Immutability after open

Once `OPEN`, `question`, `feePct`, and the outcome labels are frozen; only `description`,
`imageUrl`, and *extending* `closesAt` remain editable. Changing an outcome label while
money is escrowed against it is indistinguishable from rigging the market.

## API

### Player — `routes/prediction/index.ts`

| Method | Path | Body / Query |
|---|---|---|
| GET | `/prediction/markets` | `?status=&limit=&cursor=` |
| GET | `/prediction/markets/:id` | includes book depth + last price |
| GET | `/prediction/markets/:id/book` | aggregated depth per outcome |
| POST | `/prediction/orders` | `{ marketId, outcomeId, limitPrice, quantity }` |
| DELETE | `/prediction/orders/:id` | cancel own order |
| GET | `/prediction/orders` | own orders, filterable by status |
| GET | `/prediction/positions` | own positions with market/outcome |

Book depth aggregates open orders by `(outcomeId, limitPrice)` into
`{ price, shares }` levels, best price first.

### Admin — `routes/admin/prediction/index.ts`, all behind `server.requireAdmin`

`GET /markets` · `POST /markets` · `PATCH /markets/:id` · `POST /markets/:id/publish` ·
`/close` · `/resolve` `{ outcomeId }` · `/unresolve` · `/void` `{ reason }` ·
`GET /markets/:id/book` · `GET /markets/:id/positions` · `GET /markets/:id/orders`

Every state-changing admin action writes an `AuditLog` with
`target = "prediction_market:<id>"`.

### Errors

| Condition | Status |
|---|---|
| order on a non-`OPEN` market or past `closesAt` | 409 |
| price outside 0.01–0.99 or off-tick; quantity out of bounds | 400 |
| insufficient balance | `Insufficient funds`, mapped to 400 as today |
| cancelling an order that is not yours | 403 |
| cancelling a `FILLED`/`CANCELLED` order | 409 |
| illegal lifecycle transition, or editing a frozen field | 409 |
| feature flag off | 404 |

## Realtime

`gateways/prediction.gateway.ts`, room `prediction:<marketId>`.

| Event | Payload |
|---|---|
| `prediction:book` | `{ marketId, outcomes: [{ outcomeId, lastPrice, levels: [{ price, shares }] }] }` |
| `prediction:trade` | `{ marketId, outcomeId, price, quantity, at }` |
| `prediction:status` | `{ marketId, status, winningOutcomeId?, disputeUntil? }` |
| `prediction:settled` | `{ marketId, winningOutcomeId, totalShares, totalFee }` |

Book emits coalesce to at most one per second per market.

## Background Work

`QUEUE_NAMES.PREDICTION = 'prediction'`, worker `workers/prediction.worker.ts` imported
from `index.ts` beside the existing workers.

| Job | Schedule | Effect |
|---|---|---|
| `close-due-markets` | repeatable, 30s | `OPEN → CLOSED` past `closesAt` |
| `settle-market` | delayed, `jobId = settle:<marketId>` | runs settlement |
| `void-market` | on demand | runs the refund path |

The deterministic job id lets `unresolve` remove the pending settle job. On boot the worker
re-enqueues `settle-market` for markets stuck in `RESOLVING`.

## Frontend

### Web — `apps/web/pages/predictions/`

`index.vue` lists the card — one row per bout showing both fighters and their current
prices as percentages. `[id].vue` is the market: both sides with live book depth, an order
ticket (pick outcome, price, quantity, see cost and payout-if-right), the player's open
orders with cancel, and their position.

The ticket must state plainly that an order **rests until someone takes the other side**
and can be cancelled until it fills — an unfilled order is the normal case in a young book
and must not read as a failure. It must also state that positions are **held to the result**;
there is no cash-out in this version.

Prices display as percentages (0.35 → 35%) and cost in ETB. Strings in `en` and `am`.

### Admin — `apps/admin/pages/predictions/`

`index.vue` (all markets, all statuses), `new.vue` (create: event name, question, two
outcome labels, `closesAt`, fee/size overrides), `[id].vue` (book depth both sides, fills,
positions, per-outcome payout obligation, and the lifecycle actions legal for the current
status).

Resolve and void require typed confirmation of the outcome label or the word `VOID`.
While `RESOLVING`, show the dispute countdown with unresolve available until it expires.

## Feature Flag

`feature_prediction_market`, default `'false'`, added to the defaults map in
`routes/settings/index.ts:6`. Off means the routes 404 and the nav entry hides.

## Testing

Vitest with mocked Prisma, following `test/tournament.service.test.ts`.

**Matching engine** (pure logic, exhaustively tested)
- complementary match only when `p_taker + p_maker >= 1.00`
- maker pays its limit; taker pays `1.00 - p_maker` and gets the improvement
- every fill contributes exactly 1.00 per share to escrow
- price-time priority: higher maker price first, older first at equal price
- partial fills across multiple makers; taker remainder rests
- self-match is skipped
- no match when the book is empty or all prices are too low

**Escrow / solvency**
- `Σ costBasis == totalShares × 1.00` after arbitrary fill sequences
- gross payout to the winning side equals total escrow
- cancel releases exactly the unfilled reserve, never more

**Funding split**
- reserve draws bonus before real
- price improvement and cancellation release in the original proportion
- void returns `costBasisBonus` to bonus and `costBasisReal` to real
- a win credits real balance only

**Fee**
- `fee == 15% of (gross − basis)`, clamped at zero
- a position bought at 0.90 is still profitable after fee
- `feePct` comes from the market snapshot, not the current setting

**Idempotency**
- settling twice pays once; voiding twice refunds once
- a batch failure mid-settlement resumes without double-paying

**Guards**
- an order at `closesAt + 1ms` is rejected
- off-tick prices (0.355) and out-of-range prices (0.00, 1.00) are rejected
- cancelling someone else's order is rejected
- resolving a non-`CLOSED` market is rejected
- unresolve after `disputeUntil` is rejected
- routes 404 with the flag off

## Risks

**Empty books.** With no house market maker, a market with no counterparty simply has no
price. Concentration on three bouts is the mitigation; the UI stating plainly that an order
rests until matched is the rest of it. If the book stays empty in the days before the card,
the operator's options are fewer markets or seeding orders manually — the latter is a house
position and is deliberately not built.

**Insider resolution.** An admin who resolves markets can also trade them. The audit log,
dispute window, and positions view are mitigations, not a fix. Deciding whether staff may
hold positions is worth settling before go-live.

**Deadline.** The card is 27 August 2026. The matching engine and settlement are the
irreducible core; the admin UI can be thin and the player UI can ship without niceties, but
the escrow and payout paths cannot be rushed.

**Regulatory.** Betting on third-party combat sports is a different product from bingo and
may carry different licensing obligations. Flagged for the operator.
