# Player CRM — as-built design

**Status:** Phases 1–3 implemented and unit-tested. Not deployed. Admin UI written but never rendered in a browser.
**Date:** 2026-08-12

A marketing tool for the bingo platform: group players by behaviour ("deposited but never played",
"churned high rollers"), then act on the group — export it to CSV, send an in-app message, or grant
bonus credit. Built as a rollup table plus a JSON rule compiler plus a campaign queue, delivered in
three phases so the money-touching part ships last, behind the most scrutiny.

This document describes **what exists in the code**, not what was originally proposed. Where the
original design was changed during implementation, the reason is stated inline — those reasons are
usually the most useful part.

---

## 1. Data model

Five new tables. Nothing existing was altered.

### `PlayerMetrics` — one row per player

The table every segment query reads. Rebuilt from source rows; never incremented.

| Group | Fields |
|---|---|
| Deposits | `lifetimeDeposits`, `depositCount`, `firstDepositAt`, `lastDepositAt` |
| Withdrawals | `lifetimeWithdrawals`, `withdrawalCount`, `lastWithdrawalAt` |
| Bingo | `gamesPlayed`, `cartelasBought`, `firstPlayedAt`, `lastPlayedAt`, `totalStaked`, `totalWon` |
| Casino | `tpStaked`, `tpWon`, `lastTpPlayedAt` |
| Derived | `netLoss`, `bonusReceived`, `referralCount`, `daysSinceLastDeposit`, `daysSinceLastPlay`, `tenureDays` |
| Denormalized | `realBalance`, `bonusBalance`, `isActive`, `registeredAt`, `serial`, `username`, `phone`, `telegramId` |

Decisions that matter:

- **Deposits and withdrawals count only at `PaymentStatus.APPROVED`.** Receipts sitting in
  `PENDING_REVIEW` must never inflate a VIP segment.
- **`netLoss` spans bingo *and* casino.** A player who loses at bingo and wins it back on Palace is
  not a "big loser" and must not land in a loss-based segment.
- **`daysSince*` is NULL, not 0, for "never".** "Never deposited" and "deposited today" must not
  collide in a churn segment.
- **`serial` and `username` are denormalized.** Without them, every preview joins `users`, which is
  the cost this table exists to avoid.
- **Bots and staff are excluded at the source**, not filtered per query, so a future query cannot
  forget to. Both bot markers are checked — `bot.service.ts` sets `passwordHash = 'BOT_ACCOUNT'`
  (:104) but matches on the `bot_t` username prefix elsewhere (:184, :289), so either alone misses
  bots created by the other path.

### `Segment`

`name`, `description`, `rules` (JSON AST), `isPreset`, `cachedCount`, `countedAt`, `createdById`.

Presets are **rows, not code**, so a marketer can clone one and change a threshold without a deploy.
Editing rules clears the cached count — a stale number beside new rules is how someone launches at
the wrong audience.

### `Campaign`

Lifecycle: `DRAFT → PENDING_APPROVAL → APPROVED → RUNNING → COMPLETED | FAILED | CANCELLED`.

- **`rootId`** — lineage identity that survives cloning. Delivery uniqueness keys on this, not `id`,
  so cloning a stopped campaign cannot re-pay anyone the original already paid.
- **`segmentRulesSnapshot` + `asOf`** — the rules *as approved*, and the instant they were evaluated
  against. The drain compiles from these, never the live `Segment`. Otherwise editing the segment
  after approval silently retargets a running campaign, and `maxRecipients` caps only *how many*,
  never *which*.
- **`approvalHash`** — sha256 over `{rules, actions, caps}`, re-verified under the campaign row lock
  before any money moves.
- **Caps are `NOT NULL`.** A nullable `maxRecipients` becomes `LIMIT NULL` in Postgres, which means
  *no limit* — the cap would silently delete itself.
- **`createdByUsername` / `approvedByUsername`** are captured at write time, because clerk deletion
  hard-deletes the user row and would otherwise turn every actor id into an unresolvable UUID exactly
  when someone is auditing who authorised a payment.

### `CampaignDelivery`

One row per player per campaign. `@@unique([rootId, userId])` **is** the idempotency guarantee.
Rows are materialised at launch and only ever updated, so every recipient reaches a terminal state
(`SENT` / `SKIPPED` + reason / `FAILED` + error) and a stuck `QUEUED` row is the alarm for a lost job.
`user` is `onDelete: Restrict` — deleting a player must not erase the record of money paid to them.

### `AuditLog`

Append-only. The platform had no audit trail at all. Approvals, launches, stops and CSV exports write
rows; the export writes *before* the stream opens, so a killed request still leaves a trace.

---

## 2. Metrics refresh

