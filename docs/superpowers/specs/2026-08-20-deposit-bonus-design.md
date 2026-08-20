# Deposit bonuses — design

**Status:** Designed, not implemented.
**Date:** 2026-08-20

Two new promotions that pay bonus credit for depositing:

- **Daily** — deposit at least *T* in a day, get a bonus, at most once per day.
- **Weekly** — deposit at least *T* cumulatively across a week, get a bonus, at most once per week.

Each grant carries its own validity window and its own remaining balance, so "how much bonus do
I still have and when does it die" is answerable per grant rather than as one undifferentiated
lump. Alongside them, an `avgDailyDeposit` metric so the CRM can segment players by deposit
intensity.

---

## 1. Why the existing bonus balance cannot carry this

`Wallet.bonusBalance` is a single `Decimal` column. It has no expiry and no per-grant identity.
Nothing in the schema can express "this 100 dies on the 27th and that 150 dies on the 2nd", and
nothing can answer a player asking why their balance dropped overnight.

The design therefore introduces **grant lots**: one row per bonus award, carrying `amount`,
`remaining` and `expiresAt`. `Wallet.bonusBalance` survives as a **cached sum** of live lots, which
is what keeps the change tractable — roughly 45 call sites read that column today, including
`PalaceWalletService.authenticate` and `getBalance`, which run on every third-party provider call.
Deriving the balance on each read instead would have rewritten all of them and put a `SUM` on that
hot path.

The cost of caching is a second place that can drift. Section 7 covers the invariant that guards it.

### Two consequences that are not optional

**Every bonus credit must route through one service.** Four call sites `increment` `bonusBalance`
directly today. If any keeps doing so, the cached column desyncs from the lots the first time it
runs, so all four move to `BonusService.grant()`:

| Source | Location |
|---|---|
| First-deposit bonus | `WalletService.approveDeposit` |
| Cashback | `CashbackService.disburse` |
| Campaign bonus | `CampaignService`, the `CAMPAIGN_BONUS` credit |
| Admin adjustment | `apps/api/src/routes/admin/index.ts` |

This is why `BonusGrant.ruleId` and `BonusGrant.expiresAt` are nullable — these sources get a lot
with no rule and no expiry.

`ReferralService` is deliberately **not** on this list: it credits `realBalance`, not bonus, despite
the name. It needs no change.

**The migration must backfill.** Every existing non-zero `bonusBalance` needs a synthetic
never-expiring lot, or the invariant is violated the moment the migration lands.

---

## 2. Data model

```prisma
enum BonusRuleType    { DAILY_DEPOSIT, WEEKLY_DEPOSIT }
enum BonusRewardType  { FIXED, PERCENTAGE }
enum BonusGrantStatus { ACTIVE, CONSUMED, EXPIRED }
enum SpendAccount     { REAL, BONUS }

model BonusRule {
  id            String          @id @default(uuid())
  name          String
  type          BonusRuleType
  threshold     Decimal         @db.Decimal(12, 2)
  rewardType    BonusRewardType
  rewardValue   Decimal         @db.Decimal(12, 2)
  maxReward     Decimal?        @db.Decimal(12, 2)
  validityHours Int
  startsAt      DateTime
  endsAt        DateTime
  isActive      Boolean         @default(true)
  createdAt     DateTime        @default(now())
  grants        BonusGrant[]

  @@index([isActive, type])
  @@map("bonus_rules")
}

model BonusGrant {
  id          String           @id @default(uuid())
  userId      String
  ruleId      String?
  amount      Decimal          @db.Decimal(12, 2)
  remaining   Decimal          @db.Decimal(12, 2)
  periodStart DateTime
  expiresAt   DateTime?
  status      BonusGrantStatus @default(ACTIVE)
  createdAt   DateTime         @default(now())
  rule        BonusRule?       @relation(fields: [ruleId], references: [id])
  user        User             @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([ruleId, userId, periodStart])
  @@index([userId, status, expiresAt])
  @@index([status, expiresAt])
  @@map("bonus_grants")
}
```

`BonusRule` deliberately mirrors `CashbackPromotion` — same `startsAt`/`endsAt`/`isActive` gating,
same `rewardType`/`rewardValue` pair. The admin screen is a clone of the cashback screen, and
`PromotionsService` already knows this shape.

`validityHours` is the "specified period of time". `remaining` is "how much they can still use".

**Idempotency.** `@@unique([ruleId, userId, periodStart])` is the same guard
`CashbackDisbursement` uses (`@@unique([promotionId, userId, periodStart])`). Deposit approval is
retryable; without this a retry double-grants. The insert catches the unique violation and treats
it as "already granted", not as an error.

Note the constraint is inert for legacy credits, where `ruleId` is `NULL` — Postgres treats `NULL`s
as distinct in a unique index, so cashback and admin lots never collide with each other. That is
the intended behaviour: those sources have their own idempotency and do not want this one.

### Changes to existing models

| Model | Change |
|---|---|
| `Wallet` | `spendAccount SpendAccount @default(REAL)` |
| `PlayerMetrics` | `avgDailyDeposit Decimal? @db.Decimal(12, 2)` |
| `Transaction` | `bonusExpiresAtSpend DateTime?` — see §5 |
| `TransactionType` | `+ DAILY_DEPOSIT_BONUS`, `+ WEEKLY_DEPOSIT_BONUS`, `+ BONUS_EXPIRED` |

---

## 3. Granting

Grants are evaluated **at deposit approval**, inside the transaction that already credits
`realBalance` and awards the first-deposit bonus (`WalletService`, around the `previousApproved === 0`
branch). Not on a nightly batch — the player sees the bonus while they are still looking at the
screen.

For each active rule of each type, where `startsAt <= now <= endsAt`:

1. Compute the period bucket for the deposit's timestamp (§6).
2. Sum that user's `APPROVED` `DEPOSIT` transactions inside the bucket, including the one being
   approved.
3. If the sum is below `threshold`, stop.
4. Compute the reward: `FIXED` → `rewardValue`; `PERCENTAGE` → `bucketSum * rewardValue / 100`,
   clamped to `maxReward` when set. Percentage results round **down** to 2 decimal places, matching
   the `ROUND_DOWN` convention the prediction matching code already uses for money splits. The
   percentage applies to the bucket total, not to the single deposit that crossed the threshold.
5. Insert the lot with `expiresAt = now + validityHours`, increment `Wallet.bonusBalance`, write a
   `DAILY_DEPOSIT_BONUS` / `WEEKLY_DEPOSIT_BONUS` transaction with before/after snapshots on both
   balances. A unique violation here means the grant already exists — swallow it.

Both rule types are evaluated on every deposit, so a single deposit can trigger both a daily and a
weekly grant. They are separate rows with separate windows.

Multiple active rules of the *same* type are also allowed, and each grants independently — the
unique constraint is per rule, not per type. This is intentional: it makes overlapping campaigns
possible without a schema change. It also means an operator who leaves an old daily rule active
while launching a new one pays both, so the admin list surfaces active-rule counts per type.

The `threshold` compares against the **bucket total**, not the individual deposit — three deposits
of 200 in one day satisfy a 500 daily threshold. This is stated explicitly because the alternative
reading (single deposit must clear the threshold) is a plausible one and the two behave very
differently for players who top up in small amounts.

---

## 4. Which account funds play

`Wallet.spendAccount` is a persisted toggle the player flips in the wallet UI. Every spend path
reads it.

It is persisted rather than passed per request because **third-party providers have no channel to
carry a choice**: Palace calls `processBet` with an account and an amount and nothing else. A
per-request parameter would work for bingo and prediction and silently fail to exist for the
provider games.

This replaces three different existing behaviours, which are currently inconsistent with each other:

| Path | Today | After |
|---|---|---|
| Bingo entry (`GameService.joinGame`) | bonus first, then real | selected account only |
| Prediction order reserve | proportional split across both | selected account only |
| Palace / GASea `processBet` | real first, then bonus | selected account only |

**Insufficient funds in the selected account is a rejection**, not a fallback. `BONUS` selected with
40 bonus and a 50 entry fails with `INSUFFICIENT_BONUS_BALANCE`. Silently reaching into real
balance is the behaviour players complain about.

**Provider balance reporting changes with it.** `authenticate` and `getBalance` currently return
`realBalance + bonusBalance`. They must return the selected account's balance alone. Otherwise the
provider lobby advertises a balance the very next `processBet` refuses to spend.

---

## 5. Spending, expiry, refunds

**Spend.** Consume lots `ORDER BY expiresAt ASC NULLS LAST, id ASC` — soonest to die first, and
deterministic when timestamps tie. Decrement each lot's `remaining`, mark it `CONSUMED` at zero,
decrement the cached `bonusBalance` by the total. All of it inside the existing `SELECT FOR UPDATE`
transaction, so no new locking scheme is introduced.

**Negative admin adjustments.** `ADMIN_BONUS_ADJUSTMENT` can reduce a bonus balance, and today it
just decrements the column. Under the lot model a reduction must consume lots in the same
soonest-first order as a spend, or the cached balance falls below the sum of live lots and the
invariant breaks. A reduction larger than the live total clamps at zero rather than going negative,
consistent with the platform rule that a balance never goes below zero.

**Winnings.** Prizes credit `realBalance` unchanged, whether or not the entry was bonus-funded.