`PlayerMetricsService` + `player-metrics.worker.ts` on the `PLAYER_METRICS` queue.

- **Incremental every 5 minutes** — players touched since a watermark in `SiteSetting`
  (`crm.metrics.lastRefreshAt`).
- **Full rebuild nightly** — self-heals any drift.
- **One `INSERT … SELECT … ON CONFLICT DO UPDATE`**, not six `groupBy` queries merged in Node. At
  100k players the merge approach ships every aggregate row over the wire to be joined in JS.

**The invariant:** every value is an *absolute recompute*. A retry, or two overlapping runs, converge
on the same answer. There is no compensating logic anywhere in the file. The watermark advances only
on success, so a failed pass simply re-does its window.

### Two bugs found here, both silent

**Timezone.** The timestamp columns are `timestamp` *without* time zone holding UTC, but Prisma binds
a JS `Date` as `timestamptz`. Postgres reconciles the two using the **session timezone** — on a +03
host every comparison returned false and `findStaleUserIds` found nothing, forever. Incremental
refresh would have been quietly dead, with metrics only updating nightly and no error anywhere.
Fixed by passing the instant as an ISO string cast to `timestamp`, and by using
`(NOW() AT TIME ZONE 'UTC')::date` for day arithmetic.

**Freeze invisibility.** `scripts/freeze_flagged.sql` freezes fraud accounts with a raw
`UPDATE users SET "isActive" = false`. Prisma's `@updatedAt` does not fire on raw SQL, so a freeze
bumps no timestamp and the watermark never sees it — a frozen account would keep `isActive: true` in
the rollup and stay targetable until the nightly rebuild. `syncLiveness()` therefore runs on **every**
tick regardless of candidates, and delivery re-checks liveness against `users` live.

---

## 3. Segment rule engine

Contract in `packages/shared-types/src/crm/segment.ts`; compiler in
`apps/api/src/services/player-crm/segment-compiler.ts` (pure — no I/O, no clock read unless injected).

**The security property:** no user-supplied string ever becomes a SQL identifier or an operator.
Field keys are looked up in a frozen whitelist and mapped to column names the compiler owns; anything
unrecognised throws. Values stay values, parameterised by Prisma.

- **Discriminated union on `kind`, plus a tree-walk for semantics.** A plain `z.union` collapses every
  branch failure into `"Invalid input"`, leaving the builder unable to say which row is wrong. Errors
  now read `root.children.0.op: Operator "before" is not valid for field "lifetimeDeposits"`.
- **Schemas are `.strict()`.** Zod strips unknown keys by default, so an unsupported key would be
  silently dropped — a rule set carrying `not: true` would compile to its own opposite.
- **Depth bounded by construction** (a finite chain, not `z.lazy`), so a too-deep tree is a precise
  parse error rather than an exception from inside the compiler.

### Deliberate restrictions

| Restriction | Why |
|---|---|
| Recency compiles against the **timestamp**, never the stored `daysSince*` integer | Those integers only move when a row is refreshed, and the incremental pass only refreshes *active* players. A churned player's counter freezes on the day they stop — the one cohort a churn segment exists to find. Costs nothing: both columns are indexed. |
| Money fields have **no `eq`/`neq`** | Balances are `Decimal(20,8)`. `realBalance eq 0` silently misses a wallet holding `0.00000001` of settlement dust. Use `lt 1`. |
| **No group-level `not`** | Prisma emits `NOT (…)`; a row with a NULL in a referenced column evaluates NULL and is dropped. "Churned AND NOT recent depositor" would exclude every never-depositor while the summary read like set complement. |
| **No nested groups in the builder UI** | The AST supports them; mixing AND and OR on one screen is where builders of this kind become unusable. One group, one connector. |

### The eight presets

New players · Active players · At risk (8–30 days) · Churned depositors (>30 days) · VIP / high
rollers (≥5,000 ETB) · Deposited but never played · Heavy losers (≥1,000 ETB net) · Referrers.

Thresholds are scaled to this platform — tickets are 10–100 ETB, so 5,000 ETB lifetime is a genuine
high roller. Seeded only when absent and **never overwritten**, so an operator who retunes a threshold
does not have it reverted by the next deploy.

---

## 4. Campaign engine

`CampaignService` + `crm-campaign.worker.ts` on the `CRM_CAMPAIGN` queue. One job per campaign that
drains batches of 500, rather than one job per recipient — 40k recipients would otherwise be 40k Redis
jobs, and per-job retry semantics would fight the delivery row's own idempotency.

**Claim-then-process:** a row moves `QUEUED` → terminal inside the same transaction that does its
work, so a crashed worker leaves it `QUEUED` and the next pass retries it. Status is re-checked each
batch, so a stop takes effect within one batch.