> This is a deliberate decision, taken with the exposure understood and stated: it makes bonus
> credit convertible to withdrawable cash after a single play-through. Deposit → qualify → play the
> bonus once → withdraw. There is no wagering requirement and no cashout cap in this design. If
> abuse shows up, the smallest available lever is a per-grant max-cashout, which the lot model can
> carry without restructuring.

**Expiry.** A new `bonus-expiry.worker.ts`, BullMQ repeating every 15 minutes, following the
`cashback-checker` pattern (clear existing repeatables on boot so restarts do not stack duplicates).
It selects lots where `status = ACTIVE AND expiresAt <= now`, groups by user, and per user in one
transaction: locks the wallet `FOR UPDATE`, sums the expiring remainders, decrements
`bonusBalance`, sets the lots `EXPIRED` with `remaining = 0`, writes one `BONUS_EXPIRED` transaction
carrying the before/after snapshot, and pushes a wallet update over the socket.

The `BONUS_EXPIRED` transaction exists so that a balance dropping while the player was asleep has an
audit row explaining it.

**Refunds.** Cancelled-game refunds already reconstruct the real/bonus split from the entry
transaction's `bonusBalanceBefore`/`bonusBalanceAfter` snapshots, specifically so that refunding
bonus-funded play to real balance cannot launder bonus into cash. That logic stands.

What it cannot currently answer is *which lot* the refunded bonus belongs to. Rather than a
consumption join table, the entry transaction records `bonusExpiresAtSpend` — the expiry of the
soonest-dying lot consumed. The refund creates a new lot carrying that same expiry.

The refund lot is written with `ruleId = NULL`. It must be: reusing the original `ruleId` and
`periodStart` would collide with the grant it came from under
`@@unique([ruleId, userId, periodStart])`, and the refund would fail. A refund is a restoration of
already-granted credit, not a new award, so it correctly carries no rule.

**Provider rollbacks have the same hole, and it predates this work.**
`PalaceWalletService.processCancel` credits the reversed stake to `realBalance` unconditionally,
even when the bet was funded from bonus. That converts bonus to withdrawable cash with no play at
all — strictly worse than the play-through exposure accepted above, which at least requires risking
the money. It is low-severity today because only the provider can trigger a cancel, not the player.
The rollback reads the original bet's transaction snapshot and restores each side to the account it
came from, matching the bingo refund rule.

Carrying the original expiry rather than granting a fresh window is the point: a fresh window would
make join-then-cancel a way to extend a bonus indefinitely. The consequence is that a refund
arriving after the original window closed credits an already-expired lot, which the next sweep
collects. That bonus is effectively forfeited. It is a narrow case — it requires a cancellation
landing after expiry — and forfeiting is the safe direction to err in.

---

## 6. Period buckets

The codebase has no timezone configuration; everything runs in UTC. UTC midnight is 03:00 in Addis
Ababa, which would put the daily boundary in the middle of a session.

A `bonus_period_timezone` `SiteSetting` is introduced, defaulting to `Africa/Addis_Ababa`:

- **Day bucket** — local midnight to local midnight.
- **Week bucket** — Monday 00:00 local to Sunday 23:59:59 local.

`periodStart` is stored as the UTC instant corresponding to the local bucket start, so the unique
constraint compares instants and never strings. Ethiopia observes no DST, so the offset is a fixed
+03:00 and bucket arithmetic has no ambiguous or skipped local times to handle. Changing the setting
to a DST-observing zone would introduce that problem; the setting is documented as such.

---

## 7. The invariant

```
wallet.bonusBalance == SUM(bonus_grants.remaining WHERE userId = ? AND status = 'ACTIVE')
```

This must hold after every grant, spend, expiry, refund and admin adjustment. It is enforced three
ways:

1. **One write path.** No code outside `BonusService` writes `bonusBalance` directly. The spend
   paths in `GameService`, the prediction order reserve and `PalaceWalletService` call
   `BonusService.spend(tx, userId, amount)`, passing their own transaction client so the lot updates
   and the balance decrement stay inside the same `FOR UPDATE` transaction they already hold.
   Grep-able and reviewable: a bare `bonusBalance: { increment` or `decrement` outside
   `BonusService` is a bug by definition.
2. **A property test.** A randomized sequence of grant/spend/expire/refund operations, asserting the
   invariant after each step.
3. **An admin reconciliation query** listing any wallet where the two disagree, so drift in
   production is visible rather than silent.

---

## 8. Average daily deposit

Lifetime deposits divided by elapsed days since the first deposit:

```sql
CASE WHEN dep.first_at IS NULL THEN NULL
     ELSE COALESCE(dep.total, 0)
          / GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (NOW() - dep.first_at)) / 86400))
END
```