---

## 5. Money guardrails (Phase 3)

Every one of these is covered by a test, and the cap tests were mutation-verified — with enforcement
disabled, 4 players were paid instead of 3 (120 ETB against a 100 ETB cap).

| Control | Enforcement |
|---|---|
| Four-eyes | Approver ∉ {`createdById`, `lastEditedById`}. Checking only the author lets someone edit a colleague's draft and approve their own work. |
| Role gate | Money campaigns require `SUPER_ADMIN` — meaningful only because an `ADMIN` can no longer mint another admin. |
| Approval note | Mandatory for money campaigns; stored on the row. |
| Payload integrity | `approvalHash` re-verified under the row lock; a mismatch fails the campaign with **zero** paid. |
| Per-player / total / recipient caps | Evaluated by a pure `evaluateCaps()` **inside** the transaction holding the campaign row lock, against values read under that lock. A cap checked only at launch is not a cap. |
| Counter accuracy | `grantedTotal` increments in the **same transaction** as the money, so it can never lag what was actually paid. |
| Exclusions | Liveness, role and both bot markers re-checked live at delivery, not from the rollup. |
| Kill switch | `stop()` transitions the campaign and marks every remaining `QUEUED` row `SKIPPED`, so nothing is left in limbo. |

Bonus credit lands in `bonusBalance` only; `realBalance` is never touched by a grant. Each grant
writes a `CAMPAIGN_BONUS` transaction with full before/after on both buckets, linked to the campaign.

---

## 6. Admin UI

| Route | Purpose |
|---|---|
| `/crm` | Segment list, counts, metrics-staleness banner, CSV export |
| `/crm/new`, `/crm/[id]` | Builder (row-based, no JSON), drill-down, live debounced count |
| `/campaigns` | Campaign list with delivery counts and granted total |
| `/campaigns/new` | Create draft; live worst-case exposure |
| `/campaigns/[id]` | Submit → approve → launch → stop; live progress; audit panel |

The money figure is shown as **worst case bounded by whichever cap actually binds** — not "50 ETB per
player" but "up to 250,000 ETB will leave the business if this runs to completion", with the binding
cap named. It is restated in the approval dialog at the moment of commitment.

Metrics staleness is a first-class element, not a footnote: someone about to act on "412 churned
players" needs to know whether that number is four minutes or four days old.

---

## 7. Testing

92 tests across 7 suites. The compiler and `evaluateCaps` are pure and exhaustively tested without a
database, which matters because the DB-backed suites here are historically unreliable.

Two practices worth keeping:

- **Mutation testing on anything that moves money.** A test that has only ever run against correct
  code proves nothing. Each guardrail was verified by reintroducing the bug and confirming the tests
  fail with the *right* signature — `600 ≠ 500` for a double refund, `expected 200 to be 401` for an
  open dashboard.
- **`cleanDb()` must know about every table.** Three tests passed alone and failed together because
  CRM rows leaked between files. Worse, `CampaignDelivery` is `onDelete: Restrict`, so one leftover
  row makes `users.deleteMany()` throw and cascades failures through every later suite.

---

## 8. Phasing and deployment

- **Phase 1** — metrics, segments, CSV. Usable alone.
- **Phase 2** — in-app message campaigns.
- **Phase 3** — bonus grants, behind every guardrail in §5.

Deploy with `prisma migrate deploy` (migration `20260812000000_add_player_crm`, 181 lines, purely
additive: 5 tables, 2 enum values, no `DROP`, no changes to existing columns). Staging first.

Note for this environment: `prisma generate` and `db push` hang unless the engine binaries are pinned —
see the `pnpm-install-hangs-use-offline` memory.

---

## 9. Open items

1. **Phase 3 prerequisite, not yet met.** Bonus credit is only meaningfully "not cash" if it cannot be
   converted. The tournament path was closed during this work, but **provider rollbacks still credit
   real balance regardless of which bucket the bet drew from** (`palace-wallet.service.ts`,
   `third-party-wallet.service.ts`). Until that is fixed, size `maxTotalBonus` as if handing out cash.
2. **`/admin/players/:id/adjust-balance`** is clerk-accessible, unbounded, and writes no
   `reviewedById` — the largest unconstrained money-out route on the platform, and a trust-model
   decision rather than an unambiguous bug.
3. **No CRM screen has been rendered in a browser.** Docker was unavailable, so there was no Redis and
   the API could not boot.
4. **`LINK_CASHBACK_PROMOTION` was cut.** `CashbackPromotion` has no targeting — `checkAndDisburse`
   groups over all users. Adding `segmentId` means changing a live money path, which did not belong in
   the same change as everything else.
5. **Campaign scheduling** (send at a future time) is not implemented; launch is manual.