`NULL` rather than `0` when the player has never deposited, so a segment can distinguish "never
deposited" from "deposits, but very little". `GREATEST(1, …)` stops a same-day first depositor
dividing by zero.

Worked: 6000 deposited, first deposit 300 days ago → 20/day. 3000 deposited, first deposit 8 days
ago → 375/day. The metric is intentionally recency-biased — a newer player depositing hard outranks
an older player who deposited more in total but spread it thin.

It drops into the existing rollup in `PlayerMetricsService.rollupSql`, where `dep.total` and
`dep.first_at` are already selected. No new join.

### The staleness trap

The incremental refresh pass only touches players who did something. This metric's denominator grows
every day whether or not the player acts, so an idle player's stored value freezes and reads
**higher** than the truth until a full rebuild corrects it. This is the same failure the segment
compiler already documents for the stored `daysSince*` integers, which is why it compiles
relative-date questions against timestamp columns instead.

Here the value cannot be recomputed inside a Prisma `where`, so it must be stored. The fix is to
refresh this one column for **all** rows on the incremental pass, as a separate lightweight
`UPDATE` — pure arithmetic over two columns on an already-indexed table, no joins.

### Segmentation

`avgDailyDeposit` is added to the frozen `segmentField` whitelist in
`packages/shared-types/src/crm/segment.ts`. The compiler rejects any field not in that whitelist by
design — it is the CRM's security boundary — so the whitelist entry is required, not incidental.

Presets, in ETB per day:

| Segment | Rule |
|---|---|
| Micro depositor | `avgDailyDeposit < 50` |
| Casual depositor | `50 <= avgDailyDeposit < 200` |
| Core depositor | `200 <= avgDailyDeposit < 1000` |
| Whale | `avgDailyDeposit >= 1000` |

### One correction to the rollup

`bonusReceived` sums transactions of type `FIRST_DEPOSIT_BONUS`, `CASHBACK_BONUS` and
`ADMIN_BONUS_ADJUSTMENT`. The two new grant types must be added to that list. `BONUS_EXPIRED` must
**not** be — it is a debit, and including it would inflate the total it is supposed to reduce.

---

## 9. Surfaces

**Admin**

- `/admin/bonus-rules` — list, create, edit, activate/deactivate. Cloned from the cashback
  promotions screen.
- Player detail gains a grants panel: amount, remaining, expiry, source rule, status.
- Reconciliation widget for the §7 invariant.

**API**

- `GET /promotions` — extended with the active daily and weekly rules, so the app can advertise
  "deposit 500 today, get 50". Returns `null` fields when nothing is active, matching how
  `PromotionsService` already handles cashback and the first-deposit bonus.
- `GET /wallet/bonus-grants` — the player's live lots with time remaining.
- `PATCH /wallet/spend-account` — flip the toggle.

**Web**

- Wallet screen: the REAL/BONUS toggle, and a lots list showing "expires in 2d 4h".
- Deposit screen: progress toward today's and this week's threshold.
- Strings in `en` and `am`.

---

## 10. Testing

**Pure / unit**

- Period bucket boundaries at the fixed +03:00 offset, including a deposit at 23:59 and 00:01 local.
- Reward computation: `FIXED`, `PERCENTAGE`, and `PERCENTAGE` clamped by `maxReward`.
- Lot ordering, including `NULL` expiries sorting last and ties broken by id.

**Service**

- A retried deposit approval grants exactly once.
- A spend spanning three lots decrements each correctly and marks the drained ones `CONSUMED`.
- `BONUS` selected with insufficient bonus rejects, and does not touch `realBalance`.
- The expiry sweep decrements the cached balance by exactly the expired remainder.
- A refund carries the original expiry, not a fresh window, and does not collide with the grant it
  came from.
- A single deposit crossing both thresholds produces two independent lots.
- A negative admin adjustment consumes lots soonest-first and clamps at zero.

**Invariant**

- The property test described in §7.

**Migration**

- Backfill produces one never-expiring lot per wallet with a non-zero balance, matching it exactly.

**Verification note.** Per the standing project note, `pnpm typecheck` is red by default in
`apps/admin` and `pnpm lint` does not check TypeScript. Verification greps the touched files for
their specific errors rather than trusting an exit code.

---

## 11. Out of scope

Named so that "we forgot" and "we decided against" stay distinguishable:

- **Wagering / turnover requirements.** No concept of turnover exists in the codebase. Deliberately
  not introduced.
- **Max cashout per grant.** Considered and declined; the lot model can carry it later without
  restructuring.
- **Per-bet bonus caps** and **per-product restrictions** (bingo-only bonuses).
- **Tiered or repeating weekly grants.** The weekly rule is a single threshold paying once per week.
- **Bonus on withdrawal reversal.** Deposits that are later reversed do not claw back a granted
  bonus.
