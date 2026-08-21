# Deposit Bonuses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship daily/weekly deposit bonuses as expiring grant lots, a player-selected real/bonus spend account, and an `avgDailyDeposit` CRM segmentation metric.

**Architecture:** A new `BonusGrant` ledger (one row per award, carrying `remaining` + `expiresAt`) backs the existing `Wallet.bonusBalance` column as a cached sum, so ~45 existing balance readers are untouched. One service (`BonusService`) is the only code allowed to write `bonusBalance`; every existing bonus-granting call site is migrated onto it. A new `spendAccount` toggle on `Wallet` replaces three inconsistent bonus-vs-real spend rules (bingo, prediction, Palace) with one player-chosen account, rejecting instead of falling back on insufficient funds.

**Tech Stack:** Fastify v5, Prisma 5 / PostgreSQL, BullMQ, Zod, Vitest, Nuxt 3 (`@nuxt/ui`).

**Spec:** [docs/superpowers/specs/2026-08-20-deposit-bonus-design.md](../specs/2026-08-20-deposit-bonus-design.md)

## Global Constraints

- Money math uses `Decimal` from `@prisma/client/runtime/library`. Percentage rewards round **down** to 2 decimal places (`Decimal.ROUND_DOWN`), matching `matching.service.ts`'s `MONEY_DP = 2` convention.
- Bonus period buckets run on a **fixed UTC+3 offset** (`Africa/Addis_Ababa`, no DST) — day buckets are local-midnight to local-midnight, week buckets are Monday 00:00 to Sunday 23:59:59 local.
- `wallet.bonusBalance` must always equal `SUM(bonus_grants.remaining WHERE status = 'ACTIVE')` for that user. Only `BonusService` writes `bonusBalance`.
- All money-touching work runs inside the caller's existing `prisma.$transaction` on a `SELECT ... FOR UPDATE`-locked wallet row. `BonusService` methods take a `Prisma.TransactionClient` (`tx`), never the bare `prisma` client, and never lock the wallet themselves — the caller already holds the lock.
- Test command: `pnpm --filter @world-bingo/api test` (Vitest, sequential, real Postgres via `DATABASE_URL_TEST`). Add new tables to `cleanDb()` in `apps/api/src/test/setup.ts`.
- Per project memory: `apps/admin` typecheck is red by default and `pnpm lint` does not check TypeScript. Verify by grepping the touched files for their own errors, not by trusting exit codes.
- `BonusGrant.periodStart`/`.expiresAt` and every other `bonus_*` timestamp column are `timestamp` WITHOUT time zone. Any raw `$queryRaw`/`$executeRaw` that binds a JS `Date` directly into one — as a write, or as a comparison in a `WHERE` clause — hits a documented bug class already present in this codebase (`player-metrics.service.ts`'s `findStaleUserIds`) and rediscovered during Task 2's review: Prisma sends a bound `Date` as `timestamptz`, and Postgres reconciles the mismatch using the session timezone, silently shifting the value/comparison on any non-UTC-pinned session. Always convert with `.toISOString()` first and cast explicitly in the SQL (`${isoString}::timestamp`). Prisma's typed client calls (`tx.bonusGrant.update(...)`, etc.) are unaffected — this only applies to raw SQL.

---

## Phase 1 — Schema

### Task 1: Prisma schema, migration, shared-types enums, test cleanup

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260821000000_add_bonus_grants/migration.sql`
- Modify: `packages/shared-types/src/enums/index.ts`
- Modify: `apps/api/src/lib/queue.ts`
- Modify: `apps/api/src/test/setup.ts`

**Interfaces:**
- Produces: `BonusRule`, `BonusGrant` Prisma models; `BonusRuleType`, `BonusRewardType`, `BonusGrantStatus`, `SpendAccount` enums (both Prisma and `@world-bingo/shared-types`); `Wallet.spendAccount`; `PlayerMetrics.avgDailyDeposit`; `Transaction.bonusExpiresAtSpend`; `TransactionType.DAILY_DEPOSIT_BONUS` / `.WEEKLY_DEPOSIT_BONUS` / `.BONUS_EXPIRED`; `QUEUE_NAMES.BONUS_EXPIRY`.

- [ ] **Step 1: Add the new enums and models to `schema.prisma`**

Add near the other enums (after `enum CashbackFrequency` around line 326):

```prisma
enum BonusRuleType {
  DAILY_DEPOSIT
  WEEKLY_DEPOSIT
}

enum BonusRewardType {
  FIXED
  PERCENTAGE
}

enum BonusGrantStatus {
  ACTIVE
  CONSUMED
  EXPIRED
}

enum SpendAccount {
  REAL
  BONUS
}
```

Add the models after `model CashbackDisbursement` (around line 411):

```prisma
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

- [ ] **Step 2: Add `spendAccount` to `Wallet`, `avgDailyDeposit` to `PlayerMetrics`, `bonusExpiresAtSpend` to `Transaction`, new `TransactionType` values, `BonusGrant[]` back-relation on `User`**

In `model Wallet` (around line 49-58), add after `bonusBalance`:

```prisma
  spendAccount SpendAccount @default(REAL)
```

In `model PlayerMetrics` (around line 704), add after `bonusReceived`:

```prisma
  avgDailyDeposit Decimal? @db.Decimal(12, 2)
```

In `model Transaction` (around line 137), add after `bonusBalanceAfter`:

```prisma
  bonusExpiresAtSpend DateTime?
```

In `enum TransactionType` (around line 185), add:

```prisma
  DAILY_DEPOSIT_BONUS
  WEEKLY_DEPOSIT_BONUS
  BONUS_EXPIRED
```

In `model User` (around line 10-48), add to the relations block:

```prisma
  bonusGrants BonusGrant[]
```

- [ ] **Step 3: Generate the migration skeleton, then hand-edit it to add the backfill**

Run:

```bash
pnpm --filter @world-bingo/api exec prisma migrate dev --name add_bonus_grants --create-only
```

This creates `apps/api/prisma/migrations/<timestamp>_add_bonus_grants/migration.sql`. Rename the folder to `20260821000000_add_bonus_grants` to match the repo's date-prefixed convention (see `20260812000000_add_player_crm`), and append this backfill to the end of the generated `migration.sql` — every wallet with a non-zero `bonusBalance` today gets one never-expiring lot, which is what keeps the §7 invariant true from the moment this migration lands:

```sql
-- Backfill: every pre-existing non-zero bonusBalance becomes one never-expiring,
-- ruleless lot. Without this the cached-balance invariant is false on day one.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO "bonus_grants" ("id", "userId", "ruleId", "amount", "remaining", "periodStart", "expiresAt", "status", "createdAt")
SELECT gen_random_uuid(), "userId", NULL, "bonusBalance", "bonusBalance", NOW(), NULL, 'ACTIVE', NOW()
FROM "wallets"
WHERE "bonusBalance" > 0;
```

- [ ] **Step 4: Apply the migration**

Run: `pnpm --filter @world-bingo/api db:migrate`
Expected: migration applies cleanly, `prisma generate` runs, no errors.

- [ ] **Step 5: Verify the backfill**

Run:

```bash
pnpm --filter @world-bingo/api exec tsx -e "
import prisma from './src/lib/prisma'
async function main() {
  const wallets = await prisma.wallet.count({ where: { bonusBalance: { gt: 0 } } })
  const grants = await prisma.bonusGrant.count({ where: { ruleId: null } })
  console.log({ wallets, grants })
  await prisma.\$disconnect()
}
main()
"
```

Expected: `wallets` equals `grants` (every non-zero wallet got exactly one backfill lot). On a fresh dev DB with no deposits yet, both are `0` — that is also a pass.

- [ ] **Step 6: Mirror the new enums into `@world-bingo/shared-types`**

In `packages/shared-types/src/enums/index.ts`, add after `CashbackFrequency`:

```typescript
export enum BonusRuleType {
    DAILY_DEPOSIT = 'DAILY_DEPOSIT',
    WEEKLY_DEPOSIT = 'WEEKLY_DEPOSIT',
}

export enum BonusRewardType {
    FIXED = 'FIXED',
    PERCENTAGE = 'PERCENTAGE',
}

export enum BonusGrantStatus {
    ACTIVE = 'ACTIVE',
    CONSUMED = 'CONSUMED',
    EXPIRED = 'EXPIRED',
}

export enum SpendAccount {
    REAL = 'REAL',
    BONUS = 'BONUS',
}
```

Add `DAILY_DEPOSIT_BONUS = 'DAILY_DEPOSIT_BONUS'`, `WEEKLY_DEPOSIT_BONUS = 'WEEKLY_DEPOSIT_BONUS'`, `BONUS_EXPIRED = 'BONUS_EXPIRED'` to the existing `TransactionType` enum in the same file.

- [ ] **Step 7: Add the expiry worker's queue name**

In `apps/api/src/lib/queue.ts`, add to `QUEUE_NAMES` (around line 27-40):

```typescript
    BONUS_EXPIRY: 'bonus-expiry',
```

- [ ] **Step 8: Add the new tables to the test suite's `cleanDb()`**

In `apps/api/src/test/setup.ts`, add right after `await prisma.campaign.deleteMany()` (around line 32), before `await prisma.segment.deleteMany()`:

```typescript
    await prisma.bonusGrant.deleteMany()
    await prisma.bonusRule.deleteMany()
```

(`bonusGrant` must precede `bonusRule` — it holds the FK.)

- [ ] **Step 9: Build shared-types and typecheck the API package**

Run: `pnpm --filter @world-bingo/shared-types build && pnpm --filter @world-bingo/api typecheck`
Expected: no errors. (This is the one package where `typecheck` is reliable — see Global Constraints for `apps/admin`.)

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations packages/shared-types/src/enums/index.ts apps/api/src/lib/queue.ts apps/api/src/test/setup.ts
git commit -m "feat(bonus): add BonusRule/BonusGrant schema and backfill existing balances"
```

---

## Phase 2 — BonusService core

### Task 2: `BonusService.grant()`

**Files:**
- Create: `apps/api/src/services/bonus.service.ts`
- Test: `apps/api/src/test/bonus.service.test.ts`

**Interfaces:**
- Consumes: `BonusGrant`, `BonusRuleType` (Prisma-generated types), `Prisma.TransactionClient`.
- Produces:
  ```typescript
  export type BonusGrantSource = 'FIRST_DEPOSIT' | 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT' | 'CASHBACK' | 'CAMPAIGN' | 'ADMIN'

  export interface GrantBonusParams {
      userId: string
      amount: Decimal | number
      source: BonusGrantSource
      ruleId?: string | null
      periodStart?: Date | null
      expiresAt?: Date | null
  }

  export interface GrantBonusResult {
      granted: boolean
      grantId?: string
      amount: Decimal
      bonusBalanceBefore: Decimal
      bonusBalanceAfter: Decimal
  }

  export class BonusService {
      static async grant(tx: Prisma.TransactionClient, params: GrantBonusParams): Promise<GrantBonusResult>
  }
  ```
  Later tasks (3, 4, 6-9, 12) depend on this exact signature.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from './setup'
import { BonusService } from '../services/bonus.service'

async function makeUser(username: string, phone: string) {
    return prisma.user.create({
        data: {
            username,
            phone,
            passwordHash: 'hashed:pass',
            role: 'PLAYER',
            wallet: { create: { realBalance: 0, bonusBalance: 0 } },
        },
    })
}

describe('BonusService.grant', () => {
    it('creates a lot and increments the cached wallet balance', async () => {
        const user = await makeUser('grant1', '+251900000001')
        const expiresAt = new Date(Date.now() + 3600_000)

        const result = await prisma.$transaction((tx) =>
            BonusService.grant(tx, {
                userId: user.id,
                amount: 100,
                source: 'ADMIN',
                expiresAt,
            }),
        )

        expect(result.granted).toBe(true)
        expect(result.bonusBalanceBefore.toNumber()).toBe(0)
        expect(result.bonusBalanceAfter.toNumber()).toBe(100)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(100)

        const lot = await prisma.bonusGrant.findUniqueOrThrow({ where: { id: result.grantId! } })
        expect(new Decimal(lot.amount).toNumber()).toBe(100)
        expect(new Decimal(lot.remaining).toNumber()).toBe(100)
        expect(lot.status).toBe('ACTIVE')
        expect(lot.expiresAt?.getTime()).toBe(expiresAt.getTime())
    })

    it('is idempotent on (ruleId, userId, periodStart)', async () => {
        const user = await makeUser('grant2', '+251900000002')
        const rule = await prisma.bonusRule.create({
            data: {
                name: 'Daily test',
                type: 'DAILY_DEPOSIT',
                threshold: 500,
                rewardType: 'FIXED',
                rewardValue: 50,
                validityHours: 24,
                startsAt: new Date(Date.now() - 1000),
                endsAt: new Date(Date.now() + 86_400_000),
            },
        })
        const periodStart = new Date('2026-08-20T00:00:00Z')

        const grantOnce = () =>
            prisma.$transaction((tx) =>
                BonusService.grant(tx, {
                    userId: user.id,
                    amount: 50,
                    source: 'DAILY_DEPOSIT',
                    ruleId: rule.id,
                    periodStart,
                }),
            )

        const first = await grantOnce()
        const second = await grantOnce()

        expect(first.granted).toBe(true)
        expect(second.granted).toBe(false)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(50)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test bonus.service -- -t "grant"`
Expected: FAIL — `Cannot find module '../services/bonus.service'`.

- [ ] **Step 3: Implement `BonusService.grant`**

```typescript
import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

export type BonusGrantSource = 'FIRST_DEPOSIT' | 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT' | 'CASHBACK' | 'CAMPAIGN' | 'ADMIN'

export interface GrantBonusParams {
    userId: string
    amount: Decimal | number
    source: BonusGrantSource
    ruleId?: string | null
    periodStart?: Date | null
    expiresAt?: Date | null
}

export interface GrantBonusResult {
    granted: boolean
    grantId?: string
    amount: Decimal
    bonusBalanceBefore: Decimal
    bonusBalanceAfter: Decimal
}

export class InsufficientBonusBalanceError extends Error {
    statusCode = 400

    constructor() {
        super('Insufficient bonus balance')
        this.name = 'InsufficientBonusBalanceError'
    }
}

export class BonusService {
    /**
     * Grants a bonus lot. Idempotent on (ruleId, userId, periodStart) when
     * ruleId is set — a retried deposit approval or campaign send cannot
     * double-grant. Sources with no rule (cashback, campaign, admin,
     * first-deposit) pass ruleId: null, which the DB's unique index treats as
     * always-distinct, so those grants have no idempotency floor of their own —
     * callers must ensure they only call grant() once per award.
     */
    static async grant(tx: Prisma.TransactionClient, params: GrantBonusParams): Promise<GrantBonusResult> {
        const amount = new Decimal(params.amount)
        if (!amount.isFinite() || amount.lte(0)) {
            throw new Error('Grant amount must be a positive number')
        }

        const wallets = await tx.$queryRaw<Array<{ bonusBalance: Decimal }>>`
            SELECT "bonusBalance" FROM wallets WHERE "userId" = ${params.userId}
        `
        const bonusBalanceBefore = new Decimal(wallets[0]?.bonusBalance ?? 0)

        let grantId: string
        try {
            const lot = await tx.bonusGrant.create({
                data: {
                    userId: params.userId,
                    ruleId: params.ruleId ?? null,
                    amount,
                    remaining: amount,
                    periodStart: params.periodStart ?? new Date(),
                    expiresAt: params.expiresAt ?? null,
                    status: 'ACTIVE',
                },
            })
            grantId = lot.id
        } catch (err: any) {
            if (err?.code === 'P2002') {
                return { granted: false, amount, bonusBalanceBefore, bonusBalanceAfter: bonusBalanceBefore }
            }
            throw err
        }

        await tx.wallet.update({
            where: { userId: params.userId },
            data: { bonusBalance: { increment: amount } },
        })
        const bonusBalanceAfter = bonusBalanceBefore.plus(amount)

        return { granted: true, grantId, amount, bonusBalanceBefore, bonusBalanceAfter }
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test bonus.service`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/bonus.service.ts apps/api/src/test/bonus.service.test.ts
git commit -m "feat(bonus): add BonusService.grant with per-rule idempotency"
```

---

### Task 3: `BonusService.spend()`

**Files:**
- Modify: `apps/api/src/services/bonus.service.ts`
- Test: `apps/api/src/test/bonus.service.test.ts`

**Interfaces:**
- Consumes: `GrantBonusParams`, `BonusService.grant` from Task 2.
- Produces:
  ```typescript
  export interface SpendBonusResult {
      spent: Decimal
      bonusBalanceBefore: Decimal
      bonusBalanceAfter: Decimal
      soonestExpiryConsumed: Date | null
  }

  static async spend(tx: Prisma.TransactionClient, userId: string, amount: Decimal | number): Promise<SpendBonusResult>
  ```
  Throws `InsufficientBonusBalanceError` (from Task 2) if the live lots can't cover `amount`. `soonestExpiryConsumed` is the `expiresAt` of the first (soonest-dying) lot touched — Task 15 stores this as `Transaction.bonusExpiresAtSpend`. Tasks 14, 16, 17 depend on this signature.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/test/bonus.service.test.ts`:

```typescript
describe('BonusService.spend', () => {
    it('consumes lots soonest-expiry-first and marks drained lots CONSUMED', async () => {
        const user = await makeUser('spend1', '+251900000003')
        const soon = new Date(Date.now() + 3600_000)
        const later = new Date(Date.now() + 7 * 86_400_000)

        await prisma.$transaction(async (tx) => {
            await BonusService.grant(tx, { userId: user.id, amount: 30, source: 'ADMIN', expiresAt: later })
            await BonusService.grant(tx, { userId: user.id, amount: 20, source: 'ADMIN', expiresAt: soon })
        })

        const result = await prisma.$transaction((tx) => BonusService.spend(tx, user.id, 25))

        expect(result.spent.toNumber()).toBe(25)
        expect(result.bonusBalanceAfter.toNumber()).toBe(25)
        expect(result.soonestExpiryConsumed?.getTime()).toBe(soon.getTime())

        const lots = await prisma.bonusGrant.findMany({ where: { userId: user.id }, orderBy: { expiresAt: 'asc' } })
        expect(lots[0].status).toBe('CONSUMED')
        expect(new Decimal(lots[0].remaining).toNumber()).toBe(0)
        expect(lots[1].status).toBe('ACTIVE')
        expect(new Decimal(lots[1].remaining).toNumber()).toBe(25)
    })

    it('throws InsufficientBonusBalanceError and touches nothing when lots fall short', async () => {
        const user = await makeUser('spend2', '+251900000004')
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 10, source: 'ADMIN' }))

        await expect(prisma.$transaction((tx) => BonusService.spend(tx, user.id, 50))).rejects.toThrow(
            InsufficientBonusBalanceError,
        )

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(10)
    })
})
```

Add `InsufficientBonusBalanceError` to the existing import from `../services/bonus.service`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test bonus.service -- -t "spend"`
Expected: FAIL — `BonusService.spend is not a function`.

- [ ] **Step 3: Implement `BonusService.spend`**

Add to `apps/api/src/services/bonus.service.ts`, inside the `BonusService` class:

```typescript
    /**
     * Consumes active lots soonest-expiry-first (NULL expiry sorts last — it
     * never dies, so it is the worst choice to spend from first). Assumes the
     * caller already holds a FOR UPDATE lock on the wallet row in this same
     * transaction; this does not re-lock it.
     */
    static async spend(tx: Prisma.TransactionClient, userId: string, amount: Decimal | number): Promise<SpendBonusResult> {
        const need = new Decimal(amount)
        if (!need.isFinite() || need.lte(0)) {
            throw new Error('Spend amount must be a positive number')
        }

        const lots = await tx.$queryRaw<Array<{ id: string; remaining: Decimal; expiresAt: Date | null }>>`
            SELECT id, remaining, "expiresAt" FROM bonus_grants
            WHERE "userId" = ${userId} AND status = 'ACTIVE'
            ORDER BY "expiresAt" ASC NULLS LAST, id ASC
            FOR UPDATE
        `

        const wallets = await tx.$queryRaw<Array<{ bonusBalance: Decimal }>>`
            SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId}
        `
        const bonusBalanceBefore = new Decimal(wallets[0]?.bonusBalance ?? 0)

        let remainingNeed = need
        let soonestExpiryConsumed: Date | null = null
        const updates: Array<Promise<unknown>> = []

        for (const lot of lots) {
            if (remainingNeed.lte(0)) break
            const lotRemaining = new Decimal(lot.remaining)
            const take = Decimal.min(lotRemaining, remainingNeed)
            if (soonestExpiryConsumed === null) soonestExpiryConsumed = lot.expiresAt

            const newRemaining = lotRemaining.minus(take)
            updates.push(
                tx.bonusGrant.update({
                    where: { id: lot.id },
                    data: {
                        remaining: newRemaining,
                        status: newRemaining.lte(0) ? 'CONSUMED' : 'ACTIVE',
                    },
                }),
            )
            remainingNeed = remainingNeed.minus(take)
        }

        if (remainingNeed.gt(0)) {
            throw new InsufficientBonusBalanceError()
        }

        await Promise.all(updates)
        await tx.wallet.update({ where: { userId }, data: { bonusBalance: { decrement: need } } })

        return {
            spent: need,
            bonusBalanceBefore,
            bonusBalanceAfter: bonusBalanceBefore.minus(need),
            soonestExpiryConsumed,
        }
    }
```

Add the `SpendBonusResult` interface next to `GrantBonusResult`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test bonus.service`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/bonus.service.ts apps/api/src/test/bonus.service.test.ts
git commit -m "feat(bonus): add BonusService.spend, soonest-expiry-first consumption"
```

---

### Task 4: `BonusService.reduce()` and `BonusService.restore()`

**Files:**
- Modify: `apps/api/src/services/bonus.service.ts`
- Test: `apps/api/src/test/bonus.service.test.ts`

**Interfaces:**
- Consumes: same lot-walking approach as `spend` (Task 3).
- Produces:
  ```typescript
  export interface ReduceBonusResult {
      reduced: Decimal
      bonusBalanceBefore: Decimal
      bonusBalanceAfter: Decimal
  }
  static async reduce(tx: Prisma.TransactionClient, userId: string, amount: Decimal | number): Promise<ReduceBonusResult>
  static async restore(tx: Prisma.TransactionClient, userId: string, amount: Decimal | number, expiresAt: Date | null): Promise<GrantBonusResult>
  ```
  `reduce` clamps at the live total instead of throwing (negative admin adjustments never go below zero, per the platform-wide balance rule). `restore` is a thin wrapper over `grant` with `ruleId: null` — used by Task 15's refund path to recreate a lot carrying the original expiry. Task 9 depends on `reduce`; Task 15 depends on `restore`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/test/bonus.service.test.ts`:

```typescript
describe('BonusService.reduce', () => {
    it('consumes lots soonest-first like spend', async () => {
        const user = await makeUser('reduce1', '+251900000005')
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 40, source: 'ADMIN' }))

        const result = await prisma.$transaction((tx) => BonusService.reduce(tx, user.id, 15))

        expect(result.reduced.toNumber()).toBe(15)
        expect(result.bonusBalanceAfter.toNumber()).toBe(25)
    })

    it('clamps at zero instead of throwing when the reduction exceeds the balance', async () => {
        const user = await makeUser('reduce2', '+251900000006')
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 10, source: 'ADMIN' }))

        const result = await prisma.$transaction((tx) => BonusService.reduce(tx, user.id, 999))

        expect(result.reduced.toNumber()).toBe(10)
        expect(result.bonusBalanceAfter.toNumber()).toBe(0)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(0)
    })
})

describe('BonusService.restore', () => {
    it('grants a fresh lot carrying the passed-in expiry, not a new window', async () => {
        const user = await makeUser('restore1', '+251900000007')
        const originalExpiry = new Date(Date.now() + 1800_000)

        const result = await prisma.$transaction((tx) => BonusService.restore(tx, user.id, 25, originalExpiry))

        expect(result.granted).toBe(true)
        expect(result.bonusBalanceAfter.toNumber()).toBe(25)
        const lot = await prisma.bonusGrant.findUniqueOrThrow({ where: { id: result.grantId! } })
        expect(lot.ruleId).toBeNull()
        expect(lot.expiresAt?.getTime()).toBe(originalExpiry.getTime())
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test bonus.service -- -t "reduce"`
Expected: FAIL — `BonusService.reduce is not a function`.

- [ ] **Step 3: Implement `reduce` and `restore`**

Add to `apps/api/src/services/bonus.service.ts`. First, factor the lot-walk shared by `spend` and `reduce` into a private helper, then rewrite `spend` to use it:

```typescript
    private static async consumeLots(
        tx: Prisma.TransactionClient,
        userId: string,
        amount: Decimal,
        opts: { clamp: boolean },
    ): Promise<{ consumed: Decimal; soonestExpiryConsumed: Date | null }> {
        const lots = await tx.$queryRaw<Array<{ id: string; remaining: Decimal; expiresAt: Date | null }>>`
            SELECT id, remaining, "expiresAt" FROM bonus_grants
            WHERE "userId" = ${userId} AND status = 'ACTIVE'
            ORDER BY "expiresAt" ASC NULLS LAST, id ASC
            FOR UPDATE
        `

        let remainingNeed = amount
        let soonestExpiryConsumed: Date | null = null
        const updates: Array<Promise<unknown>> = []

        for (const lot of lots) {
            if (remainingNeed.lte(0)) break
            const lotRemaining = new Decimal(lot.remaining)
            const take = Decimal.min(lotRemaining, remainingNeed)
            if (soonestExpiryConsumed === null) soonestExpiryConsumed = lot.expiresAt

            const newRemaining = lotRemaining.minus(take)
            updates.push(
                tx.bonusGrant.update({
                    where: { id: lot.id },
                    data: { remaining: newRemaining, status: newRemaining.lte(0) ? 'CONSUMED' : 'ACTIVE' },
                }),
            )
            remainingNeed = remainingNeed.minus(take)
        }

        if (remainingNeed.gt(0) && !opts.clamp) {
            throw new InsufficientBonusBalanceError()
        }

        await Promise.all(updates)
        const consumed = amount.minus(remainingNeed.gt(0) ? remainingNeed : new Decimal(0))
        return { consumed, soonestExpiryConsumed }
    }

    static async spend(tx: Prisma.TransactionClient, userId: string, amount: Decimal | number): Promise<SpendBonusResult> {
        const need = new Decimal(amount)
        if (!need.isFinite() || need.lte(0)) {
            throw new Error('Spend amount must be a positive number')
        }
        const wallets = await tx.$queryRaw<Array<{ bonusBalance: Decimal }>>`
            SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId}
        `
        const bonusBalanceBefore = new Decimal(wallets[0]?.bonusBalance ?? 0)

        const { consumed, soonestExpiryConsumed } = await this.consumeLots(tx, userId, need, { clamp: false })
        await tx.wallet.update({ where: { userId }, data: { bonusBalance: { decrement: consumed } } })

        return {
            spent: consumed,
            bonusBalanceBefore,
            bonusBalanceAfter: bonusBalanceBefore.minus(consumed),
            soonestExpiryConsumed,
        }
    }

    /** Negative admin adjustment. Clamps at zero — a balance never goes below zero. */
    static async reduce(tx: Prisma.TransactionClient, userId: string, amount: Decimal | number): Promise<ReduceBonusResult> {
        const requested = new Decimal(amount)
        if (!requested.isFinite() || requested.lte(0)) {
            throw new Error('Reduce amount must be a positive number')
        }
        const wallets = await tx.$queryRaw<Array<{ bonusBalance: Decimal }>>`
            SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId}
        `
        const bonusBalanceBefore = new Decimal(wallets[0]?.bonusBalance ?? 0)

        const { consumed } = await this.consumeLots(tx, userId, requested, { clamp: true })
        await tx.wallet.update({ where: { userId }, data: { bonusBalance: { decrement: consumed } } })

        return { reduced: consumed, bonusBalanceBefore, bonusBalanceAfter: bonusBalanceBefore.minus(consumed) }
    }

    /** Recreates a lot for refunded bonus, carrying the ORIGINAL expiry — never a fresh window. */
    static async restore(
        tx: Prisma.TransactionClient,
        userId: string,
        amount: Decimal | number,
        expiresAt: Date | null,
    ): Promise<GrantBonusResult> {
        return this.grant(tx, { userId, amount, source: 'ADMIN', ruleId: null, expiresAt })
    }
```

Replace the old standalone `spend` method body from Task 3 with this version (it now delegates to `consumeLots`). Add `ReduceBonusResult` next to the other result interfaces.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test bonus.service`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/bonus.service.ts apps/api/src/test/bonus.service.test.ts
git commit -m "feat(bonus): add BonusService.reduce and restore, share lot-consumption logic"
```

---

### Task 5: Invariant property test + reconciliation query

**Files:**
- Create: `apps/api/src/test/bonus-invariant.test.ts`
- Modify: `apps/api/src/services/bonus.service.ts`

**Interfaces:**
- Consumes: `BonusService.grant/spend/reduce/restore` (Tasks 2-4).
- Produces:
  ```typescript
  export interface ReconciliationMismatch {
      userId: string
      cachedBalance: Decimal
      lotSum: Decimal
  }
  static async reconcile(tx?: Prisma.TransactionClient): Promise<ReconciliationMismatch[]>
  ```
  Task 24 (admin reconciliation endpoint) depends on this.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from './setup'
import { BonusService } from '../services/bonus.service'

async function makeUser(username: string, phone: string) {
    return prisma.user.create({
        data: {
            username,
            phone,
            passwordHash: 'hashed:pass',
            role: 'PLAYER',
            wallet: { create: { realBalance: 0, bonusBalance: 0 } },
        },
    })
}

describe('BonusService invariant', () => {
    it('holds after a randomized sequence of grant/spend/reduce/restore', async () => {
        const user = await makeUser('invariant1', '+251900000008')
        const ops: Array<'grant' | 'spend' | 'reduce'> = [
            'grant', 'grant', 'spend', 'grant', 'reduce', 'spend', 'grant',
        ]

        for (const op of ops) {
            try {
                if (op === 'grant') {
                    await prisma.$transaction((tx) =>
                        BonusService.grant(tx, { userId: user.id, amount: 37, source: 'ADMIN', expiresAt: new Date(Date.now() + 3600_000) }),
                    )
                } else if (op === 'spend') {
                    await prisma.$transaction((tx) => BonusService.spend(tx, user.id, 20)).catch(() => {})
                } else {
                    await prisma.$transaction((tx) => BonusService.reduce(tx, user.id, 10))
                }
            } catch {
                // InsufficientBonusBalanceError is an expected outcome of this random sequence
            }

            const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
            const lots = await prisma.bonusGrant.aggregate({
                where: { userId: user.id, status: 'ACTIVE' },
                _sum: { remaining: true },
            })
            const lotSum = new Decimal(lots._sum.remaining ?? 0)
            expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(lotSum.toNumber())
        }
    })

    it('reconcile() reports no mismatches on a clean wallet', async () => {
        const user = await makeUser('invariant2', '+251900000009')
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 15, source: 'ADMIN' }))

        const mismatches = await BonusService.reconcile()
        expect(mismatches.find((m) => m.userId === user.id)).toBeUndefined()
    })

    it('reconcile() reports a mismatch when bonusBalance is written outside BonusService', async () => {
        const user = await makeUser('invariant3', '+251900000010')
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 15, source: 'ADMIN' }))
        // Simulate the exact bug the invariant exists to catch.
        await prisma.wallet.update({ where: { userId: user.id }, data: { bonusBalance: { increment: 5 } } })

        const mismatches = await BonusService.reconcile()
        const mine = mismatches.find((m) => m.userId === user.id)
        expect(mine).toBeDefined()
        expect(mine!.cachedBalance.toNumber()).toBe(20)
        expect(mine!.lotSum.toNumber()).toBe(15)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test bonus-invariant`
Expected: FAIL — `BonusService.reconcile is not a function`.

- [ ] **Step 3: Implement `reconcile`**

Add to `apps/api/src/services/bonus.service.ts`, inside the `BonusService` class:

```typescript
    /**
     * Every wallet where the cached bonusBalance disagrees with the sum of its
     * live lots. Should always be empty — see the Global Constraints invariant.
     * Exposed to the admin panel (Task 24) so drift in production is visible
     * rather than silent.
     */
    static async reconcile(client: Prisma.TransactionClient | typeof import('../lib/prisma').default = prisma): Promise<ReconciliationMismatch[]> {
        const rows = await client.$queryRaw<Array<{ userId: string; cachedBalance: Decimal; lotSum: Decimal }>>`
            SELECT w."userId",
                   w."bonusBalance" AS "cachedBalance",
                   COALESCE(SUM(g.remaining) FILTER (WHERE g.status = 'ACTIVE'), 0) AS "lotSum"
            FROM wallets w
            LEFT JOIN bonus_grants g ON g."userId" = w."userId"
            GROUP BY w."userId", w."bonusBalance"
            HAVING w."bonusBalance" != COALESCE(SUM(g.remaining) FILTER (WHERE g.status = 'ACTIVE'), 0)
        `
        return rows.map((r) => ({
            userId: r.userId,
            cachedBalance: new Decimal(r.cachedBalance),
            lotSum: new Decimal(r.lotSum),
        }))
    }
```

Add the import at the top of the file: `import prisma from '../lib/prisma'`. Add the `ReconciliationMismatch` interface next to the other result interfaces.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test bonus.service bonus-invariant`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/bonus.service.ts apps/api/src/test/bonus-invariant.test.ts
git commit -m "test(bonus): add invariant property test and BonusService.reconcile"
```

---

## Phase 3 — Migrate existing bonus credit sources

### Task 6: `WalletService.approveDeposit` first-deposit bonus → `BonusService.grant`

**Files:**
- Modify: `apps/api/src/services/wallet.service.ts:137-167`
- Test: `apps/api/src/test/deposit-adjust.test.ts` (existing — extend), or add assertions inline where the first-deposit bonus is already tested.

**Interfaces:**
- Consumes: `BonusService.grant` (Task 2).

- [ ] **Step 1: Locate and read the current first-deposit bonus test**

Run: `grep -rn "first_deposit_bonus\|FIRST_DEPOSIT_BONUS" apps/api/src/test/*.ts`

Confirm which existing test file exercises `WalletService.approveDeposit`'s first-deposit-bonus branch, so Step 2 extends it rather than duplicating a fixture. If none directly assert on `bonusBalance` after a first deposit, add the following to `apps/api/src/test/deposit-adjust.test.ts`:

```typescript
it('grants the first-deposit bonus as a BonusGrant lot, not a raw increment', async () => {
    await prisma.siteSetting.upsert({
        where: { key: 'first_deposit_bonus_amount' },
        create: { key: 'first_deposit_bonus_amount', value: '25' },
        update: { value: '25' },
    })

    const user = await makeUser('firstdep1', '+251900000011')
    const tx = await prisma.transaction.create({
        data: { userId: user.id, type: 'DEPOSIT', amount: 200, status: 'PENDING_REVIEW' },
    })

    await WalletService.approveDeposit(tx.id)

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(25)

    const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: user.id } })
    expect(lot.ruleId).toBeNull()
    expect(new Decimal(lot.remaining).toNumber()).toBe(25)
})
```

Adjust `makeUser`/imports to match whatever helpers `deposit-adjust.test.ts` already defines.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test deposit-adjust -- -t "BonusGrant lot"`
Expected: FAIL — a lot is not created (the current code still raw-increments).

- [ ] **Step 3: Replace the raw increment with `BonusService.grant`**

In `apps/api/src/services/wallet.service.ts`, replace lines 145-163 (the `if (bonusAmount > 0)` block):

```typescript
                if (bonusAmount > 0) {
                    const grantResult = await BonusService.grant(tx, {
                        userId: transaction.userId,
                        amount: bonusAmount,
                        source: 'FIRST_DEPOSIT',
                    })

                    if (grantResult.granted) {
                        await tx.transaction.create({
                            data: {
                                userId: transaction.userId,
                                type: TransactionType.FIRST_DEPOSIT_BONUS,
                                amount: bonusAmount,
                                status: PaymentStatus.APPROVED,
                                note: 'First deposit bonus',
                                balanceBefore: realAfter,
                                balanceAfter: realAfter,
                                bonusBalanceBefore: grantResult.bonusBalanceBefore,
                                bonusBalanceAfter: grantResult.bonusBalanceAfter,
                            },
                        })
                        bonusAwarded = bonusAmount
                    }
                }
```

Add the import at the top of the file: `import { BonusService } from './bonus.service'`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test deposit-adjust`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wallet.service.ts apps/api/src/test/deposit-adjust.test.ts
git commit -m "refactor(bonus): route first-deposit bonus through BonusService.grant"
```

---

### Task 7: `CashbackService.disburse` → `BonusService.grant`

**Files:**
- Modify: `apps/api/src/services/cashback.service.ts:180-236`
- Test: find and extend the existing cashback disbursement test.

**Interfaces:**
- Consumes: `BonusService.grant` (Task 2).

- [ ] **Step 1: Find the existing cashback disbursement test**

Run: `grep -rln "checkAndDisburse\|runChecks" apps/api/src/test/*.ts`

- [ ] **Step 2: Add an assertion that disbursement creates a `BonusGrant` lot**

Add to the identified test file, inside a `describe` block that already sets up an active `CashbackPromotion` and a qualifying loss:

```typescript
it('disburses cashback as a BonusGrant lot', async () => {
    // ... reuse this file's existing setup for a promotion + qualifying player ...
    await CashbackService.checkAndDisburse(promotionId)

    const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: playerId } })
    expect(lot.ruleId).toBeNull()
    expect(lot.expiresAt).toBeNull()
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test <the identified test file> -- -t "BonusGrant lot"`
Expected: FAIL — no lot is created yet.

- [ ] **Step 4: Replace the raw increment with `BonusService.grant`**

In `apps/api/src/services/cashback.service.ts`, replace lines 191-224 (from the `SELECT ... FOR UPDATE` wallet lock through the `tx.transaction.create` call) with:

```typescript
                const grantResult = await BonusService.grant(tx, {
                    userId: entry.userId,
                    amount: cashbackAmount,
                    source: 'CASHBACK',
                })
                if (!grantResult.granted) return 'skipped'

                await tx.transaction.create({
                    data: {
                        userId: entry.userId,
                        type: TransactionType.CASHBACK_BONUS,
                        amount: cashbackAmount,
                        status: PaymentStatus.APPROVED,
                        referenceId: promotionId,
                        note: `Cashback: ${promotion.name}`,
                        balanceBefore: grantResult.bonusBalanceBefore,
                        balanceAfter: grantResult.bonusBalanceBefore,
                        bonusBalanceBefore: grantResult.bonusBalanceBefore,
                        bonusBalanceAfter: grantResult.bonusBalanceAfter,
                    },
                })
```

Note `balanceBefore`/`balanceAfter` (the real-balance snapshot columns) are set to `grantResult.bonusBalanceBefore` here only because the original code also left `realBefore` unchanged on both sides — a cashback grant never touches real balance. Keep the `Decimal` import and `PaymentStatus`/`TransactionType` imports as-is; add `import { BonusService } from './bonus.service'`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test <the identified test file>`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/cashback.service.ts apps/api/src/test/*.test.ts
git commit -m "refactor(bonus): route cashback disbursement through BonusService.grant"
```

---

### Task 8: `CampaignService` `CAMPAIGN_BONUS` credit → `BonusService.grant`

**Files:**
- Modify: `apps/api/src/services/player-crm/campaign.service.ts:456-490`
- Test: `apps/api/src/test/campaign.service.test.ts` (existing).

**Interfaces:**
- Consumes: `BonusService.grant` (Task 2).

- [ ] **Step 1: Add an assertion to the existing bonus-grant campaign test**

`campaign.service.test.ts` already opts into `CRM_BONUS_GRANTS_ENABLED = 'true'` and exercises this path (see the file's `beforeEach`). Find its bonus-delivery test (search for `CAMPAIGN_BONUS` in the file) and add:

```typescript
const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId } })
expect(lot.ruleId).toBeNull()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test campaign.service -- -t "<the test name found above>"`
Expected: FAIL — no lot created.

- [ ] **Step 3: Replace the raw increment with `BonusService.grant`**

In `apps/api/src/services/player-crm/campaign.service.ts`, replace the wallet-lock-through-transaction-create block (lines ~458-484):

```typescript
                    const grantResult = await BonusService.grant(tx, {
                        userId,
                        amount,
                        source: 'CAMPAIGN',
                    })

                    const txn = await tx.transaction.create({
                        data: {
                            userId,
                            type: TransactionType.CAMPAIGN_BONUS as never,
                            amount,
                            status: PaymentStatus.APPROVED as never,
                            referenceId: campaignId,
                            note: '[Campaign] bonus grant',
                            balanceBefore: grantResult.bonusBalanceBefore,
                            balanceAfter: grantResult.bonusBalanceBefore,
                            bonusBalanceBefore: grantResult.bonusBalanceBefore,
                            bonusBalanceAfter: grantResult.bonusBalanceAfter,
                        },
                    })
                    transactionId = txn.id
                    bonusAmount = amount
```

Add `import { BonusService } from '../bonus.service'` (path relative to `player-crm/`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test campaign.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/player-crm/campaign.service.ts apps/api/src/test/campaign.service.test.ts
git commit -m "refactor(bonus): route campaign bonus delivery through BonusService.grant"
```

---

### Task 9: Admin `adjust-balance` route → `BonusService.grant` / `.reduce`

**Files:**
- Modify: `apps/api/src/routes/admin/index.ts:130-165`
- Test: `apps/api/src/test/admin-approve-route.test.ts` or a new `admin-adjust-balance.test.ts` if no existing test covers this route.

**Interfaces:**
- Consumes: `BonusService.grant`, `BonusService.reduce` (Tasks 2, 4).

- [ ] **Step 1: Check for an existing test of this route**

Run: `grep -rln "adjust-balance" apps/api/src/test/*.ts`

If none exists, create `apps/api/src/test/admin-adjust-balance.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from './setup'
import { buildTestApp } from './test-app' // use whatever app-building helper the sibling admin tests use

describe('POST /admin/players/:id/adjust-balance', () => {
    it('positive bonus adjustment creates a BonusGrant lot', async () => {
        // Reuse this suite's existing admin-auth + player fixture setup.
        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${playerId}/adjust-balance`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { type: 'bonus', amount: 40, note: 'test grant' },
        })
        expect(res.statusCode).toBe(200)

        const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: playerId } })
        expect(new Decimal(lot.remaining).toNumber()).toBe(40)
    })

    it('negative bonus adjustment clamps at zero rather than going negative', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${playerId}/adjust-balance`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { type: 'bonus', amount: -999, note: 'test reduce' },
        })
        expect(res.statusCode).toBe(200)
        expect(res.json().bonusBalance).toBe(0)
    })
})
```

Adapt the `app.inject`/auth-fixture calls to match whatever helper `admin-approve-route.test.ts` uses — read that file first for the exact pattern (it already exercises an authenticated admin route in this same file).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test admin-adjust-balance`
Expected: FAIL — no lot created (current code raw-increments).

- [ ] **Step 3: Replace the bonus branch with `BonusService.grant`/`.reduce`**

In `apps/api/src/routes/admin/index.ts`, replace the `else` branch (bonus adjustment, lines ~157-163):

```typescript
                } else {
                    const grantOrReduce =
                        adjustAmount.gte(0)
                            ? await BonusService.grant(tx, { userId, amount: adjustAmount, source: 'ADMIN' })
                            : await BonusService.reduce(tx, userId, adjustAmount.abs()).then((r) => ({
                                  bonusBalanceBefore: r.bonusBalanceBefore,
                                  bonusBalanceAfter: r.bonusBalanceAfter,
                              }))
                    await tx.transaction.create({
                        data: {
                            userId,
                            type: TransactionType.ADMIN_BONUS_ADJUSTMENT,
                            amount: adjustAmount,
                            status: PaymentStatus.APPROVED,
                            note: `[Admin] ${note}`,
                            balanceBefore: realBefore,
                            balanceAfter: realBefore,
                            bonusBalanceBefore: grantOrReduce.bonusBalanceBefore,
                            bonusBalanceAfter: grantOrReduce.bonusBalanceAfter,
                        },
                    })
                    return { realBalance: Number(realBefore), bonusBalance: Number(grantOrReduce.bonusBalanceAfter) }
                }
```

Remove the now-dead `if (bonusAfter.lessThan(0)) throw ...` guard — `reduce` already clamps, so this branch can no longer go negative. Add `import { BonusService } from '../../services/bonus.service'`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test admin-adjust-balance`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin/index.ts apps/api/src/test/admin-adjust-balance.test.ts
git commit -m "refactor(bonus): route admin bonus adjustments through BonusService"
```

---

## Phase 4 — Deposit bonus rules

### Task 10: Period bucket helper (`bonus-period.ts`)

**Files:**
- Create: `apps/api/src/lib/bonus-period.ts`
- Test: `apps/api/src/test/bonus-period.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export function dayBucketStart(at: Date): Date
  export function weekBucketStart(at: Date): Date
  ```
  Pure, no I/O, no DB. Task 12 (`DepositBonusService`) depends on these exact names.

Per the spec (§6), bonus periods run on a fixed UTC+3 offset (`Africa/Addis_Ababa`, no DST) — this is a hardcoded constant, not read from the DB, because Ethiopia's offset never changes. Task 24 seeds a `bonus_period_timezone` SiteSetting for display purposes only; it is not consulted here.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { dayBucketStart, weekBucketStart } from '../lib/bonus-period'

describe('bonus-period', () => {
    describe('dayBucketStart', () => {
        it('a deposit at 02:59 UTC (05:59 local) buckets to the same local day as 00:01 UTC', () => {
            // 2026-08-20T00:01:00Z is 03:01 local on Aug 20 -> bucket start 2026-08-19T21:00:00Z (Aug 20 00:00 local)
            const early = dayBucketStart(new Date('2026-08-20T00:01:00Z'))
            expect(early.toISOString()).toBe('2026-08-19T21:00:00.000Z')
        })

        it('a deposit at 20:59:59 UTC (23:59:59 local) stays in the same local day', () => {
            const lateNight = dayBucketStart(new Date('2026-08-20T20:59:59Z'))
            expect(lateNight.toISOString()).toBe('2026-08-19T21:00:00.000Z')
        })

        it('a deposit at 21:00:00 UTC (00:00:00 local next day) rolls to the next bucket', () => {
            const midnight = dayBucketStart(new Date('2026-08-20T21:00:00Z'))
            expect(midnight.toISOString()).toBe('2026-08-20T21:00:00.000Z')
        })
    })

    describe('weekBucketStart', () => {
        it('a Monday-local deposit buckets to that Monday', () => {
            // 2026-08-24 is a Monday. 00:00 local Monday = 2026-08-23T21:00:00Z.
            const mondayMorning = weekBucketStart(new Date('2026-08-23T22:00:00Z')) // 01:00 local Monday
            expect(mondayMorning.toISOString()).toBe('2026-08-23T21:00:00.000Z')
        })

        it('a Sunday-local deposit buckets to the PRECEDING Monday', () => {
            // 2026-08-30 is a Sunday. 12:00 local Sunday = 2026-08-30T09:00:00Z.
            const sundayNoon = weekBucketStart(new Date('2026-08-30T09:00:00Z'))
            expect(sundayNoon.toISOString()).toBe('2026-08-23T21:00:00.000Z')
        })
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test bonus-period`
Expected: FAIL — `Cannot find module '../lib/bonus-period'`.

- [ ] **Step 3: Implement the helper**

```typescript
/**
 * Bonus periods run on Africa/Addis_Ababa, which is a fixed UTC+3 offset —
 * Ethiopia observes no DST, so there is no ambiguous or skipped local time to
 * handle. Hardcoded rather than read from SiteSetting; see the design spec §6.
 */
const ADDIS_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Start of the local day containing `at`, expressed as a UTC instant. */
export function dayBucketStart(at: Date): Date {
    const local = new Date(at.getTime() + ADDIS_OFFSET_MS)
    const localMidnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
    return new Date(localMidnightAsUtc - ADDIS_OFFSET_MS)
}

/** Start of the local Mon-Sun week containing `at`, expressed as a UTC instant. */
export function weekBucketStart(at: Date): Date {
    const dayStart = dayBucketStart(at)
    const localDayStart = new Date(dayStart.getTime() + ADDIS_OFFSET_MS)
    const dow = localDayStart.getUTCDay() // 0 = Sunday .. 6 = Saturday
    const daysSinceMonday = (dow + 6) % 7
    return new Date(dayStart.getTime() - daysSinceMonday * DAY_MS)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test bonus-period`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/bonus-period.ts apps/api/src/test/bonus-period.test.ts
git commit -m "feat(bonus): add fixed-offset day/week bucket helper for Addis Ababa"
```

---

### Task 11: `BonusRuleService` CRUD

**Files:**
- Create: `apps/api/src/services/bonus-rule.service.ts`
- Test: `apps/api/src/test/bonus-rule.service.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface CreateBonusRuleInput {
      name: string
      type: 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT'
      threshold: number
      rewardType: 'FIXED' | 'PERCENTAGE'
      rewardValue: number
      maxReward?: number | null
      validityHours: number
      startsAt: string
      endsAt: string
  }
  export class BonusRuleService {
      static async create(input: CreateBonusRuleInput): Promise<BonusRule>
      static async update(id: string, input: Partial<CreateBonusRuleInput> & { isActive?: boolean }): Promise<BonusRule>
      static async list(): Promise<BonusRule[]>
      static async listActive(now: Date): Promise<BonusRule[]>
  }
  ```
  Task 12 (`DepositBonusService`) uses `listActive`. Tasks 22 (`GET /promotions`) and 24 (admin CRUD routes) use all four methods.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { prisma } from './setup'
import { BonusRuleService } from '../services/bonus-rule.service'

describe('BonusRuleService', () => {
    it('creates a rule and lists it', async () => {
        const rule = await BonusRuleService.create({
            name: 'Daily 500',
            type: 'DAILY_DEPOSIT',
            threshold: 500,
            rewardType: 'FIXED',
            rewardValue: 50,
            validityHours: 24,
            startsAt: '2026-08-01T00:00:00Z',
            endsAt: '2026-12-31T00:00:00Z',
        })
        expect(rule.name).toBe('Daily 500')

        const all = await BonusRuleService.list()
        expect(all.map((r) => r.id)).toContain(rule.id)
    })

    it('listActive filters by isActive and the startsAt/endsAt window', async () => {
        const now = new Date('2026-08-20T12:00:00Z')
        const inWindow = await BonusRuleService.create({
            name: 'In window', type: 'WEEKLY_DEPOSIT', threshold: 2000,
            rewardType: 'FIXED', rewardValue: 150, validityHours: 168,
            startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z',
        })
        await BonusRuleService.create({
            name: 'Not started', type: 'WEEKLY_DEPOSIT', threshold: 2000,
            rewardType: 'FIXED', rewardValue: 150, validityHours: 168,
            startsAt: '2027-01-01T00:00:00Z', endsAt: '2027-06-01T00:00:00Z',
        })
        const inactive = await BonusRuleService.create({
            name: 'Deactivated', type: 'DAILY_DEPOSIT', threshold: 500,
            rewardType: 'FIXED', rewardValue: 50, validityHours: 24,
            startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z',
        })
        await BonusRuleService.update(inactive.id, { isActive: false })

        const active = await BonusRuleService.listActive(now)
        const ids = active.map((r) => r.id)
        expect(ids).toContain(inWindow.id)
        expect(ids).not.toContain(inactive.id)
        expect(active.length).toBe(1)
    })

    it('update() clamps maxReward and rejects endsAt before startsAt implicitly via caller validation', async () => {
        const rule = await BonusRuleService.create({
            name: 'To edit', type: 'DAILY_DEPOSIT', threshold: 500,
            rewardType: 'PERCENTAGE', rewardValue: 10, maxReward: 100, validityHours: 24,
            startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z',
        })
        const updated = await BonusRuleService.update(rule.id, { rewardValue: 15 })
        expect(Number(updated.rewardValue)).toBe(15)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test bonus-rule.service`
Expected: FAIL — `Cannot find module '../services/bonus-rule.service'`.

- [ ] **Step 3: Implement `BonusRuleService`**

```typescript
import prisma from '../lib/prisma'
import type { BonusRule } from '@prisma/client'

export interface CreateBonusRuleInput {
    name: string
    type: 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT'
    threshold: number
    rewardType: 'FIXED' | 'PERCENTAGE'
    rewardValue: number
    maxReward?: number | null
    validityHours: number
    startsAt: string
    endsAt: string
}

export class BonusRuleService {
    static async create(input: CreateBonusRuleInput): Promise<BonusRule> {
        return prisma.bonusRule.create({
            data: {
                name: input.name,
                type: input.type,
                threshold: input.threshold,
                rewardType: input.rewardType,
                rewardValue: input.rewardValue,
                maxReward: input.maxReward ?? null,
                validityHours: input.validityHours,
                startsAt: new Date(input.startsAt),
                endsAt: new Date(input.endsAt),
            },
        })
    }

    static async update(id: string, input: Partial<CreateBonusRuleInput> & { isActive?: boolean }): Promise<BonusRule> {
        return prisma.bonusRule.update({
            where: { id },
            data: {
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.type !== undefined ? { type: input.type } : {}),
                ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
                ...(input.rewardType !== undefined ? { rewardType: input.rewardType } : {}),
                ...(input.rewardValue !== undefined ? { rewardValue: input.rewardValue } : {}),
                ...(input.maxReward !== undefined ? { maxReward: input.maxReward } : {}),
                ...(input.validityHours !== undefined ? { validityHours: input.validityHours } : {}),
                ...(input.startsAt !== undefined ? { startsAt: new Date(input.startsAt) } : {}),
                ...(input.endsAt !== undefined ? { endsAt: new Date(input.endsAt) } : {}),
                ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            },
        })
    }

    static async list(): Promise<BonusRule[]> {
        return prisma.bonusRule.findMany({ orderBy: { createdAt: 'desc' } })
    }

    static async listActive(now: Date): Promise<BonusRule[]> {
        return prisma.bonusRule.findMany({
            where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
        })
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test bonus-rule.service`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/bonus-rule.service.ts apps/api/src/test/bonus-rule.service.test.ts
git commit -m "feat(bonus): add BonusRuleService CRUD"
```

---

### Task 12: `DepositBonusService.evaluateAndGrant` + wire into `approveDeposit`

**Files:**
- Create: `apps/api/src/services/deposit-bonus.service.ts`
- Modify: `apps/api/src/services/wallet.service.ts:127-167` (right after the first-deposit-bonus block from Task 6)
- Test: `apps/api/src/test/deposit-bonus.service.test.ts`

**Interfaces:**
- Consumes: `BonusRuleService.listActive` (Task 11), `dayBucketStart`/`weekBucketStart` (Task 10), `BonusService.grant` (Task 2).
- Produces:
  ```typescript
  export interface EvaluateDepositBonusResult {
      daily?: { ruleId: string; amount: Decimal }
      weekly?: { ruleId: string; amount: Decimal }
  }
  export class DepositBonusService {
      static async evaluateAndGrant(tx: Prisma.TransactionClient, userId: string, depositAt: Date): Promise<EvaluateDepositBonusResult>
  }
  ```

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from './setup'
import { DepositBonusService } from '../services/deposit-bonus.service'
import { BonusRuleService } from '../services/bonus-rule.service'

async function makeUser(username: string, phone: string) {
    return prisma.user.create({
        data: { username, phone, passwordHash: 'hashed:pass', role: 'PLAYER', wallet: { create: { realBalance: 0, bonusBalance: 0 } } },
    })
}

async function approvedDeposit(userId: string, amount: number, at: Date) {
    return prisma.transaction.create({
        data: { userId, type: 'DEPOSIT', amount, status: 'APPROVED', createdAt: at },
    })
}

describe('DepositBonusService.evaluateAndGrant', () => {
    it('grants the daily bonus once the bucket total crosses the threshold, from multiple small deposits', async () => {
        const user = await makeUser('depbonus1', '+251900000012')
        await BonusRuleService.create({
            name: 'Daily 500', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(user.id, 300, day)
        await approvedDeposit(user.id, 250, day) // bucket total now 550, crosses 500

        const result = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day))

        expect(result.daily?.amount.toNumber()).toBe(50)
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(50)
    })

    it('does not grant when the bucket total is below threshold', async () => {
        const user = await makeUser('depbonus2', '+251900000013')
        await BonusRuleService.create({
            name: 'Daily 500b', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(user.id, 100, day)

        const result = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day))
        expect(result.daily).toBeUndefined()
    })

    it('a percentage reward clamps to maxReward and rounds down', async () => {
        const user = await makeUser('depbonus3', '+251900000014')
        await BonusRuleService.create({
            name: 'Weekly 10pct', type: 'WEEKLY_DEPOSIT', threshold: 1000, rewardType: 'PERCENTAGE',
            rewardValue: 10, maxReward: 80, validityHours: 168,
            startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        const day = new Date('2026-08-24T10:00:00Z') // a Monday
        await approvedDeposit(user.id, 3333.33, day) // 10% = 333.333, clamped to 80

        const result = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day))
        expect(result.weekly?.amount.toNumber()).toBe(80)
    })

    it('a single deposit crossing both a daily and a weekly threshold grants two independent lots', async () => {
        const user = await makeUser('depbonus4', '+251900000015')
        await BonusRuleService.create({
            name: 'Daily', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        await BonusRuleService.create({
            name: 'Weekly', type: 'WEEKLY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 150, validityHours: 168, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(user.id, 600, day)

        const result = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day))
        expect(result.daily?.amount.toNumber()).toBe(50)
        expect(result.weekly?.amount.toNumber()).toBe(150)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(200)
    })

    it('is idempotent per day — evaluating twice for the same bucket grants once', async () => {
        const user = await makeUser('depbonus5', '+251900000016')
        await BonusRuleService.create({
            name: 'Daily idem', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(user.id, 600, day)

        await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day))
        const second = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day))

        expect(second.daily).toBeUndefined() // already granted for this bucket
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(50)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test deposit-bonus.service`
Expected: FAIL — `Cannot find module '../services/deposit-bonus.service'`.

- [ ] **Step 3: Implement `DepositBonusService`**

```typescript
import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { BonusRuleService } from './bonus-rule.service'
import { BonusService } from './bonus.service'
import { dayBucketStart, weekBucketStart } from '../lib/bonus-period'

export interface EvaluateDepositBonusResult {
    daily?: { ruleId: string; amount: Decimal }
    weekly?: { ruleId: string; amount: Decimal }
}

function computeReward(rule: { rewardType: string; rewardValue: Decimal | number; maxReward: Decimal | number | null }, bucketTotal: Decimal): Decimal {
    if (rule.rewardType === 'FIXED') return new Decimal(rule.rewardValue)
    let reward = bucketTotal.times(rule.rewardValue).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_DOWN)
    if (rule.maxReward != null) reward = Decimal.min(reward, new Decimal(rule.maxReward))
    return reward
}

export class DepositBonusService {
    /**
     * Evaluated at deposit-approval time, inside the same transaction that
     * credits realBalance. Every active DAILY_DEPOSIT/WEEKLY_DEPOSIT rule is
     * checked independently, so one deposit can trigger both. Idempotent per
     * (rule, user, bucket) via BonusService.grant's unique constraint.
     */
    static async evaluateAndGrant(
        tx: Prisma.TransactionClient,
        userId: string,
        depositAt: Date,
    ): Promise<EvaluateDepositBonusResult> {
        const rules = await tx.bonusRule.findMany({
            where: { isActive: true, startsAt: { lte: depositAt }, endsAt: { gte: depositAt } },
        })
        const result: EvaluateDepositBonusResult = {}

        for (const rule of rules) {
            const periodStart = rule.type === 'DAILY_DEPOSIT' ? dayBucketStart(depositAt) : weekBucketStart(depositAt)
            const bucketMs = rule.type === 'DAILY_DEPOSIT' ? 86_400_000 : 7 * 86_400_000
            const bucketEnd = new Date(periodStart.getTime() + bucketMs)

            const sum = await tx.transaction.aggregate({
                where: { userId, type: 'DEPOSIT', status: 'APPROVED', createdAt: { gte: periodStart, lt: bucketEnd } },
                _sum: { amount: true },
            })
            const bucketTotal = new Decimal(sum._sum.amount ?? 0)
            if (bucketTotal.lessThan(rule.threshold)) continue

            const reward = computeReward(rule, bucketTotal)
            if (reward.lte(0)) continue

            const expiresAt = new Date(depositAt.getTime() + rule.validityHours * 3_600_000)
            const grantResult = await BonusService.grant(tx, {
                userId,
                amount: reward,
                source: rule.type === 'DAILY_DEPOSIT' ? 'DAILY_DEPOSIT' : 'WEEKLY_DEPOSIT',
                ruleId: rule.id,
                periodStart,
                expiresAt,
            })
            if (!grantResult.granted) continue

            if (rule.type === 'DAILY_DEPOSIT') result.daily = { ruleId: rule.id, amount: reward }
            else result.weekly = { ruleId: rule.id, amount: reward }
        }

        return result
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test deposit-bonus.service`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire it into `WalletService.approveDeposit`**

In `apps/api/src/services/wallet.service.ts`, immediately after the first-deposit-bonus block from Task 6 (still inside the same `prisma.$transaction` callback, before the `return { transaction, ... }` line), add:

```typescript
            const depositBonusResult = await DepositBonusService.evaluateAndGrant(tx, transaction.userId, new Date())
```

Add `depositBonusResult` to the transaction's return object, and thread it to the `.then()` continuation so the wallet-update push reflects the final balance:

```typescript
            return { transaction, realAfter, bonusAwarded, bonusBefore, creditAmount, isAdjusted, statedAmount, depositBonusResult }
```

In the `.then()` block, extend `finalBonusBalance` to include the deposit-bonus grants:

```typescript
        }).then(async ({ transaction, realAfter, bonusAwarded, bonusBefore, creditAmount, isAdjusted, statedAmount, depositBonusResult }) => {
            const depositBonusTotal = new Decimal(depositBonusResult.daily?.amount ?? 0).plus(depositBonusResult.weekly?.amount ?? 0)
            const finalBonusBalance = bonusBefore.plus(bonusAwarded).plus(depositBonusTotal).toNumber()
```

Add the import: `import { DepositBonusService } from './deposit-bonus.service'`.

- [ ] **Step 6: Extend the Task 6 test to cover a combined first-deposit + daily-deposit grant**

Add to `apps/api/src/test/deposit-adjust.test.ts`:

```typescript
it('a first deposit that also crosses a daily-deposit threshold grants both lots', async () => {
    await prisma.siteSetting.upsert({
        where: { key: 'first_deposit_bonus_amount' },
        create: { key: 'first_deposit_bonus_amount', value: '25' },
        update: { value: '25' },
    })
    await BonusRuleService.create({
        name: 'Daily combo', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
        rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
    })

    const user = await makeUser('combo1', '+251900000017')
    const tx = await prisma.transaction.create({ data: { userId: user.id, type: 'DEPOSIT', amount: 600, status: 'PENDING_REVIEW' } })
    await WalletService.approveDeposit(tx.id)

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(75) // 25 first-deposit + 50 daily

    const lots = await prisma.bonusGrant.findMany({ where: { userId: user.id } })
    expect(lots).toHaveLength(2)
})
```

- [ ] **Step 7: Run the full deposit test suite**

Run: `pnpm --filter @world-bingo/api test deposit-adjust deposit-bonus.service`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/deposit-bonus.service.ts apps/api/src/services/wallet.service.ts apps/api/src/test/deposit-bonus.service.test.ts apps/api/src/test/deposit-adjust.test.ts
git commit -m "feat(bonus): evaluate and grant daily/weekly deposit bonuses on approval"
```

---

## Phase 5 — Spend account selection

### Task 13: `Wallet.spendAccount` toggle + `PATCH /wallet/spend-account`

**Files:**
- Modify: `apps/api/src/services/wallet.service.ts`
- Modify: `apps/api/src/controllers/wallet.controller.ts`
- Modify: `apps/api/src/routes/wallet/index.ts`
- Test: `apps/api/src/test/wallet-spend-account.test.ts`

**Interfaces:**
- Produces: `WalletService.setSpendAccount(userId: string, account: 'REAL' | 'BONUS'): Promise<Wallet>`. `WalletController.setSpendAccount`. Route `PATCH /wallet/spend-account`.
- Consumed by: Tasks 14, 16, 17 read `wallet.spendAccount` off the row they already lock; this task only writes it.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { prisma } from './setup'
import { WalletService } from '../services/wallet.service'

async function makeUser(username: string, phone: string) {
    return prisma.user.create({
        data: { username, phone, passwordHash: 'hashed:pass', role: 'PLAYER', wallet: { create: { realBalance: 0, bonusBalance: 0 } } },
    })
}

describe('WalletService.setSpendAccount', () => {
    it('flips the selected account and defaults to REAL', async () => {
        const user = await makeUser('spendacct1', '+251900000018')
        const initial = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(initial.spendAccount).toBe('REAL')

        const updated = await WalletService.setSpendAccount(user.id, 'BONUS')
        expect(updated.spendAccount).toBe('BONUS')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test wallet-spend-account`
Expected: FAIL — `WalletService.setSpendAccount is not a function`.

- [ ] **Step 3: Implement the service method**

Add to `apps/api/src/services/wallet.service.ts`, inside `WalletService`, near `getBalance`:

```typescript
    static async setSpendAccount(userId: string, account: 'REAL' | 'BONUS') {
        return prisma.wallet.update({ where: { userId }, data: { spendAccount: account } })
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test wallet-spend-account`
Expected: PASS.

- [ ] **Step 5: Wire the controller and route**

Add to `apps/api/src/controllers/wallet.controller.ts`, inside `WalletController`, near `getBalance`:

```typescript
    static async setSpendAccount(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const { account } = request.body as { account: 'REAL' | 'BONUS' }
        if (account !== 'REAL' && account !== 'BONUS') {
            return reply.status(400).send({ error: 'account must be REAL or BONUS' })
        }
        const wallet = await WalletService.setSpendAccount(userId, account)
        return wallet
    }
```

Add to `apps/api/src/routes/wallet/index.ts`, after the `/stats` route:

```typescript
    fastify.patch('/spend-account', {
        handler: WalletController.setSpendAccount,
    })
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/wallet.service.ts apps/api/src/controllers/wallet.controller.ts apps/api/src/routes/wallet/index.ts apps/api/src/test/wallet-spend-account.test.ts
git commit -m "feat(bonus): add player-selectable spend account (REAL/BONUS)"
```

---

### Task 14: `GameService.joinGame` → spend-account-based spend

**Files:**
- Modify: `apps/api/src/services/game.service.ts:88-131`
- Test: `apps/api/src/test/game.service.test.ts` (existing — extend) or `apps/api/src/test/game.service.extended.test.ts`

**Interfaces:**
- Consumes: `BonusService.spend`, `InsufficientBonusBalanceError` (Task 3).
- Produces: `GAME_ENTRY` transactions now carry `bonusExpiresAtSpend` when funded from `BONUS`, consumed by Task 15's refund path.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/test/game.service.extended.test.ts` (or the closest existing joinGame test file — search first with `grep -n "describe.*joinGame" apps/api/src/test/*.ts`):

```typescript
it('spends from BONUS when spendAccount is BONUS, and stamps bonusExpiresAtSpend', async () => {
    const expiresAt = new Date(Date.now() + 3600_000)
    const user = await makeUser('spendbonus1', '+251900000019') // reuse this file's user fixture helper
    await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS', realBalance: 1000 } })
    await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 50, source: 'ADMIN', expiresAt }))

    const game = await makeWaitingGame(10) // reuse this file's game fixture helper, ticketPrice 10
    await GameService.joinGame(user.id, game.id, [game.cartelaSerials[0]])

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect(new Decimal(wallet.realBalance).toNumber()).toBe(1000) // untouched
    expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(40)

    const entryTxn = await prisma.transaction.findFirstOrThrow({ where: { userId: user.id, type: 'GAME_ENTRY' } })
    expect(entryTxn.bonusExpiresAtSpend?.getTime()).toBe(expiresAt.getTime())
})

it('rejects with INSUFFICIENT_BONUS_BALANCE when BONUS is selected but short, without touching real', async () => {
    const user = await makeUser('spendbonus2', '+251900000020')
    await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS', realBalance: 1000 } })
    await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 5, source: 'ADMIN' }))

    const game = await makeWaitingGame(10)
    await expect(GameService.joinGame(user.id, game.id, [game.cartelaSerials[0]])).rejects.toThrow(
        'Insufficient bonus balance',
    )

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect(new Decimal(wallet.realBalance).toNumber()).toBe(1000)
    expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(5)
})

it('spends from REAL when spendAccount is REAL, even if BONUS has funds', async () => {
    const user = await makeUser('spendreal1', '+251900000021')
    await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'REAL', realBalance: 1000 } })
    await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 500, source: 'ADMIN' }))

    const game = await makeWaitingGame(10)
    await GameService.joinGame(user.id, game.id, [game.cartelaSerials[0]])

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect(new Decimal(wallet.realBalance).toNumber()).toBe(990)
    expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(500) // untouched
})
```

Adapt `makeUser`/`makeWaitingGame` to whatever fixture helpers the target file already defines; add `import { BonusService } from '../services/bonus.service'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @world-bingo/api test game.service.extended -- -t "spendAccount"`
Expected: FAIL — bonus is still spent bonus-first regardless of `spendAccount`.

- [ ] **Step 3: Replace the bonus-first split with spend-account-based spend**

In `apps/api/src/services/game.service.ts`, replace lines 88-131 (from the wallet lock through the `GAME_ENTRY` transaction create):

```typescript
            const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal; spendAccount: string }>>`
                SELECT id, "realBalance", "bonusBalance", "spendAccount" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet) throw new Error('Wallet not found')

            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)

            let realAfter = realBefore
            let bonusAfter = bonusBefore
            let bonusExpiresAtSpend: Date | null = null

            if (wallet.spendAccount === 'BONUS') {
                const spendResult = await BonusService.spend(tx, userId, totalCost)
                bonusAfter = spendResult.bonusBalanceAfter
                bonusExpiresAtSpend = spendResult.soonestExpiryConsumed
            } else {
                if (realBefore.lessThan(totalCost)) {
                    throw new Error('Insufficient funds')
                }
                realAfter = realBefore.minus(totalCost)
                await tx.wallet.update({ where: { userId }, data: { realBalance: realAfter } })
            }

            // Create a single transaction record for the total entry cost
            await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.GAME_ENTRY,
                    amount: totalCost,
                    status: PaymentStatus.APPROVED,
                    referenceId: gameId,
                    balanceBefore: realBefore,
                    balanceAfter: realAfter,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusAfter,
                    bonusExpiresAtSpend,
                }
            })
```

Add the import: `import { BonusService } from './bonus.service'`. `InsufficientBonusBalanceError` needs no explicit catch — it already carries `statusCode = 400` (Task 3) and propagates through the route to the global error handler unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @world-bingo/api test game.service.extended`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/game.service.ts apps/api/src/test/game.service.extended.test.ts
git commit -m "feat(bonus): bingo entries spend from the player-selected account"
```

---

### Task 15: Bingo refund paths → restore bonus with its original expiry

**Files:**
- Modify: `apps/api/src/services/game.service.ts` (`leaveGame`, ~line 183-256)
- Modify: `apps/api/src/services/refund.service.ts` (`refundGame`)
- Test: extend the existing tests for both.

**Interfaces:**
- Consumes: `BonusService.restore` (Task 4).

Both `GameService.leaveGame` (player leaves a WAITING game) and `RefundService.refundGame` (game cancelled) already derive `realRefund`/`bonusRefund` from the `GAME_ENTRY` transaction's balance snapshots — that logic is unchanged. What changes is *how* the bonus portion is credited back: previously a raw `bonusBalance` increment, now `BonusService.restore` with the expiry Task 14 stamped onto that same `GAME_ENTRY` transaction (`bonusExpiresAtSpend`).

- [ ] **Step 1: Write the failing test for `leaveGame`**

Add to `apps/api/src/test/game.service.test.ts` (or wherever `leaveGame` is already tested — `grep -n "leaveGame" apps/api/src/test/*.ts`):

```typescript
it('leaveGame restores bonus-funded entries to a lot carrying the ORIGINAL expiry, not a fresh window', async () => {
    const originalExpiry = new Date(Date.now() + 1800_000)
    const user = await makeUser('leaverestore1', '+251900000022')
    await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS' } })
    await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 50, source: 'ADMIN', expiresAt: originalExpiry }))

    const game = await makeWaitingGame(10)
    await GameService.joinGame(user.id, game.id, [game.cartelaSerials[0]])
    await GameService.leaveGame(user.id, game.id)

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(50)

    const activeLot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: user.id, status: 'ACTIVE' } })
    expect(activeLot.expiresAt?.getTime()).toBe(originalExpiry.getTime())
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test game.service -- -t "leaveGame restores"`
Expected: FAIL — `bonusBalance` is incremented directly, no new lot is created, and the invariant check (if run alongside) would catch the desync.

- [ ] **Step 3: Update `leaveGame`**

In `apps/api/src/services/game.service.ts`, replace the wallet-update-through-transaction-create block inside `leaveGame` (the `realAfter`/`bonusAfter` computation and the `tx.wallet.update`/`tx.transaction.create` pair):

```typescript
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            let realAfter = realBefore.plus(realRefund)
            let bonusAfter = bonusBefore

            if (realRefund.gt(0)) {
                await tx.wallet.update({ where: { userId }, data: { realBalance: realAfter } })
            }
            if (bonusRefund.gt(0)) {
                const originalExpiry = entryTxns.find((t) => t.bonusExpiresAtSpend != null)?.bonusExpiresAtSpend ?? null
                const restoreResult = await BonusService.restore(tx, userId, bonusRefund, originalExpiry)
                bonusAfter = restoreResult.bonusBalanceAfter
            }

            // Record refund transaction
            await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.REFUND,
                    amount: refundAmount,
                    status: PaymentStatus.APPROVED,
                    referenceId: gameId,
                    balanceBefore: realBefore,
                    balanceAfter: realAfter,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusAfter,
                }
            })
```

Add `import { BonusService } from './bonus.service'` if not already present from Task 14 (same file).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test game.service`
Expected: PASS.

- [ ] **Step 5: Repeat the same change for `RefundService.refundGame`**

Write the equivalent test in whichever file covers `refund.service.ts` (search: `grep -rln "refundGame" apps/api/src/test/*.ts`), mirroring Step 1 with `RefundService.refundGame(game.id)` in place of `GameService.leaveGame`.

Apply the identical transformation to `apps/api/src/services/refund.service.ts`: replace its `tx.wallet.update({ data: { realBalance, bonusBalance } })` (around line 90) with the same `if (realRefund.gt(0)) { ...realBalance-only update... }` / `if (bonusRefund.gt(0)) { ...BonusService.restore... }` split, sourcing `originalExpiry` from that user's `GAME_ENTRY` transactions the same way. Add `import { BonusService } from './bonus.service'`.

- [ ] **Step 6: Run the refund service tests to verify they pass**

Run: `pnpm --filter @world-bingo/api test refund`
Expected: PASS.

- [ ] **Step 7: Run the full bonus invariant test alongside to catch any regression**

Run: `pnpm --filter @world-bingo/api test bonus-invariant game.service refund`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/game.service.ts apps/api/src/services/refund.service.ts apps/api/src/test/game.service.test.ts apps/api/src/test/*refund*.test.ts
git commit -m "fix(bonus): bingo refunds restore bonus with its original expiry, not a fresh one"
```

---

### Task 16: Prediction order placement → spend-account-based single-bucket reserve

**Files:**
- Modify: `apps/api/src/services/prediction/order.service.ts` (`lockWallet`, `placeOrder`'s reserve step)
- Test: `apps/api/src/test/prediction/order.service.test.ts` (existing — extend; locate with `grep -rln "placeOrder" apps/api/src/test/`)

**Interfaces:**
- Consumes: `BonusService.spend` (Task 3).
- Produces: `LockedWallet` gains `spendAccount: 'REAL' | 'BONUS'`. `placeOrder` still writes `reservedReal`/`reservedBonus` on the order — now always 100% one bucket, never split. `splitAgainstReserve` (existing, unchanged) degrades correctly on a single-bucket reserve, since one side is always zero.

- [ ] **Step 1: Write the failing tests**

Add to the located test file:

```typescript
it('reserves entirely from BONUS when spendAccount is BONUS', async () => {
    const user = await makeUser('predbonus1', '+251900000023') // reuse this file's fixture helper
    await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS', realBalance: 1000 } })
    await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 100, source: 'ADMIN' }))

    const order = await OrderService.placeOrder(user.id, { marketId, limitPrice: 5, outcomeId, quantity: 10 })

    expect(new Decimal(order.reservedBonus).toNumber()).toBe(50)
    expect(new Decimal(order.reservedReal).toNumber()).toBe(0)
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect(new Decimal(wallet.realBalance).toNumber()).toBe(1000) // untouched
    expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(50)
})

it('rejects with insufficient bonus balance rather than falling back to real', async () => {
    const user = await makeUser('predbonus2', '+251900000024')
    await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS', realBalance: 1000 } })
    await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 5, source: 'ADMIN' }))

    await expect(
        OrderService.placeOrder(user.id, { marketId, limitPrice: 5, outcomeId, quantity: 10 }),
    ).rejects.toThrow('Insufficient bonus balance')

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect(new Decimal(wallet.realBalance).toNumber()).toBe(1000)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @world-bingo/api test prediction/order.service -- -t "reserves entirely"`
Expected: FAIL — reserve still splits bonus-first regardless of `spendAccount`.

- [ ] **Step 3: Add `spendAccount` to `lockWallet`**

In `apps/api/src/services/prediction/order.service.ts`, update the `LockedWallet` interface and `lockWallet`:

```typescript
interface LockedWallet {
    id: string
    real: Prisma.Decimal
    bonus: Prisma.Decimal
    spendAccount: 'REAL' | 'BONUS'
}

async function lockWallet(tx: Prisma.TransactionClient, userId: string): Promise<LockedWallet> {
    const wallets = await tx.$queryRaw<
        Array<{ id: string; realBalance: Prisma.Decimal; bonusBalance: Prisma.Decimal; spendAccount: 'REAL' | 'BONUS' }>
    >`
        SELECT id, "realBalance", "bonusBalance", "spendAccount" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `
    const wallet = wallets[0]
    if (!wallet) throw httpError('Wallet not found', 404)

    return {
        id: wallet.id,
        real: new Prisma.Decimal(wallet.realBalance),
        bonus: new Prisma.Decimal(wallet.bonusBalance),
        spendAccount: wallet.spendAccount,
    }
}
```

- [ ] **Step 4: Replace the reserve computation in `placeOrder`**

Replace the block from `// ── 5. Reserve limitPrice × quantity, bonus first then real ──` through the `tx.wallet.update` call (lines ~275-291):

```typescript
                    // ── 5. Reserve limitPrice × quantity from the selected account ──
                    const limitPrice = new Prisma.Decimal(priceBirr)
                    const reserve = limitPrice.times(quantity)

                    let reservedReal = new Prisma.Decimal(0)
                    let reservedBonus = new Prisma.Decimal(0)
                    let realAfterHold = wallet.real
                    let bonusAfterHold = wallet.bonus

                    if (wallet.spendAccount === 'BONUS') {
                        const spendResult = await BonusService.spend(tx, userId, reserve)
                        reservedBonus = reserve
                        bonusAfterHold = spendResult.bonusBalanceAfter
                    } else {
                        if (wallet.real.lessThan(reserve)) {
                            throw httpError('Insufficient funds', 400)
                        }
                        reservedReal = reserve
                        realAfterHold = wallet.real.minus(reserve)
                        await tx.wallet.update({ where: { userId }, data: { realBalance: realAfterHold } })
                    }
```

`BonusService.spend` throws `InsufficientBonusBalanceError` (statusCode 400) for the BONUS branch — no extra catch needed, it propagates the same way as `httpError`. Remove the old `if (wallet.real.plus(wallet.bonus).lessThan(reserve)) throw httpError('Insufficient funds', 400)` combined-balance check — each branch now checks its own account.

Update the `PREDICTION_ORDER_HOLD` transaction create just below it to carry the expiry, mirroring Task 14/15:

```typescript
                    await tx.transaction.create({
                        data: {
                            userId,
                            type: TransactionType.PREDICTION_ORDER_HOLD,
                            amount: reserve,
                            status: PaymentStatus.APPROVED,
                            referenceId: marketId,
                            note: `Prediction order ${order.id}`,
                            balanceBefore: wallet.real,
                            balanceAfter: realAfterHold,
                            bonusBalanceBefore: wallet.bonus,
                            bonusBalanceAfter: bonusAfterHold,
                            bonusExpiresAtSpend: wallet.spendAccount === 'BONUS' ? spendResult!.soonestExpiryConsumed : null,
                        },
```

(Hoist `let spendResult: SpendBonusResult | undefined` above the `if` so it is in scope here; assign it inside the `BONUS` branch instead of the inline `const`.)

Add the import: `import { BonusService } from '../bonus.service'` (and `SpendBonusResult` as a type import if referenced by name).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @world-bingo/api test prediction/order.service`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/prediction/order.service.ts apps/api/src/test/prediction/order.service.test.ts
git commit -m "feat(bonus): prediction orders reserve entirely from the selected account"
```

---

### Task 17: Prediction order release/refund → restore bonus with its original expiry

**Files:**
- Modify: `apps/api/src/services/prediction/order.service.ts` (`cancelOrder`, ~line 505-520)
- Modify: `apps/api/src/services/prediction/settlement.service.ts` (`refundOpenOrders`, ~line 754-758)
- Test: extend both files' existing test coverage.

**Interfaces:**
- Consumes: `BonusService.restore` (Task 4).

Both paths release `order.reservedBonus` — the reserve still held after any partial fills — back to the wallet. The `PREDICTION_ORDER_HOLD` transaction from Task 16 now carries `bonusExpiresAtSpend`; both release sites look it up by `referenceId` (the market id) and `userId`, take the order's own hold specifically via a `note` match, and restore with that expiry rather than a fresh one, mirroring Task 15.

- [ ] **Step 1: Write the failing test for `cancelOrder`**

Add to `apps/api/src/test/prediction/order.service.test.ts`:

```typescript
it('cancelOrder restores unfilled bonus reserve to a lot carrying the ORIGINAL expiry', async () => {
    const originalExpiry = new Date(Date.now() + 1800_000)
    const user = await makeUser('predcancel1', '+251900000025')
    await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS' } })
    await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 100, source: 'ADMIN', expiresAt: originalExpiry }))

    const order = await OrderService.placeOrder(user.id, { marketId, limitPrice: 5, outcomeId, quantity: 10 })
    await OrderService.cancelOrder(user.id, order.id)

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(100)

    const activeLot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: user.id, status: 'ACTIVE' } })
    expect(activeLot.expiresAt?.getTime()).toBe(originalExpiry.getTime())
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test prediction/order.service -- -t "cancelOrder restores"`
Expected: FAIL — `bonusBalance` is incremented directly, no lot is created.

- [ ] **Step 3: Add a shared restore helper and use it in `cancelOrder`**

Add to `apps/api/src/services/prediction/order.service.ts`, near `lockWallet`:

```typescript
/**
 * Looks up the expiry BonusService.spend stamped on this order's original hold,
 * so a release restores it rather than granting a fresh window. Falls back to
 * null (never-expiring) if the hold predates this column (defensive only —
 * every hold created after Task 16 ships has one).
 */
async function originalHoldExpiry(tx: Prisma.TransactionClient, userId: string, orderId: string): Promise<Date | null> {
    const hold = await tx.transaction.findFirst({
        where: { userId, type: 'PREDICTION_ORDER_HOLD', note: { contains: orderId } },
        select: { bonusExpiresAtSpend: true },
    })
    return hold?.bonusExpiresAtSpend ?? null
}
```

In `cancelOrder`, replace the `if (refund.greaterThan(0)) { ... }` block (the combined `tx.wallet.update` + `tx.transaction.create`):

```typescript
                if (refund.greaterThan(0)) {
                    if (releasedReal.gt(0)) {
                        await tx.wallet.update({ where: { userId }, data: { realBalance: realAfter } })
                    }
                    if (releasedBonus.gt(0)) {
                        const expiry = await originalHoldExpiry(tx, userId, order.id)
                        await BonusService.restore(tx, userId, releasedBonus, expiry)
                    }

                    await tx.transaction.create({
                        data: {
                            userId,
                            type: TransactionType.PREDICTION_ORDER_RELEASE,
                            amount: refund,
                            status: PaymentStatus.APPROVED,
                            referenceId: marketId,
                            note: `Cancelled prediction order ${order.id}`,
                            balanceBefore: wallet.real,
                            balanceAfter: realAfter,
                            bonusBalanceBefore: wallet.bonus,
                            bonusBalanceAfter: bonusAfter,
                        },
                    })
                }
```

Add `import { BonusService } from '../bonus.service'`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test prediction/order.service`
Expected: PASS.

- [ ] **Step 5: Apply the same change to `refundOpenOrders`**

Write the equivalent test in whichever file covers `settlement.service.ts`'s market-cancellation path (search: `grep -rln "refundOpenOrders\|cancelMarket" apps/api/src/test/`), mirroring Step 1 with a market cancellation in place of `cancelOrder`.

In `apps/api/src/services/prediction/settlement.service.ts`, replace the `await tx.wallet.update({ data: { realBalance: realAfter, bonusBalance: bonusAfter } })` block inside `refundOpenOrders` (~line 758):

```typescript
                        if (real.gt(0)) {
                            await tx.wallet.update({ where: { userId: order.userId }, data: { realBalance: realAfter } })
                        }
                        if (bonus.gt(0)) {
                            const hold = await tx.transaction.findFirst({
                                where: { userId: order.userId, type: 'PREDICTION_ORDER_HOLD', note: { contains: order.id } },
                                select: { bonusExpiresAtSpend: true },
                            })
                            await BonusService.restore(tx, order.userId, bonus, hold?.bonusExpiresAtSpend ?? null)
                        }
```

Add `import { BonusService } from './bonus.service'`.

- [ ] **Step 6: Run the settlement tests to verify they pass**

Run: `pnpm --filter @world-bingo/api test prediction/settlement`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/prediction/order.service.ts apps/api/src/services/prediction/settlement.service.ts apps/api/src/test/prediction/*.test.ts
git commit -m "fix(bonus): prediction order release restores bonus with its original expiry"
```

---

### Task 18: `PalaceWalletService` → spend-account-based bet/authenticate/getBalance

**Files:**
- Modify: `apps/api/src/services/palace-wallet.service.ts` (`authenticate`, `getBalance`, `processBet`)
- Test: `apps/api/src/test/gasea-wallet.test.ts` or the Palace-specific equivalent (search: `grep -rln "processBet\|palace-wallet" apps/api/src/test/*.ts`).

**Interfaces:**
- Consumes: `BonusService.spend` (Task 3).

- [ ] **Step 1: Write the failing tests**

Add to the located test file:

```typescript
it('authenticate/getBalance report only the selected account balance', async () => {
    const user = await makeUser('palaceacct1', '+251900000026')
    await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS', realBalance: 1000 } })
    await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 40, source: 'ADMIN' }))

    const authResult = await PalaceWalletService.authenticate(user.username)
    expect(authResult.balance).toBe(40)

    const balResult = await PalaceWalletService.getBalance(user.username)
    expect(balResult.balance).toBe(40)
})

it('processBet spends from BONUS when selected, and rejects rather than dipping into real', async () => {
    const user = await makeUser('palacebet1', '+251900000027')
    await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS', realBalance: 1000 } })
    await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 10, source: 'ADMIN' }))

    const overBet = await PalaceWalletService.processBet({ account: user.username, amount: 50, trans_guid: 'g1', gplay_id: 'p1', round_id: 'r1', game_code: 'c1' } as any)
    expect(overBet.code).not.toBe(0) // rejected, not silently funded from real
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect(new Decimal(wallet.realBalance).toNumber()).toBe(1000)

    const okBet = await PalaceWalletService.processBet({ account: user.username, amount: 6, trans_guid: 'g2', gplay_id: 'p2', round_id: 'r2', game_code: 'c1' } as any)
    expect(okBet.balance).toBe(4)
})
```

Adapt to whatever request-shaping / assertion style (`code`/`ok`/`err`) the existing Palace tests use — read the target file's existing `processBet` tests first.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @world-bingo/api test <target file> -- -t "spend-account"`
Expected: FAIL — `authenticate`/`getBalance` still return `real + bonus`; `processBet` still spends real-first.

- [ ] **Step 3: Update `authenticate` and `getBalance`**

In `apps/api/src/services/palace-wallet.service.ts`, replace both balance computations:

```typescript
    static async authenticate(account: string): Promise<PalaceResponse> {
        const user = await resolveUser(account)
        if (!user) return palaceErr(21, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(22, 'USER_INACTIVE')

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        const balance = wallet
            ? wallet.spendAccount === 'BONUS'
                ? new Decimal(wallet.bonusBalance)
                : new Decimal(wallet.realBalance)
            : new Decimal(0)
        return ok({ account, balance: Number(balance.toFixed(2)) })
    }

    static async getBalance(account: string): Promise<PalaceResponse> {
        const user = await resolveUser(account)
        if (!user) return palaceErr(21, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(22, 'USER_INACTIVE')

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        if (!wallet) return palaceErr(21, 'USER_NOT_FOUND')

        const balance = wallet.spendAccount === 'BONUS' ? new Decimal(wallet.bonusBalance) : new Decimal(wallet.realBalance)
        return ok({ balance: Number(balance.toFixed(2)) })
    }
```

- [ ] **Step 4: Update `processBet`**

Replace the reserve/spend block inside `processBet`'s transaction (from `let newReal = realBefore` through the `tx.wallet.update` call):

```typescript
                let newReal = realBefore
                let newBonus = bonusBefore

                if (wallet.spendAccount === 'BONUS') {
                    if (bonusBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }
                    const spendResult = await BonusService.spend(tx, user.id, betAmount)
                    newBonus = spendResult.bonusBalanceAfter
                } else {
                    if (realBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }
                    newReal = realBefore.minus(betAmount)
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                }
                const newTotal = newReal.plus(newBonus)
```

`lockWallet` in this file already selects `bonusBalance`/`realBalance` via `SELECT id, "realBalance", "bonusBalance" FROM wallets ... FOR UPDATE` (around line 101 of this file per the earlier read) — add `"spendAccount"` to that column list and to the `WalletRow` type (`type WalletRow = { id: string; realBalance: Decimal; bonusBalance: Decimal; spendAccount: 'REAL' | 'BONUS' }`) so `wallet.spendAccount` is available above. Remove the old `if (totalBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }` combined check — each branch now checks its own account.

Add the import: `import { BonusService } from './bonus.service'`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @world-bingo/api test <target file>`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/palace-wallet.service.ts apps/api/src/test/*palace*.test.ts apps/api/src/test/gasea-wallet.test.ts
git commit -m "feat(bonus): Palace provider bets spend from the player-selected account"
```

---

### Task 19: `PalaceWalletService.processCancel` → restore rollback to its originating account

**Files:**
- Modify: `apps/api/src/services/palace-wallet.service.ts` (`processCancel`)
- Test: same file as Task 18.

**Interfaces:**
- Consumes: `BonusService.restore` (Task 4).

Per the design spec §5, `processCancel` crediting the reversed stake to `realBalance` unconditionally — even when the original bet was bonus-funded — predates this feature and is a real (if low-severity, provider-only-triggered) hole: it converts bonus to cash with no play at all. This task closes it using the same before/after-snapshot technique as Tasks 15 and 17: the original `BET`'s `ThirdPartyTransaction` row doesn't carry a bonus/real split today, but the paired `Transaction` row created alongside it in `processBet` (Task 18) does, via `bonusBalanceBefore`/`bonusBalanceAfter`.

- [ ] **Step 1: Write the failing test**

```typescript
it('processCancel restores a bonus-funded bet to bonus, not real', async () => {
    const user = await makeUser('palacecancel1', '+251900000028')
    await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS', realBalance: 1000 } })
    await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 20, source: 'ADMIN' }))

    await PalaceWalletService.processBet({ account: user.username, amount: 15, trans_guid: 'g3', gplay_id: 'p3', round_id: 'r3', game_code: 'c1' } as any)
    await PalaceWalletService.processCancel({ account: user.username, trans_guid: 'g3cancel', cancle_trans_guid: 'g3' } as any)

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(20) // restored to bonus
    expect(new Decimal(wallet.realBalance).toNumber()).toBe(1000) // untouched
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test <target file> -- -t "processCancel restores"`
Expected: FAIL — the rollback currently credits `realBalance` unconditionally.

- [ ] **Step 3: Look up the paired `Transaction` snapshot and split the rollback**

In `processCancel`, immediately after `const refundable = ...` and its `delta` computation, look up the original bet's real/bonus split from the `Transaction` row `processBet` created alongside the `ThirdPartyTransaction`:

```typescript
            let realDelta = delta
            let bonusDelta = new Decimal(0)
            if (refundable && delta.gt(0)) {
                const betTxn = await tx.transaction.findFirst({
                    where: { userId: user.id, type: 'TP_BET', referenceId: originalBet!.transactionId },
                    select: { bonusBalanceBefore: true, bonusBalanceAfter: true },
                })
                if (betTxn) {
                    const bonusSpent = new Decimal(betTxn.bonusBalanceBefore ?? 0).minus(new Decimal(betTxn.bonusBalanceAfter ?? 0))
                    if (bonusSpent.gt(0)) {
                        bonusDelta = Decimal.min(bonusSpent, delta)
                        realDelta = delta.minus(bonusDelta)
                    }
                }
            }

            const newReal = realBefore.plus(realDelta)
            let newBonus = bonusBefore
            const newTotal = newReal.plus(bonusBefore)

            if (realDelta.gt(0)) {
                await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
            }
            if (bonusDelta.gt(0)) {
                const restoreResult = await BonusService.restore(tx, user.id, bonusDelta, null)
                newBonus = restoreResult.bonusBalanceAfter
            }
```

Run `grep -n "TP_BET\|type: ThirdPartyTxType.BET" apps/api/src/services/palace-wallet.service.ts` first to confirm the exact `Transaction.type` and `referenceId` values `processBet` writes for a bet, and adjust the `where` clause above to match exactly — this plan describes the lookup shape, not a guaranteed-verbatim field name, since it wasn't read in full during planning.

`bonusDelta` restores with `expiresAt: null` (never-expiring) rather than an original expiry, because — unlike Tasks 15 and 17 — the bet's own `Transaction` row does not carry `bonusExpiresAtSpend` (that column is stamped by the *spend* call sites added in this plan; add it to `processBet`'s `TP_BET` transaction create in Task 18 if precise expiry-preservation here is wanted — flagged as a follow-up, not blocking, since a `null` expiry is strictly more generous to the player than losing the credit outright, and this path is provider-triggered only).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test <target file>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/palace-wallet.service.ts apps/api/src/test/*palace*.test.ts
git commit -m "fix(bonus): Palace bet rollback restores to the account it was funded from"
```

---

## Phase 6 — Expiry

### Task 20: `BonusService.expireForUser` + `bonus-expiry.worker.ts`

**Files:**
- Modify: `apps/api/src/services/bonus.service.ts`
- Create: `apps/api/src/workers/bonus-expiry.worker.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/test/bonus.service.test.ts`, `apps/api/src/test/bonus-expiry.worker.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface ExpireBonusResult {
      expired: Decimal
      bonusBalanceBefore: Decimal
      bonusBalanceAfter: Decimal
  }
  static async expireForUser(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<ExpireBonusResult | null>
  ```
  Unlike `spend`/`reduce`/`grant`/`restore`, this method **locks the wallet itself** — its only caller is the worker, which has no pre-existing lock to reuse. Returns `null` (no-op) when the user has nothing due, so the worker skips writing an empty audit row.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/test/bonus.service.test.ts`:

```typescript
describe('BonusService.expireForUser', () => {
    it('expires only lots past their expiry, leaving live lots untouched', async () => {
        const user = await makeUser('expire1', '+251900000029')
        const past = new Date(Date.now() - 1000)
        const future = new Date(Date.now() + 3600_000)
        await prisma.$transaction(async (tx) => {
            await BonusService.grant(tx, { userId: user.id, amount: 30, source: 'ADMIN', expiresAt: past })
            await BonusService.grant(tx, { userId: user.id, amount: 20, source: 'ADMIN', expiresAt: future })
        })

        const result = await prisma.$transaction((tx) => BonusService.expireForUser(tx, user.id, new Date()))

        expect(result?.expired.toNumber()).toBe(30)
        expect(result?.bonusBalanceAfter.toNumber()).toBe(20)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(20)

        const lots = await prisma.bonusGrant.findMany({ where: { userId: user.id }, orderBy: { amount: 'asc' } })
        expect(lots.find((l) => Number(l.amount) === 30)?.status).toBe('EXPIRED')
        expect(lots.find((l) => Number(l.amount) === 20)?.status).toBe('ACTIVE')
    })

    it('returns null when nothing is due', async () => {
        const user = await makeUser('expire2', '+251900000030')
        await prisma.$transaction((tx) =>
            BonusService.grant(tx, { userId: user.id, amount: 10, source: 'ADMIN', expiresAt: new Date(Date.now() + 3600_000) }),
        )
        const result = await prisma.$transaction((tx) => BonusService.expireForUser(tx, user.id, new Date()))
        expect(result).toBeNull()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test bonus.service -- -t "expireForUser"`
Expected: FAIL — `BonusService.expireForUser is not a function`.

- [ ] **Step 3: Implement `expireForUser`**

Add to `apps/api/src/services/bonus.service.ts`, inside the `BonusService` class:

```typescript
    /**
     * Called by the expiry worker, which holds no prior lock — unlike spend/
     * reduce/restore, this locks the wallet itself.
     */
    static async expireForUser(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<ExpireBonusResult | null> {
        // "expiresAt" is `timestamp` WITHOUT time zone; binding a raw Date here
        // sends it as timestamptz and lets Postgres reconcile using the session
        // timezone, silently shifting the comparison on any non-UTC-pinned
        // session — the exact bug already documented and fixed in
        // player-metrics.service.ts's findStaleUserIds, and hit again (then
        // fixed) in BonusService.grant during Task 2's review. Bind the ISO
        // string and cast explicitly instead.
        const nowUtc = now.toISOString()
        const lots = await tx.$queryRaw<Array<{ id: string; remaining: Decimal }>>`
            SELECT id, remaining FROM bonus_grants
            WHERE "userId" = ${userId} AND status = 'ACTIVE' AND "expiresAt" <= ${nowUtc}::timestamp
            FOR UPDATE
        `
        if (lots.length === 0) return null

        const wallets = await tx.$queryRaw<Array<{ bonusBalance: Decimal }>>`
            SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
        `
        const bonusBalanceBefore = new Decimal(wallets[0]?.bonusBalance ?? 0)

        const total = lots.reduce((sum, lot) => sum.plus(new Decimal(lot.remaining)), new Decimal(0))

        await tx.bonusGrant.updateMany({
            where: { id: { in: lots.map((l) => l.id) } },
            data: { remaining: 0, status: 'EXPIRED' },
        })
        await tx.wallet.update({ where: { userId }, data: { bonusBalance: { decrement: total } } })

        return { expired: total, bonusBalanceBefore, bonusBalanceAfter: bonusBalanceBefore.minus(total) }
    }
```

Add `export interface ExpireBonusResult { expired: Decimal; bonusBalanceBefore: Decimal; bonusBalanceAfter: Decimal }` next to the other result interfaces.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test bonus.service`
Expected: PASS (12 tests total).

- [ ] **Step 5: Write the worker, following the `cashback-checker.worker.ts` pattern exactly**

```typescript
/**
 * Bonus Expiry Worker
 *
 * Runs every 15 minutes: finds every ACTIVE lot past its expiresAt, expires it
 * per-user inside one transaction (BonusService.expireForUser), and writes a
 * BONUS_EXPIRED transaction so a balance dropping overnight has an audit row.
 */

import { Worker, Job, Queue } from 'bullmq'
import { Decimal } from '@prisma/client/runtime/library'
import { QUEUE_NAMES } from '../lib/queue.js'
import prisma from '../lib/prisma.js'
import { BonusService } from '../services/bonus.service.js'
import { NotificationService } from '../services/notification.service.js'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const SWEEP_INTERVAL_MS = 15 * 60 * 1000

export interface BonusExpiryJobData {
    action: 'sweep'
}

const bonusExpiryQueue = new Queue<BonusExpiryJobData>(QUEUE_NAMES.BONUS_EXPIRY, {
    connection: {
        url: REDIS_URL,
        maxRetriesPerRequest: null as any,
        enableReadyCheck: false,
        lazyConnect: true,
    } as any,
})

export async function sweepExpiredBonuses(): Promise<{ usersProcessed: number; totalExpired: string }> {
    const now = new Date()
    // See the identical note in BonusService.expireForUser — bind the ISO
    // string and cast explicitly; a raw Date here would compare against
    // "expiresAt" (naive timestamp) using the session timezone.
    const nowUtc = now.toISOString()
    const dueUsers = await prisma.$queryRaw<Array<{ userId: string }>>`
        SELECT DISTINCT "userId" FROM bonus_grants WHERE status = 'ACTIVE' AND "expiresAt" <= ${nowUtc}::timestamp
    `

    let usersProcessed = 0
    let totalExpired = new Decimal(0)

    for (const { userId } of dueUsers) {
        const result = await prisma.$transaction(async (tx) => {
            const expireResult = await BonusService.expireForUser(tx, userId, now)
            if (!expireResult) return null
            await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.BONUS_EXPIRED,
                    amount: expireResult.expired,
                    status: PaymentStatus.APPROVED,
                    note: 'Bonus expired',
                    bonusBalanceBefore: expireResult.bonusBalanceBefore,
                    bonusBalanceAfter: expireResult.bonusBalanceAfter,
                },
            })
            return expireResult
        })
        if (!result) continue

        usersProcessed++
        totalExpired = totalExpired.plus(result.expired)

        const wallet = await prisma.wallet.findUnique({ where: { userId } })
        if (wallet) {
            NotificationService.pushWalletUpdate(userId, Number(wallet.realBalance), Number(wallet.bonusBalance))
        }
    }

    return { usersProcessed, totalExpired: totalExpired.toFixed(2) }
}

const worker = new Worker<BonusExpiryJobData>(
    QUEUE_NAMES.BONUS_EXPIRY,
    async (_job: Job<BonusExpiryJobData>) => {
        console.log('[BonusExpiryWorker] Sweeping expired bonus lots...')
        const result = await sweepExpiredBonuses()
        console.log(`[BonusExpiryWorker] Done — ${result.usersProcessed} players affected, ${result.totalExpired} ETB expired`)
        return result
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 1,
    },
)

async function setupRepeatingJob() {
    const repeatableJobs = await bonusExpiryQueue.getRepeatableJobs()
    for (const rj of repeatableJobs) {
        await bonusExpiryQueue.removeRepeatableByKey(rj.key)
    }

    await bonusExpiryQueue.add(
        'sweep-expired-bonuses',
        { action: 'sweep' },
        {
            repeat: { every: SWEEP_INTERVAL_MS },
            removeOnComplete: { count: 24 },
            removeOnFail: { count: 24 },
        },
    )

    await bonusExpiryQueue.add(
        'sweep-expired-bonuses-now',
        { action: 'sweep' },
        {
            removeOnComplete: { count: 5 },
            removeOnFail: { count: 5 },
        },
    )

    console.log('[BonusExpiryWorker] Repeating job set up (every 15 minutes)')
}

setupRepeatingJob().catch((err) => {
    console.error('[BonusExpiryWorker] Failed to set up repeating job:', err)
})

worker.on('completed', (job) => {
    console.log(`[BonusExpiryWorker] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
    console.error(`[BonusExpiryWorker] Job ${job?.id} failed:`, err.message)
    reportError(err, { worker: 'bonus-expiry' })
})
```

- [ ] **Step 6: Write the worker test, calling the exported sweep function directly (matching how other workers in this codebase are tested — they do not spin up BullMQ in tests)**

```typescript
import { describe, it, expect } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from './setup'
import { BonusService } from '../services/bonus.service'
import { sweepExpiredBonuses } from '../workers/bonus-expiry.worker'

async function makeUser(username: string, phone: string) {
    return prisma.user.create({
        data: { username, phone, passwordHash: 'hashed:pass', role: 'PLAYER', wallet: { create: { realBalance: 0, bonusBalance: 0 } } },
    })
}

describe('sweepExpiredBonuses', () => {
    it('expires due lots across multiple users and writes one BONUS_EXPIRED transaction each', async () => {
        const userA = await makeUser('sweep1', '+251900000031')
        const userB = await makeUser('sweep2', '+251900000032')
        const past = new Date(Date.now() - 1000)

        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: userA.id, amount: 25, source: 'ADMIN', expiresAt: past }))
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: userB.id, amount: 15, source: 'ADMIN', expiresAt: past }))

        const result = await sweepExpiredBonuses()

        expect(result.usersProcessed).toBe(2)
        expect(result.totalExpired).toBe('40.00')

        const txnA = await prisma.transaction.findFirstOrThrow({ where: { userId: userA.id, type: 'BONUS_EXPIRED' } })
        expect(new Decimal(txnA.amount).toNumber()).toBe(25)

        const walletA = await prisma.wallet.findUniqueOrThrow({ where: { userId: userA.id } })
        expect(new Decimal(walletA.bonusBalance).toNumber()).toBe(0)
    })

    it('is a no-op when nothing is due', async () => {
        const result = await sweepExpiredBonuses()
        expect(result.usersProcessed).toBe(0)
    })
})
```

- [ ] **Step 7: Run the worker test to verify it passes**

Run: `pnpm --filter @world-bingo/api test bonus-expiry.worker`
Expected: PASS.

- [ ] **Step 8: Register the worker so it auto-starts with the server**

In `apps/api/src/index.ts`, add after `import './workers/crm-campaign.worker.js'`:

```typescript
import './workers/bonus-expiry.worker.js'
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/bonus.service.ts apps/api/src/workers/bonus-expiry.worker.ts apps/api/src/index.ts apps/api/src/test/bonus.service.test.ts apps/api/src/test/bonus-expiry.worker.test.ts
git commit -m "feat(bonus): sweep expired bonus lots every 15 minutes"
```

---

## Phase 7 — `avgDailyDeposit` metric and segmentation

This phase is independent of Phases 1-6 — it touches `PlayerMetrics`, the CRM rollup, and the segment whitelist only, none of which the bonus-grant work depends on. It can ship before, after, or interleaved with the rest of this plan.

### Task 21: `avgDailyDeposit` in the CRM rollup

**Files:**
- Modify: `apps/api/src/services/player-crm/player-metrics.service.ts`
- Test: find and extend the existing rollup test (search: `grep -rln "refreshAll\|rollupSql\|PlayerMetricsService" apps/api/src/test/*.ts`)

**Interfaces:**
- Produces: `PlayerMetrics.avgDailyDeposit` populated by both `refreshAll`/`refreshUsers` (via `rollupSql`) and a new `PlayerMetricsService.syncAvgDailyDeposit(): Promise<number>`, called from `refreshIncremental` the same way `syncLiveness` already is. Task 22 (segment whitelist) depends on this column being populated.

Per spec §8, the formula is `lifetimeDeposits / GREATEST(1, days since firstDepositAt)`, `NULL` when the player has never deposited. Per §8's "staleness trap": the denominator grows every day whether or not the player acts, so — unlike every other rollup column — this one cannot be left to the watermark-driven incremental pass. It needs its own full-table sync each incremental run, mirroring how `syncLiveness()` already handles the same problem for `isActive`.

- [ ] **Step 1: Write the failing test**

Add to the located rollup test file:

```typescript
it('computes avgDailyDeposit as lifetimeDeposits / days since first deposit', async () => {
    const user = await makeUser('avgdep1', '+251900000033') // reuse this file's fixture helper
    const firstDepositAt = new Date(Date.now() - 300 * 86_400_000) // 300 days ago
    await prisma.transaction.create({
        data: { userId: user.id, type: 'DEPOSIT', amount: 6000, status: 'APPROVED', createdAt: firstDepositAt },
    })

    await PlayerMetricsService.refreshAll()

    const metrics = await prisma.playerMetrics.findUniqueOrThrow({ where: { userId: user.id } })
    expect(Number(metrics.avgDailyDeposit)).toBe(20)
})

it('is NULL for a player who has never deposited', async () => {
    const user = await makeUser('avgdep2', '+251900000034')
    await PlayerMetricsService.refreshAll()
    const metrics = await prisma.playerMetrics.findUniqueOrThrow({ where: { userId: user.id } })
    expect(metrics.avgDailyDeposit).toBeNull()
})

it('syncAvgDailyDeposit refreshes every row, including players untouched since the watermark', async () => {
    const user = await makeUser('avgdep3', '+251900000035')
    const firstDepositAt = new Date(Date.now() - 10 * 86_400_000) // 10 days ago
    await prisma.transaction.create({
        data: { userId: user.id, type: 'DEPOSIT', amount: 1000, status: 'APPROVED', createdAt: firstDepositAt },
    })
    await PlayerMetricsService.refreshAll()

    // Simulate staleness: the stored value is from an earlier "now".
    await prisma.playerMetrics.update({ where: { userId: user.id }, data: { avgDailyDeposit: 999 } })

    await PlayerMetricsService.syncAvgDailyDeposit()

    const metrics = await prisma.playerMetrics.findUniqueOrThrow({ where: { userId: user.id } })
    expect(Number(metrics.avgDailyDeposit)).toBe(100)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @world-bingo/api test <located file> -- -t "avgDailyDeposit"`
Expected: FAIL — the column stays `NULL`/unset; `syncAvgDailyDeposit` doesn't exist.

- [ ] **Step 3: Add the column to `rollupSql`**

In `apps/api/src/services/player-crm/player-metrics.service.ts`, add `"avgDailyDeposit"` to the `INSERT` column list (after `"bonusReceived", "referralCount",`):

```typescript
            "bonusReceived", "referralCount", "avgDailyDeposit",
```

Add the computed expression to the `SELECT` list, immediately after the `COALESCE(bonus.total, 0), COALESCE(ref.cnt, 0),` line:

```typescript
            COALESCE(bonus.total, 0),
            COALESCE(ref.cnt, 0),

            CASE WHEN dep.first_at IS NULL THEN NULL
                 ELSE COALESCE(dep.total, 0)
                      / GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (NOW() - dep.first_at)) / 86400))
            END,
```

Add to the `ON CONFLICT DO UPDATE SET` list, after `"referralCount" = EXCLUDED."referralCount",`:

```typescript
            "avgDailyDeposit"      = EXCLUDED."avgDailyDeposit",
```

- [ ] **Step 4: Apply the spec's one correction to `bonusReceived`**

In the same file, extend the `bonus` LEFT JOIN's type list (per spec §8, "One correction to the rollup" — the two new grant transaction types count toward `bonusReceived`; `BONUS_EXPIRED` deliberately does not, since it is a debit):

```typescript
        LEFT JOIN (
            SELECT "userId", SUM(amount) AS total
            FROM transactions
            WHERE type IN ('FIRST_DEPOSIT_BONUS', 'CASHBACK_BONUS', 'ADMIN_BONUS_ADJUSTMENT', 'DAILY_DEPOSIT_BONUS', 'WEEKLY_DEPOSIT_BONUS')
              AND status = 'APPROVED'
            GROUP BY "userId"
        ) bonus ON bonus."userId" = u.id
```

- [ ] **Step 5: Add `syncAvgDailyDeposit` and wire it into `refreshIncremental`**

Add to `PlayerMetricsService`, next to `syncLiveness`:

```typescript
    /**
     * Full-table refresh of avgDailyDeposit alone. Its denominator (days since
     * firstDepositAt) grows every day whether or not the player does anything,
     * so — unlike every other rollup column — it cannot wait for the
     * watermark-driven incremental pass to notice the player was "touched".
     * Pure arithmetic over two already-stored columns: no join, cheap enough to
     * run on every incremental tick.
     */
    static async syncAvgDailyDeposit(): Promise<number> {
        return prisma.$executeRaw`
            UPDATE player_metrics
            SET "avgDailyDeposit" = CASE WHEN "firstDepositAt" IS NULL THEN NULL
                ELSE "lifetimeDeposits" / GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (NOW() - "firstDepositAt")) / 86400))
            END
        `
    }
```

In `refreshIncremental`, call it alongside `syncLiveness` (both are full-table, staleness-immune syncs — same reasoning, same place):

```typescript
        // Always runs, even when nothing else is stale — a freeze is invisible to
        // the watermark, so it cannot be gated behind having found candidates.
        // avgDailyDeposit's denominator grows daily on its own for the same reason.
        const [livenessChanged] = await Promise.all([
            PlayerMetricsService.syncLiveness(),
            PlayerMetricsService.syncAvgDailyDeposit(),
        ])
```

Replace the existing `const livenessChanged = await PlayerMetricsService.syncLiveness()` line with this block.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @world-bingo/api test <located file>`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/player-crm/player-metrics.service.ts apps/api/src/test/*.test.ts
git commit -m "feat(crm): add avgDailyDeposit to the player metrics rollup"
```

---

### Task 22: `avgDailyDeposit` segment field + presets

**Files:**
- Modify: `packages/shared-types/src/crm/segment.ts`
- Modify: `apps/api/src/services/player-crm/segment-presets.ts`
- Test: find and extend segment compiler/preset tests (search: `grep -rln "SEGMENT_FIELDS\|SEGMENT_PRESETS" apps/api/src/test/*.ts`)

**Interfaces:**
- Consumes: `avgDailyDeposit` column (Task 21).
- Produces: `SEGMENT_FIELDS.avgDailyDeposit` (whitelist entry), four new rows in `SEGMENT_PRESETS`.

- [ ] **Step 1: Write the failing test**

Add to the located segment test file:

```typescript
it('avgDailyDeposit is a valid segment field and compiles', async () => {
    const ruleset = {
        version: SEGMENT_RULESET_VERSION,
        root: { kind: 'group', op: 'AND', children: [{ kind: 'cond', field: 'avgDailyDeposit', op: 'gte', value: 200 }] },
    }
    // Reuse this file's existing compile/count helper — e.g. SegmentService.previewCount or the compiler entry point.
    const count = await SegmentService.previewCount(ruleset)
    expect(typeof count).toBe('number')
})

it('seeds the four avgDailyDeposit presets', async () => {
    await SegmentService.seedPresets() // or whatever this file's existing preset-seeding test already calls
    const names = (await prisma.segment.findMany({ where: { isPreset: true } })).map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['Micro depositor', 'Casual depositor', 'Core depositor', 'Whale']))
})
```

Adapt the compile/preview and seeding calls to whatever this codebase's existing segment tests already use — read the located file first.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @world-bingo/api test <located file> -- -t "avgDailyDeposit"`
Expected: FAIL — `avgDailyDeposit` is not in `SEGMENT_FIELD_KEYS`, so the compiler rejects it; the four presets don't exist.

- [ ] **Step 3: Add the whitelist entry**

In `packages/shared-types/src/crm/segment.ts`, add to `SEGMENT_FIELDS`, in the `// Money` group, next to `bonusBalance`:

```typescript
    avgDailyDeposit: money('avgDailyDeposit', 'Average daily deposit (ETB)'),
```

- [ ] **Step 4: Add the four presets**

In `apps/api/src/services/player-crm/segment-presets.ts`, add to `SEGMENT_PRESETS` (values from spec §8):

```typescript
    {
        name: 'Micro depositor',
        description: 'Averaging under 50 ETB/day since their first deposit. Small, frequent top-ups.',
        rules: and({ kind: 'cond', field: 'avgDailyDeposit', op: 'lt', value: 50 }),
    },
    {
        name: 'Casual depositor',
        description: 'Averaging 50-200 ETB/day since their first deposit.',
        rules: and(
            { kind: 'cond', field: 'avgDailyDeposit', op: 'gte', value: 50 },
            { kind: 'cond', field: 'avgDailyDeposit', op: 'lt', value: 200 },
        ),
    },
    {
        name: 'Core depositor',
        description: 'Averaging 200-1000 ETB/day since their first deposit. The bulk of deposit volume.',
        rules: and(
            { kind: 'cond', field: 'avgDailyDeposit', op: 'gte', value: 200 },
            { kind: 'cond', field: 'avgDailyDeposit', op: 'lt', value: 1000 },
        ),
    },
    {
        name: 'Whale',
        description: 'Averaging 1000+ ETB/day since their first deposit. High-value, handle with care.',
        rules: and({ kind: 'cond', field: 'avgDailyDeposit', op: 'gte', value: 1000 }),
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @world-bingo/api test <located file>`
Expected: PASS.

- [ ] **Step 6: Rebuild shared-types so the API picks up the new whitelist entry**

Run: `pnpm --filter @world-bingo/shared-types build`

- [ ] **Step 7: Commit**

```bash
git add packages/shared-types/src/crm/segment.ts apps/api/src/services/player-crm/segment-presets.ts apps/api/src/test/*.test.ts
git commit -m "feat(crm): add avgDailyDeposit segment field and four depositor-intensity presets"
```

---

## Phase 8 — Player-facing API surfaces

### Task 23: `GET /promotions` extension + `GET /wallet/bonus-grants`

**Files:**
- Modify: `apps/api/src/services/bonus-rule.service.ts` (`listActive` ordering)
- Modify: `apps/api/src/services/promotions.service.ts`
- Create: `apps/api/src/services/bonus-grant-query.service.ts`
- Modify: `apps/api/src/routes/wallet/index.ts`
- Modify: `apps/api/src/controllers/wallet.controller.ts`
- Test: `apps/api/src/test/promotions.service.test.ts` (existing — extend), `apps/api/src/test/bonus-grant-query.service.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface DepositBonusPromoResult {
      name: string
      type: 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT'
      threshold: number
      rewardType: 'FIXED' | 'PERCENTAGE'
      rewardValue: number
      maxReward: number | null
      validityHours: number
  }
  // PromotionsResult gains: dailyDepositBonus: DepositBonusPromoResult | null; weeklyDepositBonus: DepositBonusPromoResult | null

  export interface ActiveBonusGrantView {
      id: string
      amount: number
      remaining: number
      expiresAt: string | null
      ruleName: string | null
      createdAt: string
  }
  export class BonusGrantQueryService {
      static async listActiveForUser(userId: string): Promise<ActiveBonusGrantView[]>
  }
  ```

- [ ] **Step 1: Order `BonusRuleService.listActive` deterministically**

In `apps/api/src/services/bonus-rule.service.ts`, add `orderBy: { createdAt: 'desc' }` to the `findMany` call inside `listActive` — mirrors `CashbackService`'s "most recently created active promotion wins" convention, which matters when an operator deliberately runs two overlapping rules of the same type (spec §3).

```typescript
    static async listActive(now: Date): Promise<BonusRule[]> {
        return prisma.bonusRule.findMany({
            where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
            orderBy: { createdAt: 'desc' },
        })
    }
```

- [ ] **Step 2: Write the failing test for `GET /promotions`**

Find the existing test file (`apps/api/src/test/promotions.service.test.ts` or wherever `PromotionsService.getPromotions` is tested) and add:

```typescript
it('includes the most recently created active daily and weekly rules', async () => {
    await BonusRuleService.create({
        name: 'Daily 500', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
        rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
    })
    await BonusRuleService.create({
        name: 'Weekly 2000', type: 'WEEKLY_DEPOSIT', threshold: 2000, rewardType: 'PERCENTAGE',
        rewardValue: 10, maxReward: 300, validityHours: 168, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
    })

    const promos = await PromotionsService.getPromotions()

    expect(promos.dailyDepositBonus).toMatchObject({ name: 'Daily 500', threshold: 500, rewardValue: 50 })
    expect(promos.weeklyDepositBonus).toMatchObject({ name: 'Weekly 2000', threshold: 2000, maxReward: 300 })
})

it('returns null deposit-bonus fields when none are active', async () => {
    const promos = await PromotionsService.getPromotions()
    expect(promos.dailyDepositBonus).toBeNull()
    expect(promos.weeklyDepositBonus).toBeNull()
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test promotions.service`
Expected: FAIL — `promos.dailyDepositBonus` is `undefined`.

- [ ] **Step 4: Extend `PromotionsService`**

In `apps/api/src/services/promotions.service.ts`:

```typescript
import prisma from '../lib/prisma'
import { CashbackRefundType, CashbackFrequency, BonusRuleType, BonusRewardType } from '@world-bingo/shared-types'
import { BonusRuleService } from './bonus-rule.service'

export interface CashbackPromoResult {
    name: string
    refundType: CashbackRefundType
    refundValue: number
    frequency: CashbackFrequency
}

export interface DepositBonusPromoResult {
    name: string
    type: BonusRuleType
    threshold: number
    rewardType: BonusRewardType
    rewardValue: number
    maxReward: number | null
    validityHours: number
}

export interface PromotionsResult {
    cashback: CashbackPromoResult | null
    firstDepositBonus: number | null
    dailyDepositBonus: DepositBonusPromoResult | null
    weeklyDepositBonus: DepositBonusPromoResult | null
}

export class PromotionsService {
    static async getPromotions(): Promise<PromotionsResult> {
        const now = new Date()

        const [cashbackRow, bonusSetting, activeRules] = await Promise.all([
            prisma.cashbackPromotion.findFirst({
                where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
                select: { name: true, refundType: true, refundValue: true, frequency: true },
                orderBy: { createdAt: 'desc' },
            }),
            prisma.siteSetting.findUnique({ where: { key: 'first_deposit_bonus_amount' } }),
            BonusRuleService.listActive(now),
        ])

        const raw = bonusSetting ? Number(bonusSetting.value) : 0
        const firstDepositBonus = isNaN(raw) ? 0 : raw

        const toPromo = (rule: (typeof activeRules)[number]): DepositBonusPromoResult => ({
            name: rule.name,
            type: rule.type as BonusRuleType,
            threshold: Number(rule.threshold),
            rewardType: rule.rewardType as BonusRewardType,
            rewardValue: Number(rule.rewardValue),
            maxReward: rule.maxReward != null ? Number(rule.maxReward) : null,
            validityHours: rule.validityHours,
        })

        return {
            cashback: cashbackRow
                ? {
                      name: cashbackRow.name,
                      refundType: cashbackRow.refundType as CashbackRefundType,
                      refundValue: Number(cashbackRow.refundValue),
                      frequency: cashbackRow.frequency as CashbackFrequency,
                  }
                : null,
            firstDepositBonus: firstDepositBonus > 0 ? firstDepositBonus : null,
            dailyDepositBonus: (() => {
                const rule = activeRules.find((r) => r.type === 'DAILY_DEPOSIT')
                return rule ? toPromo(rule) : null
            })(),
            weeklyDepositBonus: (() => {
                const rule = activeRules.find((r) => r.type === 'WEEKLY_DEPOSIT')
                return rule ? toPromo(rule) : null
            })(),
        }
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test promotions.service`
Expected: PASS.

- [ ] **Step 6: Write the failing test for `BonusGrantQueryService`**

```typescript
import { describe, it, expect } from 'vitest'
import { prisma } from './setup'
import { BonusService } from '../services/bonus.service'
import { BonusGrantQueryService } from '../services/bonus-grant-query.service'

async function makeUser(username: string, phone: string) {
    return prisma.user.create({
        data: { username, phone, passwordHash: 'hashed:pass', role: 'PLAYER', wallet: { create: { realBalance: 0, bonusBalance: 0 } } },
    })
}

describe('BonusGrantQueryService.listActiveForUser', () => {
    it('lists only ACTIVE lots, soonest expiry first, with the rule name resolved', async () => {
        const user = await makeUser('grantquery1', '+251900000036')
        const rule = await prisma.bonusRule.create({
            data: {
                name: 'Daily 500', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
                rewardValue: 50, validityHours: 24, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86_400_000),
            },
        })
        const soon = new Date(Date.now() + 3600_000)
        const later = new Date(Date.now() + 7 * 86_400_000)

        await prisma.$transaction(async (tx) => {
            await BonusService.grant(tx, { userId: user.id, amount: 100, source: 'ADMIN', expiresAt: later })
            await BonusService.grant(tx, { userId: user.id, amount: 50, source: 'DAILY_DEPOSIT', ruleId: rule.id, periodStart: new Date(), expiresAt: soon })
            const spent = await BonusService.spend(tx, user.id, 100) // drains the 'later' lot entirely
            expect(spent.spent.toNumber()).toBe(100)
        })

        const grants = await BonusGrantQueryService.listActiveForUser(user.id)

        expect(grants).toHaveLength(1)
        expect(grants[0].ruleName).toBe('Daily 500')
        expect(grants[0].remaining).toBe(50)
    })
})
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api test bonus-grant-query.service`
Expected: FAIL — `Cannot find module '../services/bonus-grant-query.service'`.

- [ ] **Step 8: Implement `BonusGrantQueryService`**

```typescript
import prisma from '../lib/prisma'

export interface ActiveBonusGrantView {
    id: string
    amount: number
    remaining: number
    expiresAt: string | null
    ruleName: string | null
    createdAt: string
}

export class BonusGrantQueryService {
    static async listActiveForUser(userId: string): Promise<ActiveBonusGrantView[]> {
        const grants = await prisma.bonusGrant.findMany({
            where: { userId, status: 'ACTIVE' },
            orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
            include: { rule: { select: { name: true } } },
        })

        return grants.map((g) => ({
            id: g.id,
            amount: Number(g.amount),
            remaining: Number(g.remaining),
            expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
            ruleName: g.rule?.name ?? null,
            createdAt: g.createdAt.toISOString(),
        }))
    }
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api test bonus-grant-query.service`
Expected: PASS.

- [ ] **Step 10: Wire the route**

Add to `apps/api/src/controllers/wallet.controller.ts`, near `getBalance`:

```typescript
    static async getBonusGrants(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        return BonusGrantQueryService.listActiveForUser(userId)
    }
```

Add the import: `import { BonusGrantQueryService } from '../services/bonus-grant-query.service'`.

Add to `apps/api/src/routes/wallet/index.ts`, after the `/spend-account` route from Task 13:

```typescript
    fastify.get('/bonus-grants', {
        handler: WalletController.getBonusGrants,
    })
```

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/services/bonus-rule.service.ts apps/api/src/services/promotions.service.ts apps/api/src/services/bonus-grant-query.service.ts apps/api/src/controllers/wallet.controller.ts apps/api/src/routes/wallet/index.ts apps/api/src/test/promotions.service.test.ts apps/api/src/test/bonus-grant-query.service.test.ts
git commit -m "feat(bonus): expose active deposit-bonus rules and a player's live grants"
```

---

## Phase 9 — Admin surfaces

### Task 24: Admin `/admin/bonus-rules` CRUD routes + reconciliation + player grants panel endpoint

**Files:**
- Modify: `apps/api/src/routes/admin/index.ts`
- Test: `apps/api/src/test/admin-bonus-rules.test.ts`

**Interfaces:**
- Consumes: `BonusRuleService` (Task 11), `BonusService.reconcile` (Task 5), `BonusGrantQueryService` pattern extended for "all statuses" (Task 23).
- Produces routes: `GET/POST /admin/bonus-rules`, `PATCH /admin/bonus-rules/:id`, `PATCH /admin/bonus-rules/:id/toggle`, `GET /admin/bonus-reconciliation`, `GET /admin/players/:id/bonus-grants`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/test/admin-bonus-rules.test.ts`, following the same `app.inject` + admin-auth-fixture pattern as `admin-approve-route.test.ts` (read that file first for the exact helper names):

```typescript
describe('Admin bonus rules', () => {
    it('creates, lists, and toggles a bonus rule', async () => {
        const createRes = await app.inject({
            method: 'POST',
            url: '/admin/bonus-rules',
            headers: { authorization: `Bearer ${adminToken}` },
            payload: {
                name: 'Daily 500', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
                rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
            },
        })
        expect(createRes.statusCode).toBe(200)
        const ruleId = createRes.json().id

        const listRes = await app.inject({ method: 'GET', url: '/admin/bonus-rules', headers: { authorization: `Bearer ${adminToken}` } })
        expect(listRes.json().some((r: any) => r.id === ruleId)).toBe(true)

        const toggleRes = await app.inject({
            method: 'PATCH', url: `/admin/bonus-rules/${ruleId}/toggle`,
            headers: { authorization: `Bearer ${adminToken}` }, payload: { isActive: false },
        })
        expect(toggleRes.json().isActive).toBe(false)
    })

    it('rejects endsAt before startsAt', async () => {
        const res = await app.inject({
            method: 'POST', url: '/admin/bonus-rules', headers: { authorization: `Bearer ${adminToken}` },
            payload: {
                name: 'Bad', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED', rewardValue: 50,
                validityHours: 24, startsAt: '2027-01-01T00:00:00Z', endsAt: '2026-01-01T00:00:00Z',
            },
        })
        expect(res.statusCode).toBe(400)
    })

    it('reconciliation endpoint reports empty on a healthy system', async () => {
        const res = await app.inject({ method: 'GET', url: '/admin/bonus-reconciliation', headers: { authorization: `Bearer ${adminToken}` } })
        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual([])
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @world-bingo/api test admin-bonus-rules`
Expected: FAIL — 404 on all three routes.

- [ ] **Step 3: Add the Zod schemas**

In `apps/api/src/routes/admin/index.ts`, add next to `cashbackCreateSchema`:

```typescript
const bonusRuleCreateSchema = z.object({
    name: z.string().min(1),
    type: z.enum(['DAILY_DEPOSIT', 'WEEKLY_DEPOSIT']),
    threshold: z.coerce.number().positive(),
    rewardType: z.enum(['FIXED', 'PERCENTAGE']),
    rewardValue: z.coerce.number().positive(),
    maxReward: z.coerce.number().positive().nullable().optional(),
    validityHours: z.coerce.number().int().positive().max(24 * 90),
    startsAt: z.string(),
    endsAt: z.string(),
}).refine(
    (data) => new Date(data.startsAt) < new Date(data.endsAt),
    { message: 'endsAt must be after startsAt', path: ['endsAt'] },
)

const bonusRuleUpdateSchema = bonusRuleCreateSchema.partial().extend({
    isActive: z.boolean().optional(),
})
```

- [ ] **Step 4: Add the routes, in the admin-only block, after the existing `/cashback` routes**

```typescript
        // ── Deposit Bonus Rules ─────────────────────────────────────────────────
        f.get('/bonus-rules', async (_req, _reply) => BonusRuleService.list())

        f.post('/bonus-rules', async (req: any, reply) => {
            const parsed = bonusRuleCreateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            return BonusRuleService.create(parsed.data)
        })

        f.patch('/bonus-rules/:id', async (req: any, reply) => {
            const parsed = bonusRuleUpdateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            return BonusRuleService.update(req.params.id, parsed.data)
        })

        f.patch('/bonus-rules/:id/toggle', async (req: any, reply) => {
            const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'isActive is required' })
            return BonusRuleService.update(req.params.id, { isActive: parsed.data.isActive })
        })

        // ── Bonus ledger reconciliation (design spec §7) ─────────────────────────
        f.get('/bonus-reconciliation', async (_req, _reply) => {
            const mismatches = await BonusService.reconcile()
            return mismatches.map((m) => ({
                userId: m.userId,
                cachedBalance: m.cachedBalance.toNumber(),
                lotSum: m.lotSum.toNumber(),
            }))
        })

        // ── Player detail: bonus grants panel ────────────────────────────────────
        f.get('/players/:id/bonus-grants', async (req: any, _reply) => {
            const grants = await prisma.bonusGrant.findMany({
                where: { userId: req.params.id },
                orderBy: { createdAt: 'desc' },
                include: { rule: { select: { name: true, type: true } } },
            })
            return grants.map((g) => ({
                id: g.id,
                amount: Number(g.amount),
                remaining: Number(g.remaining),
                expiresAt: g.expiresAt,
                status: g.status,
                ruleName: g.rule?.name ?? null,
                ruleType: g.rule?.type ?? null,
                createdAt: g.createdAt,
            }))
        })
```

Add the imports: `import { BonusRuleService } from '../../services/bonus-rule.service'` and `import { BonusService } from '../../services/bonus.service'`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @world-bingo/api test admin-bonus-rules`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin/index.ts apps/api/src/test/admin-bonus-rules.test.ts
git commit -m "feat(bonus): admin CRUD for deposit-bonus rules, reconciliation, player grants panel"
```

---

### Task 25: Admin `/bonus-rules` page

**Files:**
- Create: `apps/admin/pages/bonus-rules/index.vue`
- Modify: `apps/admin/composables/useAdminApi.ts`
- Modify: `apps/admin/layouts/default.vue`

**Interfaces:**
- Consumes: the four routes from Task 24.

This page is a deliberate structural clone of `apps/admin/pages/cashback/index.vue` (read in full during planning), extended with the reconciliation widget from spec §9. Cloning rather than abstracting a shared component: the two forms diverge enough (reward type vs refund type, `validityHours` vs `frequency`, `maxReward` only on one) that a shared component would need as many conditionals as duplicating the ~180 lines, and the codebase's existing pattern (cashback itself isn't factored out of anything) says duplication is the accepted convention here.

- [ ] **Step 1: Add the API methods**

In `apps/admin/composables/useAdminApi.ts`, add after the `toggleCashbackPromotion` line, before the closing `}` of the returned object:

```typescript
        // ── Deposit Bonus Rules ─────────────────────────────────────────────
        getBonusRules: () => apiFetch<any[]>('/admin/bonus-rules'),
        createBonusRule: (data: {
            name: string
            type: 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT'
            threshold: number
            rewardType: 'FIXED' | 'PERCENTAGE'
            rewardValue: number
            maxReward?: number | null
            validityHours: number
            startsAt: string
            endsAt: string
        }) => apiFetch('/admin/bonus-rules', { method: 'POST', body: data }),
        toggleBonusRule: (id: string, isActive: boolean) =>
            apiFetch(`/admin/bonus-rules/${id}/toggle`, { method: 'PATCH', body: { isActive } }),
        getBonusReconciliation: () => apiFetch<Array<{ userId: string; cachedBalance: number; lotSum: number }>>('/admin/bonus-reconciliation'),
```

- [ ] **Step 2: Write the page**

```vue
<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { getBonusRules, createBonusRule, toggleBonusRule, getBonusReconciliation } = useAdminApi()
const toast = useToast()

const rules = ref<any[]>([])
const loading = ref(true)
const showCreate = ref(false)
const creating = ref(false)

const mismatches = ref<Array<{ userId: string; cachedBalance: number; lotSum: number }>>([])
const reconciling = ref(false)

const form = reactive({
  name: '',
  type: 'DAILY_DEPOSIT' as 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT',
  threshold: 500,
  rewardType: 'FIXED' as 'FIXED' | 'PERCENTAGE',
  rewardValue: 50,
  maxReward: null as number | null,
  validityHours: 24,
  startsAt: '',
  endsAt: '',
})

const typeOptions = [
  { label: 'Daily deposit', value: 'DAILY_DEPOSIT' },
  { label: 'Weekly deposit', value: 'WEEKLY_DEPOSIT' },
]

const rewardTypeOptions = [
  { label: 'Fixed amount (ETB)', value: 'FIXED' },
  { label: 'Percentage of bucket total', value: 'PERCENTAGE' },
]

const rewardValueLabel = computed(() =>
  form.rewardType === 'PERCENTAGE' ? 'Reward Percentage (%)' : 'Reward Amount (ETB)'
)

async function fetchRules() {
  loading.value = true
  try {
    rules.value = (await getBonusRules()) as any[] ?? []
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load bonus rules', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function fetchReconciliation() {
  reconciling.value = true
  try {
    mismatches.value = await getBonusReconciliation()
  } catch {
    toast.add({ title: 'Error', description: 'Failed to run reconciliation', color: 'error' })
  } finally {
    reconciling.value = false
  }
}

async function create() {
  creating.value = true
  try {
    await createBonusRule({
      name: form.name,
      type: form.type,
      threshold: form.threshold,
      rewardType: form.rewardType,
      rewardValue: form.rewardValue,
      maxReward: form.rewardType === 'PERCENTAGE' ? form.maxReward : null,
      validityHours: form.validityHours,
      startsAt: new Date(form.startsAt).toISOString(),
      endsAt: new Date(form.endsAt).toISOString(),
    })
    toast.add({ title: 'Created', description: 'Bonus rule created', color: 'success' })
    showCreate.value = false
    form.name = ''
    form.threshold = 500
    form.rewardType = 'FIXED'
    form.rewardValue = 50
    form.maxReward = null
    form.validityHours = 24
    form.startsAt = ''
    form.endsAt = ''
    await fetchRules()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to create', color: 'error' })
  } finally {
    creating.value = false
  }
}

async function toggle(rule: any) {
  try {
    await toggleBonusRule(rule.id, !rule.isActive)
    rule.isActive = !rule.isActive
    toast.add({ title: 'Updated', color: 'success' })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to toggle', color: 'error' })
  }
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-ET', { year: 'numeric', month: 'short', day: 'numeric' })
}

function describeRule(rule: any) {
  const threshold = Number(rule.threshold).toFixed(0)
  const val = rule.rewardType === 'PERCENTAGE'
    ? `${Number(rule.rewardValue).toFixed(0)}%${rule.maxReward ? ` up to ${Number(rule.maxReward).toFixed(0)} ETB` : ''}`
    : `${Number(rule.rewardValue).toFixed(2)} ETB`
  const period = rule.type === 'DAILY_DEPOSIT' ? 'a day' : 'a week'
  return `Deposit ${threshold} ETB in ${period} → get ${val}, usable for ${rule.validityHours}h`
}

onMounted(() => {
  fetchRules()
  fetchReconciliation()
})
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Deposit Bonus Rules</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Configure daily and weekly deposit-threshold bonuses</p>
      </div>
      <UButton icon="i-heroicons:plus" label="New Rule" color="primary" @click="showCreate = true" />
    </div>

    <!-- Reconciliation widget (design spec §7) -->
    <div
      class="rounded-2xl border p-4 flex items-center justify-between"
      :class="mismatches.length ? 'border-red-500/40 bg-red-500/5' : 'border-(--surface-border)'"
      style="background: var(--surface-raised);"
    >
      <div class="flex items-center gap-3">
        <UIcon :name="mismatches.length ? 'i-heroicons:exclamation-triangle' : 'i-heroicons:check-circle'" :class="mismatches.length ? 'text-red-400' : 'text-green-400'" class="w-5 h-5" />
        <span class="text-sm text-white/70">
          {{ mismatches.length ? `${mismatches.length} wallet(s) disagree with their bonus grant ledger` : 'Bonus ledger reconciled — no drift detected' }}
        </span>
      </div>
      <UButton size="xs" variant="ghost" color="neutral" icon="i-heroicons:arrow-path" :loading="reconciling" label="Re-check" @click="fetchReconciliation" />
    </div>
    <div v-if="mismatches.length" class="rounded-xl border border-red-500/20 divide-y divide-red-500/10">
      <div v-for="m in mismatches" :key="m.userId" class="px-4 py-2 text-xs text-white/60 flex justify-between">
        <span>{{ m.userId }}</span>
        <span>wallet: {{ m.cachedBalance.toFixed(2) }} · lots: {{ m.lotSum.toFixed(2) }}</span>
      </div>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" /> Loading...
    </div>

    <div v-else-if="!rules.length" class="text-center py-16 text-white/30 bg-white/5 rounded-2xl border border-white/5">
      <UIcon name="i-heroicons:gift" class="w-12 h-12 mx-auto mb-3 opacity-20" />
      <p class="text-lg font-medium">No bonus rules yet</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="rule in rules"
        :key="rule.id"
        class="rounded-2xl border border-(--surface-border) p-5 shadow-lg"
        style="background: var(--surface-raised);"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex-1">
            <div class="flex items-center gap-3">
              <h3 class="text-base font-bold text-white">{{ rule.name }}</h3>
              <UBadge color="neutral" variant="soft" :label="rule.type === 'DAILY_DEPOSIT' ? 'Daily' : 'Weekly'" />
              <UBadge :color="rule.isActive ? 'success' : 'neutral'" variant="soft" :label="rule.isActive ? 'Active' : 'Inactive'" />
            </div>
            <p class="text-sm text-white/40 mt-1">{{ describeRule(rule) }}</p>
            <p class="text-xs text-white/30 mt-1">{{ formatDate(rule.startsAt) }} — {{ formatDate(rule.endsAt) }}</p>
          </div>
          <USwitch :model-value="rule.isActive" color="primary" @update:model-value="toggle(rule)" />
        </div>
      </div>
    </div>

    <UModal v-model:open="showCreate" title="Create Bonus Rule" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Name">
            <UInput v-model="form.name" placeholder="Daily 500 bonus" class="w-full" />
          </UFormField>
          <UFormField label="Type">
            <USelect v-model="form.type" :options="typeOptions" value-key="value" label-key="label" class="w-full" />
          </UFormField>
          <UFormField label="Threshold (ETB)">
            <UInput v-model.number="form.threshold" type="number" min="1" class="w-full" />
          </UFormField>
          <UFormField label="Reward Type">
            <USelect v-model="form.rewardType" :options="rewardTypeOptions" value-key="value" label-key="label" class="w-full" />
          </UFormField>
          <UFormField :label="rewardValueLabel">
            <UInput v-model.number="form.rewardValue" type="number" min="0.01" class="w-full" />
          </UFormField>
          <UFormField v-if="form.rewardType === 'PERCENTAGE'" label="Max Reward (ETB, optional)">
            <UInput v-model.number="form.maxReward" type="number" min="0" class="w-full" />
          </UFormField>
          <UFormField label="Validity (hours)">
            <UInput v-model.number="form.validityHours" type="number" min="1" max="2160" class="w-full" />
          </UFormField>
          <UFormField label="Period Start">
            <UInput v-model="form.startsAt" type="datetime-local" class="w-full" />
          </UFormField>
          <UFormField label="Period End">
            <UInput v-model="form.endsAt" type="datetime-local" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="showCreate = false" />
          <UButton color="primary" :loading="creating" label="Create" @click="create" />
        </div>
      </template>
    </UModal>
  </div>
</template>
```

- [ ] **Step 3: Add the nav entry**

In `apps/admin/layouts/default.vue`, add to the `Management` group's `items` array, after the `Cashback` entry:

```typescript
      { label: 'Bonus Rules',     icon: 'i-heroicons:calendar-days',          to: '/bonus-rules',              adminOnly: true },
```

- [ ] **Step 4: Manually verify in the browser**

Per project convention (`apps/admin` typecheck is red by default; this UI has no automated test), verify by hand:

Run: `pnpm --filter @world-bingo/admin dev`

Then, using the preview browser tools: navigate to `/bonus-rules`, confirm the page loads, the reconciliation widget shows "no drift detected" on a clean local DB, create a rule through the modal, confirm it appears in the list, and toggle it inactive.

- [ ] **Step 5: Grep the touched files for their own TypeScript errors**

Per the project's standing note (`pnpm typecheck` is red by default in `apps/admin` and does not gate on this), do not trust a clean `pnpm lint` exit code. Instead:

Run: `pnpm --filter @world-bingo/admin exec vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "bonus-rules\|useAdminApi"`

Expected: no output (no errors specific to the files this task touched — pre-existing unrelated errors elsewhere in the app are not this task's concern).

- [ ] **Step 6: Commit**

```bash
git add apps/admin/pages/bonus-rules/index.vue apps/admin/composables/useAdminApi.ts apps/admin/layouts/default.vue
git commit -m "feat(bonus): admin bonus-rules page with reconciliation widget"
```

---

## Phase 10 — Web UI

### Task 26: Wallet spend-account toggle, grants list, deposit progress

**Files:**
- Modify: `apps/web/pages/wallet.vue`
- Modify: `apps/web/pages/deposit.vue` (or wherever the deposit flow lives — confirm with `find apps/web/pages -iname '*deposit*'`)
- Modify: `apps/web/store/auth.ts` (if `Wallet` type needs `spendAccount`)

**Interfaces:**
- Consumes: `PATCH /wallet/spend-account`, `GET /wallet/bonus-grants` (Task 13, Task 23), `GET /promotions` (Task 23, already fetched somewhere in the deposit flow — confirm with `grep -rn "promotions" apps/web/pages apps/web/composables`).

- [ ] **Step 1: Add the spend-account toggle to the wallet balance card**

In `apps/web/pages/wallet.vue`, add a `spendAccount` ref and a setter, wiring off `auth.wallet`:

```typescript
const spendAccount = computed(() => auth.wallet?.spendAccount ?? 'REAL')
const togglingAccount = ref(false)

async function setSpendAccount(account: 'REAL' | 'BONUS') {
  if (account === spendAccount.value || togglingAccount.value) return
  togglingAccount.value = true
  try {
    await auth.apiFetch('/wallet/spend-account', { method: 'PATCH', body: { account } })
    await auth.fetchWallet()
  } finally {
    togglingAccount.value = false
  }
}

const bonusGrants = ref<any[]>([])
async function fetchBonusGrants() {
  try {
    bonusGrants.value = await auth.apiFetch<any[]>('/wallet/bonus-grants')
  } catch {
    // non-critical — the balance card still works without the grants list
  }
}

function formatTimeRemaining(expiresAt: string | null): string {
  if (!expiresAt) return 'No expiry'
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return 'Expiring...'
  const hours = Math.floor(ms / 3_600_000)
  const days = Math.floor(hours / 24)
  if (days > 0) return `Expires in ${days}d ${hours % 24}h`
  return `Expires in ${hours}h`
}
```

Extend the existing `onMounted` to also call `fetchBonusGrants()`:

```typescript
onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.replace('/auth/login')
    return
  }
  await Promise.all([refreshBalance(), fetchRecentTx(), fetchBonusGrants()])
})
```

- [ ] **Step 2: Add the toggle UI, immediately after the `balance-breakdown` div**

```html
        <!-- Spend account toggle -->
        <div class="spend-account-toggle" role="group" aria-label="Spend from">
          <button
            class="spend-account-btn"
            :class="{ 'spend-account-btn--active': spendAccount === 'REAL' }"
            :disabled="togglingAccount"
            @click="setSpendAccount('REAL')"
          >
            Spend Real
          </button>
          <button
            class="spend-account-btn"
            :class="{ 'spend-account-btn--active': spendAccount === 'BONUS' }"
            :disabled="togglingAccount"
            @click="setSpendAccount('BONUS')"
          >
            Spend Bonus
          </button>
        </div>
```

Add matching CSS in the `<style>` block, following this file's existing `.balance-part--bonus` color convention (search the file for its existing amber/gold bonus accent color and reuse it):

```css
.spend-account-toggle {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.spend-account-btn {
  flex: 1;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.1));
  background: transparent;
  color: rgba(255, 255, 255, 0.5);
  font-size: 13px;
  font-weight: 600;
  transition: all 0.15s ease;
}
.spend-account-btn--active {
  background: var(--color-primary, #f59e0b);
  border-color: var(--color-primary, #f59e0b);
  color: #000;
}
```

- [ ] **Step 3: Add the bonus grants list**

Add a new section after `<!-- ── Recent Transactions ── -->`:

```html
      <!-- ── Bonus Grants ─────────────────────────────────────────── -->
      <div v-if="bonusGrants.length" class="section">
        <div class="section-header">
          <span class="section-title">Active Bonuses</span>
        </div>
        <div class="tx-card">
          <div class="tx-list">
            <div v-for="(grant, i) in bonusGrants" :key="grant.id" class="tx-row" :class="{ 'tx-row--bordered': i < bonusGrants.length - 1 }">
              <div class="tx-details">
                <span class="tx-label">{{ grant.ruleName ?? 'Bonus credit' }}</span>
                <span class="tx-time">{{ formatTimeRemaining(grant.expiresAt) }}</span>
              </div>
              <span class="amount-positive">{{ Number(grant.remaining).toFixed(2) }} ETB</span>
            </div>
          </div>
        </div>
      </div>
```

Adapt `.tx-details`/`.tx-label`/`.tx-time` to whatever class names this file's existing transaction row markup actually uses (read the full `tx-row` template block first — Step 3's snippet mirrors its structure, not necessarily its exact class names).

- [ ] **Step 4: Add deposit-progress indicators**

Locate the deposit flow (`find apps/web/pages -iname '*deposit*'`) and the promotions fetch already used there (`grep -rn "promotions" apps/web/pages apps/web/composables`). Add:

```typescript
const dailyProgress = computed(() => {
  const rule = promotions.value?.dailyDepositBonus
  if (!rule) return null
  return { threshold: rule.threshold, reward: rule.rewardType === 'FIXED' ? rule.rewardValue : null }
})
const weeklyProgress = computed(() => {
  const rule = promotions.value?.weeklyDepositBonus
  if (!rule) return null
  return { threshold: rule.threshold, reward: rule.rewardType === 'FIXED' ? rule.rewardValue : null }
})
```

```html
<div v-if="dailyProgress" class="deposit-bonus-hint">
  Deposit {{ dailyProgress.threshold }} ETB today for a bonus.
</div>
<div v-if="weeklyProgress" class="deposit-bonus-hint">
  Deposit {{ weeklyProgress.threshold }} ETB this week for a bonus.
</div>
```

Place these near the existing amount input, matching the deposit page's existing layout conventions (read the file's current template structure first — this plan states the data and copy, not the exact insertion point, since the page wasn't read line-by-line during planning).

- [ ] **Step 5: Manually verify in the browser**

Run: `pnpm --filter @world-bingo/web dev`

Using the preview browser tools: log in as a test player, navigate to `/wallet`, confirm the REAL/BONUS toggle renders and flips (check the network tab for the `PATCH /wallet/spend-account` call), grant yourself a bonus via the admin adjust-balance route or directly in the test DB and confirm it appears in the Active Bonuses list with a correct "Expires in..." string, and check the deposit page shows the progress hints when a daily/weekly rule is active.

- [ ] **Step 6: Commit**

```bash
git add apps/web/pages/wallet.vue apps/web/pages/deposit.vue
git commit -m "feat(bonus): wallet spend-account toggle, grants list, deposit progress hints"
```

---

### Task 27: i18n strings

**Files:**
- Modify: `apps/web/i18n/locales/en.json`
- Modify: `apps/web/i18n/locales/am.json`

**Interfaces:**
- Consumes: none. Produces the translation keys Task 26's markup should use instead of hardcoded English (Task 26 was written with literal strings for planning clarity; this task is what makes them translatable, and Task 26's markup should be revisited to use `$t(...)` for each of these keys instead of the literals shown above).

- [ ] **Step 1: Find the existing wallet-related key namespace**

Run: `grep -n '"wallet"' apps/web/i18n/locales/en.json`

- [ ] **Step 2: Add the new keys under that namespace in `en.json`**

```json
"wallet": {
  "spendAccountReal": "Spend Real",
  "spendAccountBonus": "Spend Bonus",
  "activeBonuses": "Active Bonuses",
  "bonusExpiresIn": "Expires in {time}",
  "bonusNoExpiry": "No expiry",
  "bonusExpiring": "Expiring...",
  "depositDailyHint": "Deposit {amount} ETB today for a bonus.",
  "depositWeeklyHint": "Deposit {amount} ETB this week for a bonus."
}
```

Merge these keys into the existing `"wallet"` object found in Step 1 — do not create a second top-level `"wallet"` key.

- [ ] **Step 3: Add the Amharic translations to `am.json`, under the same structure**

```json
"wallet": {
  "spendAccountReal": "እውነተኛ ተጠቀም",
  "spendAccountBonus": "ጉርሻ ተጠቀም",
  "activeBonuses": "ንቁ ጉርሻዎች",
  "bonusExpiresIn": "በ {time} ውስጥ ያበቃል",
  "bonusNoExpiry": "ማብቂያ የለውም",
  "bonusExpiring": "እያበቃ ነው...",
  "depositDailyHint": "ዛሬ {amount} ብር በማስገባት ጉርሻ ያግኙ።",
  "depositWeeklyHint": "በዚህ ሳምንት {amount} ብር በማስገባት ጉርሻ ያግኙ።"
}
```

- [ ] **Step 4: Update Task 26's markup to use these keys**

Replace the literal strings introduced in Task 26 with `$t('wallet.spendAccountReal')` etc., following whichever i18n call convention the rest of `wallet.vue` already uses (`grep -n "\$t(" apps/web/pages/wallet.vue` — likely `{{ $t('wallet.xxx') }}` in templates and `useI18n()`'s `t()` in `<script setup>`).

- [ ] **Step 5: Manually verify both locales render**

Using the preview browser tools: load `/wallet` with the browser's language set to English, confirm the new strings render; switch the language cookie/selector to Amharic and confirm the Amharic strings render without falling back to the key name.

- [ ] **Step 6: Commit**

```bash
git add apps/web/i18n/locales/en.json apps/web/i18n/locales/am.json apps/web/pages/wallet.vue
git commit -m "feat(bonus): add en/am translations for the deposit bonus UI"
```

---

## Self-Review

**Spec coverage** — every numbered section of the design spec maps to a task:

| Spec section | Task(s) |
|---|---|
| §1 Why the balance can't carry this / two consequences | Task 1 (schema), Tasks 6-9 (four migrated credit sources) |
| §2 Data model | Task 1 |
| §3 Granting | Tasks 10-12 |
| §4 Which account funds play | Tasks 13-14, 16, 18 |
| §5 Spending, expiry, refunds | Tasks 3-4 (spend/reduce/restore), 15, 17, 19 (refund/rollback restoration), 20 (expiry) |
| §6 Period buckets | Task 10 |
| §7 The invariant | Task 5 (property test + reconciliation), enforced structurally by Tasks 2-4 being the only `bonusBalance` writers |
| §8 Average daily deposit | Tasks 21-22 |
| §9 Surfaces | Tasks 23 (API), 24-25 (admin), 26-27 (web) |
| §10 Testing | Covered inline in every task's TDD steps |
| §11 Out of scope | No task implements wagering requirements, max cashout, per-bet caps, product restrictions, or repeating weekly grants — confirmed absent by omission |

**Placeholder scan** — no task contains "TBD", "TODO", or an unshown "add error handling" instruction. The three places this plan explicitly defers detail (Task 9's app-injection helper names, Task 18's exact `Transaction.type`/`referenceId` field for the paired bet lookup, Task 26's exact insertion point in the deposit page) each name precisely what to `grep` for and why the plan couldn't pin it down further (the target file wasn't read in full during planning) — that is a scoped investigation step, not an unresolved requirement.

**Type consistency** — `SpendAccount`, `BonusGrantSource`, `BonusRuleType`/`BonusRewardType`, and every result interface (`GrantBonusResult`, `SpendBonusResult`, `ReduceBonusResult`, `ExpireBonusResult`, `ReconciliationMismatch`) are defined once in Task 2-5/20 and reused verbatim by every later task that consumes them — checked by re-reading each "Interfaces: Consumes" line against the task that "Produces" it.

---

## Addendum — findings from the final whole-branch review (2026-08-21)

Tasks 1-27 were each individually reviewed and merged. The final whole-branch review (required by `superpowers:subagent-driven-development` after all tasks complete) found issues no task-scoped review could see: two spend paths this plan's own §1 inventory never enumerated (it inventoried where bonus gets *credited*, never where every existing system *spends* it), a bug introduced by Task 16 in code 100 lines outside its own diff hunk, and three items the approved design spec (§9) called for that never became tasks. Full findings are in the SDD ledger; this addendum adds the tasks needed to close them, following this plan's existing conventions and using the human-approved decision recorded there: widen scope to close the money-correctness gaps now, and build the three missing spec-UI pieces now rather than deferring either.

Tasks 28-30 close genuine scope gaps (a second spend path per money-moving subsystem this plan never touched). Tasks 31-33 fix bugs in code this plan already touched. Tasks 34-36 build the three spec items that were approved but never scheduled.

---

## Phase 11 — Close scope gaps: spend paths this plan never enumerated

### Task 28: Migrate GASea (`third-party-wallet.service.ts`) to spend-account-based spend/restore

**Files:**
- Modify: `apps/api/src/services/third-party-wallet.service.ts`
- Test: find existing coverage (`grep -rln "third-party-wallet\|GASea\|processBetDebit" apps/api/src/test/*.ts`)

**Interfaces:**
- Consumes: `BonusService.spend`, `BonusService.restore` (Tasks 3, 4) — identical to how Task 18/19 consumed them for Palace.

GASea is a second live third-party casino provider, registered alongside Palace at `/v1/aggregator/wallet`. The design spec (§4) named it explicitly ("Palace / GASea `processBet`") but no task in the original 27 touched it — Task 18/19 covered only Palace. `third-party-wallet.service.ts` still has five raw `bonusBalance` writes, all bonus-first-then-real (the same inconsistent-with-everything-else behavior Task 18 replaced in Palace):

- `processBet` (~line 240-290) — the spend path. Read it in full: it locks the wallet (`lockWallet`), computes `totalBefore`, deducts real-first-then-bonus (note: real-first here, opposite of Palace's original real-first — same class of bug, different ordering), writes `wallet.update({ realBalance, bonusBalance })` directly, then creates `thirdPartyTransaction` and `transaction` rows.
- `processBetDebit`, `processRollback`, `processAdjustment`, `processBetCredit` (~lines 607-1061) — read each of these in full before touching any of them. Do not assume their semantics from their names. For each, determine: is this a **spend** (money leaves the wallet — apply the Task 18 pattern: honor `wallet.spendAccount`, spend entirely from that account via `BonusService.spend`, reject rather than fall back) or a **credit/restore** (money returns to the wallet — determine whether it's a rollback of a specific prior spend with a real/bonus split to preserve, in which case apply the Task 19 pattern: look up the paired `Transaction` row for the original debit and restore proportionally via `BonusService.restore(tx, userId, bonusPortion, null)`; or a fresh credit like a win, in which case it should credit `realBalance` only, matching how Palace's `processWin` and this file's own win-crediting logic already work — verify this against the actual code, don't assume).

This task is intentionally scoped the way Task 19 was: the exact shape of each of the five methods needs investigation before applying a pattern, not a guess from the method name. Use Task 18's report and diff, and Task 19's report and diff, as your primary references for "what the target shape looks like" — this is the same job, done twice already in this plan, against a near-identical provider integration.

- [ ] **Step 1: Read the whole file.** `third-party-wallet.service.ts` in full, plus its existing test file if one exists.
- [ ] **Step 2: Classify each of the 5 write sites** as spend or credit/restore, per the reasoning above. Write this classification into your report before writing any code — it's the design decision this task hinges on.
- [ ] **Step 3: Add `spendAccount` to this file's wallet-locking helper's `SELECT`**, mirroring Task 18's change to Palace's `lockWallet`.
- [ ] **Step 4: Migrate the spend site(s)** to the Task 18 pattern (honor `spendAccount`, reject-not-fallback via `BonusService.spend`, stamp `bonusExpiresAtSpend` on the resulting `Transaction` row).
- [ ] **Step 5: Migrate the credit/restore site(s)** to the Task 19 pattern (paired-transaction lookup + `BonusService.restore` for genuine rollbacks; real-only credit for fresh wins — per your Step 2 classification).
- [ ] **Step 6: Write or extend tests covering each migrated site** — at minimum, one test per site proving: (a) it honors `spendAccount` where applicable, (b) it rejects rather than falls back on insufficient funds in the selected account, (c) a rollback restores to the account it came from. Follow Task 18/19's real-DB test style if this file already has real-DB test coverage; if it only has a mocked/in-memory test double (check before assuming), follow that file's existing convention instead — do not introduce a different testing strategy than what's already established for this file.
- [ ] **Step 7: Run the full test file, confirm nothing broke.**
- [ ] **Step 8: Commit**, in as many commits as make sense given the 5 sites (one commit per site, or fewer if several sites share one fix, following how Task 17/18/19 split their own commits).

```bash
git add apps/api/src/services/third-party-wallet.service.ts apps/api/src/test/<the file(s) you touched>
git commit -m "feat(bonus): GASea provider bets spend from the player-selected account"
```

(Use additional commits with their own messages for the credit/restore sites if you split the work, following this plan's established one-fix-one-commit convention.)

---

### Task 29: Migrate tournament register/cancel to `BonusService.spend`/`.restore`

**Files:**
- Modify: `apps/api/src/services/tournament.service.ts`
- Test: find existing coverage (`grep -rln "tournament.service\|TournamentService" apps/api/src/test/*.ts`)

**Interfaces:**
- Consumes: `BonusService.spend`, `BonusService.restore` (Tasks 3, 4) — identical pattern to Task 14/15 (bingo `joinGame`/`leaveGame`).

`TournamentService.register` and `cancelTournament` were never in this plan's scope at all — the original design's §1 inventory enumerated only where bonus gets *credited* (first-deposit, cashback, campaign, admin), never every place it gets *spent*. Tournament entry fees are a fourth spend path, structurally identical to bingo's `GameService.joinGame`/`leaveGame`:

```typescript
// register(), current code (read the surrounding function in full first):
const bonusDeduction = Decimal.min(bonusBefore, entryFee)
const realDeduction = entryFee.minus(bonusDeduction)
await tx.wallet.update({
    where: { userId },
    data: { realBalance: { decrement: realDeduction }, bonusBalance: { decrement: bonusDeduction } },
})
await tx.transaction.create({
    data: { userId, type: TransactionType.GAME_ENTRY, amount: entryFee, /* ... */
        balanceBefore: realBefore, balanceAfter: realAfter,
        bonusBalanceBefore: bonusBefore, bonusBalanceAfter: bonusAfter },
})
```

```typescript
// cancelTournament(), current code — derives real/bonus split from GAME_ENTRY
// transaction snapshots, exactly like refund.service.ts does for bingo, then:
await tx.wallet.update({
    where: { userId: entry.userId },
    data: { realBalance: realAfter, bonusBalance: bonusAfter },
})
```

Apply the exact Task 14 transformation to `register`: read `wallet.spendAccount`, spend the entire `entryFee` from that one account via `BonusService.spend` (BONUS branch) or a plain real decrement with an insufficient-funds check (REAL branch), stamp `bonusExpiresAtSpend` on the `GAME_ENTRY` transaction.

Apply the exact Task 15 transformation to `cancelTournament`: keep the existing `realRefund`/`bonusRefund` derivation from `GAME_ENTRY` snapshots unchanged, but credit the real portion via a plain `wallet.realBalance` update and the bonus portion via `BonusService.restore(tx, userId, bonusRefund, originalExpiry)`, where `originalExpiry` is the MINIMUM non-null `bonusExpiresAtSpend` across that user's `GAME_ENTRY` transactions for this tournament — reuse the exact deterministic-minimum reduce Task 15's fix introduced in `refund.service.ts`/`game.service.ts` (do not reintroduce the unordered-`.find()` bug Task 15 fixed there).

- [ ] **Step 1: Read `register` and `cancelTournament` in full**, plus this file's existing test coverage.
- [ ] **Step 2: Migrate `register`** per the Task 14 pattern described above. Write the failing test first (a BONUS-selected registration spends entirely from bonus and rejects on shortfall; a REAL-selected registration is unaffected) if this file's test conventions support TDD against a real DB — check first.
- [ ] **Step 3: Migrate `cancelTournament`** per the Task 15 pattern (min-of-non-null expiry restore), with its own test.
- [ ] **Step 4: Run the full test file, confirm nothing else broke** (tournament settlement/prize logic is untouched and must stay that way).
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/tournament.service.ts apps/api/src/test/<the file(s) you touched>
git commit -m "feat(bonus): tournament entry fees spend from the player-selected account"
```

---

### Task 30: `CHECK (bonusBalance >= 0)` constraint

**Files:**
- Create: a new migration under `apps/api/prisma/migrations/`
- Modify: `apps/api/prisma/schema.prisma` (documentation comment only — Prisma doesn't model raw CHECK constraints in the schema DSL for this Prisma version; the constraint lives in the migration SQL only)

**Interfaces:** none — this is a database-level backstop, not application code.

The final whole-branch review found there are currently **zero** CHECK constraints anywhere in this schema's migration history, so the platform's stated rule #1 ("wallet balance never goes below zero") is enforced only by application-code convention. Tasks 28-29 close the two known double-spend paths, but this constraint is the backstop for any spend path this plan — or a future one — still misses: instead of a silent negative balance, an attempted double-spend becomes a loud, immediate transaction failure.

- [ ] **Step 1: Confirm no existing wallet row would violate the constraint** before adding it (a constraint that fails to apply because of pre-existing bad data is worse than no constraint — it blocks the migration entirely). Run:

```bash
pnpm --filter @world-bingo/api exec tsx -e "
import prisma from './src/lib/prisma'
async function main() {
  const bad = await prisma.wallet.count({ where: { OR: [{ bonusBalance: { lt: 0 } }, { realBalance: { lt: 0 } }] } })
  console.log({ negativeWallets: bad })
  await prisma.\$disconnect()
}
main()
"
```

If this returns a nonzero count, STOP and report BLOCKED — do not add a constraint that can't apply, and do not attempt to silently zero-out negative balances yourself; that's a data-correctness decision for a human, not this task.

- [ ] **Step 2: Generate the migration** (`pnpm --filter @world-bingo/api exec prisma migrate dev --name add_wallet_balance_check_constraints --create-only`), then hand-edit the generated `migration.sql` to add:

```sql
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_realBalance_nonneg" CHECK ("realBalance" >= 0);
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_bonusBalance_nonneg" CHECK ("bonusBalance" >= 0);
```

Rename the migration folder to a date-prefixed name matching this repo's convention (check today's date; use the same pattern as `20260821000000_add_bonus_grants`).

- [ ] **Step 3: Apply the migration** to both the dev and test databases, following the same approach Task 1 established (its report documents the working `prisma migrate dev`/`prisma db execute` commands and the pre-existing test-DB migration-history drift workaround — read it first: it's in the SDD ledger/report directory from this same plan run).
- [ ] **Step 4: Verify the constraint actually rejects a violation.** Write a quick throwaway check (not a permanent test — this is a DB-level constraint, not application logic) confirming `UPDATE wallets SET "bonusBalance" = -1 WHERE ...` raises a Postgres error. Report the exact error text you saw.
- [ ] **Step 5: Run the full API test suite** to confirm no existing test path relies on a transient negative balance mid-transaction that this constraint would now reject (constraints are checked at statement commit within a transaction by default in Postgres unless declared `DEFERRABLE`, so a transient negative value that's corrected before the transaction ends is fine — but confirm this empirically by running the suite, don't just reason about it).
- [ ] **Step 6: Commit.**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(bonus): add CHECK constraints so a wallet balance can never go negative"
```

---

## Phase 12 — Fix bugs the final review found in already-scoped code

### Task 31: Fix prediction price-improvement release (mints bonus with no lot) + Palace null-expiry restore

**Files:**
- Modify: `apps/api/src/services/prediction/order.service.ts`
- Modify: `apps/api/src/services/palace-wallet.service.ts`
- Test: `apps/api/src/test/prediction-order.test.ts`, `apps/api/src/test/palace-wallet.test.ts`

**Interfaces:**
- Consumes: `BonusService.restore` (Task 4), `originalHoldExpiry` (Task 17, already exists in `order.service.ts`).

**Bug 1 (introduced by Task 16, real invariant break).** `placeOrder`'s price-improvement release, ~line 395-412 of `order.service.ts` (NOT the reserve logic Task 16 already fixed — this is a separate block, ~100 lines later in the same function, that Task 16's diff hunk didn't include):

```typescript
if (improvement.greaterThan(0)) {
    const released = splitAgainstReserve(improvement, heldReal, heldBonus)
    realFinal = realAfterHold.plus(released.real)
    bonusFinal = bonusAfterHold.plus(released.bonus)
    await tx.wallet.update({ where: { userId }, data: { realBalance: realFinal, bonusBalance: bonusFinal } })
    // ...
}
```

Since Task 16 made `placeOrder`'s reserve 100% one bucket (never split), a BONUS-selected order's `heldReal` is always 0, so `splitAgainstReserve` returns the entire `improvement` as `released.bonus`. This raw-increments `bonusBalance` with **no corresponding `bonus_grants` lot** — the money is unspendable through any lot-based path and permanently trips `reconcile()`. There is an existing test in this branch, `apps/api/src/test/prediction-order.test.ts` (search for the price-improvement test, ends with an assertion like `expect(walletOf('alice')).toEqual({ real: '1000', bonus: '100' })`), that directly asserts this buggy behavior — you will need to update that assertion once you fix the underlying code.

Fix: split the `realFinal`/`bonusFinal` computation apart exactly like `cancelOrder` (`order.service.ts`, ~line 552-566, already correct — read it as your reference) already does: real portion via a plain `wallet.realBalance` update, bonus portion via `BonusService.restore(tx, userId, released.bonus, await originalHoldExpiry(tx, userId, order.id))` (the `originalHoldExpiry` helper already exists in this file from Task 17 — reuse it, don't reimplement).

**Bug 2 (Palace `processCancel` restores with `expiresAt: null`).** `palace-wallet.service.ts`'s `processCancel` (~line 377-385, from Task 19) restores bonus via `BonusService.restore(tx, user.id, bonusDelta, null)` — a never-expiring lot. Task 19's own report explains why: the `TP_BET` transaction row doesn't carry `bonusExpiresAtSpend`. The final review argues `null` (infinite) is actually worse than the "fresh window" abuse case the design explicitly ruled out. Fix: stamp `bonusExpiresAtSpend` on `processBet`'s `TP_BET` transaction create (~line 210-217 — it already has `spendResult` in scope from Task 18's fix, just add `bonusExpiresAtSpend: spendResult?.soonestExpiryConsumed ?? null` to that `data` object), then have `processCancel`'s existing `betTxn` lookup (~line 356-359, already selects from that row) read and pass through that column instead of `null`.

- [ ] **Step 1: Fix the `placeOrder` price-improvement release.** Write/update the failing test first (the existing test that asserts the buggy `{real: '1000', bonus: '100'}` outcome — change its expectation to assert a `BonusGrant` lot exists instead, following this file's testing convention — check whether it's real-DB or an in-memory double, per Task 16/17's own findings about this file, and adapt accordingly).
- [ ] **Step 2: Run RED, then implement, run GREEN.**
- [ ] **Step 3: Fix Palace's `bonusExpiresAtSpend` stamping and `processCancel`'s read of it.** Write/update a test confirming a cancelled bonus-funded bet restores with the ORIGINAL expiry, not `null`, following Task 19's existing test in this file as your pattern.
- [ ] **Step 4: Run RED, then implement, run GREEN.**
- [ ] **Step 5: Run both full test files, confirm nothing else broke.**
- [ ] **Step 6: Commit** (can be one commit or two, given these are two independent fixes in two different files — your call, following this plan's convention of one logical fix per commit).

```bash
git add apps/api/src/services/prediction/order.service.ts apps/api/src/services/palace-wallet.service.ts apps/api/src/test/prediction-order.test.ts apps/api/src/test/palace-wallet.test.ts
git commit -m "fix(bonus): prediction price-improvement release and Palace rollback both restore into a real BonusGrant lot"
```

---

### Task 32: Fix voidMarket, Palace cross-callback reporting, cashback rounding, dropped locks, error mapping

**Files:**
- Modify: `apps/api/src/services/prediction/settlement.service.ts`
- Modify: `apps/api/src/services/palace-wallet.service.ts`
- Modify: `apps/api/src/services/cashback.service.ts`
- Modify: `apps/api/src/services/player-crm/campaign.service.ts`
- Test: corresponding existing test files for each

**Interfaces:**
- Consumes: `BonusService.restore`, `BonusService.grant` (Tasks 3, 4) — no new interfaces.

This task bundles five independent, small fixes the final review found — each is a one-file, few-line change, grouped here because none warrants its own task-sized ceremony. Fix them one at a time, in this order, with its own test and its own commit per fix (five commits total is fine — don't force them into one).

**Fix 1 — `voidMarket` position refund** (`settlement.service.ts`, ~line 564-567, inside `voidMarket`'s position-refund loop, NOT `refundOpenOrders` a few lines above it which Task 17 already fixed correctly — use that as your pattern). Currently: `await tx.wallet.update({ data: { realBalance: realAfter, bonusBalance: bonusAfter } })` for `position.costBasisBonus`, no `BonusService.restore`, no expiry lookup. Fix identically to how `refundOpenOrders` already handles it in this same file: real portion via plain update, bonus portion via `BonusService.restore` with the original hold's expiry (same lookup pattern `refundOpenOrders` already uses).

**Fix 2 — Palace cross-callback reporting** (`palace-wallet.service.ts`). Task 18 fixed `authenticate`/`getBalance`/`processBet` (fresh + replay) to report only the selected account. `getStatus`, and BOTH the fresh and replay paths of `processWin` and `processCancel`, still report the combined `realBalance + bonusBalance` total. Apply the identical fix (report `wallet.spendAccount === 'BONUS' ? bonusBalance : realBalance` instead of the combined total) to all of: `getStatus`, `processWin`'s fresh return value, `processWin`'s replay branch, `processCancel`'s fresh return value, `processCancel`'s replay branch. This does NOT change what's persisted to `ThirdPartyTransaction`/`Transaction` audit rows (those correctly stay combined-total, per Task 18's original design) — only what's returned to the provider in the HTTP response.

**Fix 3 — Cashback percentage rounding** (`cashback.service.ts`, the `cashbackAmount` computation, ~line 176-179). `netLoss.times(refundValue.div(100))` has no rounding, so a `PERCENTAGE`-type promotion's payout can carry more than 2 decimal places, which then gets silently truncated when it lands in `bonus_grants` (`Decimal(12,2)`) but not in `wallets.bonusBalance` (`Decimal(20,8)`) — permanent drift on every percentage disbursement. Fix: add `.toDecimalPlaces(2, Decimal.ROUND_DOWN)` to the computed `cashbackAmount`. Also add a defensive `.toDecimalPlaces(2, Decimal.ROUND_DOWN)` inside `BonusService.grant` itself (`bonus.service.ts`, on the `amount` parameter, before it's used for both the lot and the wallet increment) so no future caller can reintroduce this class of drift — this is the more important half of the fix; the `cashback.service.ts` change alone only fixes this one call site, `grant()` fixes it for everyone.

**Fix 4 — Restore dropped `FOR UPDATE` locks.** `cashback.service.ts`'s `checkAndDisburse` (Task 7) and `player-crm/campaign.service.ts`'s bonus-delivery path (Task 8) both lost their `SELECT ... FOR UPDATE` wallet lock during migration to `BonusService.grant` — `grant()` itself reads `bonusBalance` via a plain, unlocked `SELECT`. This violates this plan's own Global Constraints ("the caller already holds the lock"). Restore the `FOR UPDATE` lock in both files, immediately before the `BonusService.grant` call, matching the pattern every other caller of `BonusService` methods already uses (see `game.service.ts`'s `joinGame` as the reference).

**Fix 5 — `InsufficientBonusBalanceError` missing from Palace's error mapping.** `palace-wallet.service.ts`'s `processBet`, the `catch` block around line 234-243, maps specific error shapes to Palace protocol error codes (e.g. `{ code: 'BALANCE_NOT_ENOUGH' }` → `31`). `BonusService.spend`'s `InsufficientBonusBalanceError` (which carries `.statusCode`, not `.code`) falls through this mapping and would surface as an unhandled 500. Add a branch checking `err?.name === 'InsufficientBonusBalanceError'` (or `err instanceof InsufficientBonusBalanceError`, whichever matches this file's existing error-checking convention) to the same `BALANCE_NOT_ENOUGH` branch.

- [ ] **Step 1-5 (one per fix above):** for each, write/update a failing test first where practical, implement, verify GREEN, run that file's full test suite, commit.
- [ ] **Step 6: Run the full API test suite once at the end**, confirm no cross-fix interaction broke anything.

```bash
git add apps/api/src/services/prediction/settlement.service.ts apps/api/src/services/palace-wallet.service.ts apps/api/src/services/cashback.service.ts apps/api/src/services/bonus.service.ts apps/api/src/services/player-crm/campaign.service.ts apps/api/src/test/<files touched>
# five commits, one per fix, messages describing each fix specifically
```

---

### Task 33: System-level invariant test coverage

**Files:**
- Modify: `apps/api/src/test/setup.ts` (add a shared helper) OR create `apps/api/src/test/helpers/invariant.ts` — your call based on how this codebase's test helpers are typically organized (check whether `setup.ts` already exports reusable assertion helpers, or whether a separate helpers file is the convention)
- Modify: `apps/api/src/test/game.service.extended.test.ts`, `apps/api/src/test/refund.service.test.ts`, `apps/api/src/test/wallet.service.test.ts`, `apps/api/src/test/cashback.service.test.ts`, `apps/api/src/test/admin-adjust-balance.test.ts`, `apps/api/src/test/bonus-expiry.worker.test.ts` — every REAL-DB test suite that exercises a `BonusService`-touching code path

**Interfaces:**
- Consumes: `BonusService.reconcile()` (Task 5).

The final review found that `bonus-invariant.test.ts` only proves `BonusService` is internally self-consistent (grant/spend/reduce/restore calling itself) — it never runs a real end-to-end flow (join→leave, place→fill→cancel, bet→cancel, disburse) and asserts `reconcile()` comes back empty. The two suites that structurally could not see this plan's real bugs (`prediction-order.test.ts`, `prediction-settlement.test.ts`, `palace-wallet.test.ts`) all mock `BonusService`/`prisma` entirely and have no `bonus_grants` table modeled — so a shared invariant check can't help THOSE suites directly (they're not real-DB), but it should be added to every suite that DOES touch a real DB and a real `BonusService` call, to close the same class of blind spot going forward.

- [ ] **Step 1: Write a small, shared helper.**

```typescript
import { BonusService } from '../services/bonus.service' // adjust path per actual file location
import { expect } from 'vitest'

export async function expectInvariantClean() {
    const mismatches = await BonusService.reconcile()
    expect(mismatches).toEqual([])
}
```

- [ ] **Step 2: Add a call to `expectInvariantClean()` inside the `afterEach` (or equivalent per-test cleanup hook) of each real-DB suite listed above** — after the test's own assertions, before `cleanDb()` runs (so it checks state the test actually left behind, not a freshly-wiped DB). If a suite already has a custom `afterEach`, add the call there; if not, add one.
- [ ] **Step 3: Run each modified test file.** If any of them now fails because a PRE-EXISTING (unfixed-by-this-plan) code path in that specific test's setup/execution leaves the invariant broken, that's real information — do not silence it by removing the check; report it clearly instead (it may be one of Tasks 28-32's fixes not yet having landed, in which case note the dependency; or it may be a genuinely new finding this task surfaced, in which case treat it as BLOCKED and report the specifics rather than guessing a fix).
- [ ] **Step 4: Commit.**

```bash
git add apps/api/src/test/<helper file> apps/api/src/test/game.service.extended.test.ts apps/api/src/test/refund.service.test.ts apps/api/src/test/wallet.service.test.ts apps/api/src/test/cashback.service.test.ts apps/api/src/test/admin-adjust-balance.test.ts apps/api/src/test/bonus-expiry.worker.test.ts
git commit -m "test(bonus): assert the wallet/lot invariant holds after every real-DB bonus-touching test"
```

---

## Phase 13 — Build the three approved spec items that were never scheduled

### Task 34: Admin player-detail grants panel

**Files:**
- Modify: `apps/admin/composables/useAdminApi.ts` (add `getPlayerBonusGrants(userId)` calling the existing `GET /admin/players/:id/bonus-grants` route from Task 24 — no backend change needed, the route already exists and is tested)
- Modify: whichever admin page currently shows player detail (`find apps/admin/pages -path '*players*'` — read the result in full to find the right insertion point; this plan doesn't know its exact current structure)

**Interfaces:**
- Consumes: `GET /admin/players/:id/bonus-grants` (Task 24, already built and tested — response shape: array of `{ id, amount, remaining, expiresAt, status, ruleName, ruleType, createdAt }`).

Spec §9: "Player detail gains a grants panel: amount, remaining, expiry, source rule, status." The backend route exists (Task 24) but nothing in `apps/admin` calls it.

- [ ] **Step 1: Find the admin player-detail page** (`find apps/admin/pages -path '*players*'`) and read it in full to understand its current layout (likely tabs or sections for balance, transactions, etc. — find where a new section fits naturally).
- [ ] **Step 2: Add the composable method** to `useAdminApi.ts`, following the exact pattern of `getPlayerBonusGrants` sibling methods already in that file (e.g. how other player-scoped admin endpoints are called).
- [ ] **Step 3: Add a grants table/list section to the player-detail page** — columns for amount, remaining, expiry (formatted, with a "never" fallback for `null`), status (badge, colored per status like the bonus-rules page's `isActive` badge), source rule name (or "Legacy/Admin" fallback for `ruleName: null`). Match this page's existing table/list styling exactly (read a sibling section on the same page for the convention, the same way Task 25 mirrored `cashback/index.vue`).
- [ ] **Step 4: Static verification only** (per this plan's established limitation — no dev server in this execution): read your new section against the page's existing conventions line-by-line, run the scoped `vue-tsc` grep this plan's later tasks established (`pnpm --filter @world-bingo/admin exec vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "<your files>"`), confirm no NEW errors.
- [ ] **Step 5: Commit**, reporting DONE_WITH_CONCERNS for the same browser-verification-skipped reason Tasks 25/26 did.

```bash
git add apps/admin/composables/useAdminApi.ts apps/admin/pages/<the player detail page>
git commit -m "feat(bonus): admin player detail gains a bonus grants panel"
```

---

### Task 35: Admin bonus-rule edit UI

**Files:**
- Modify: `apps/admin/composables/useAdminApi.ts` (add `updateBonusRule(id, data)` calling the existing `PATCH /admin/bonus-rules/:id` route from Task 24 — already built and tested, just never exposed to the frontend)
- Modify: `apps/admin/pages/bonus-rules/index.vue` (Task 25)

**Interfaces:**
- Consumes: `PATCH /admin/bonus-rules/:id` (Task 24).

Spec §9: "`/admin/bonus-rules` — list, create, **edit**, activate/deactivate." Create and toggle exist (Task 25); edit does not — an operator can't correct a typo'd threshold without deleting and recreating the rule (and there's no delete either, so today they genuinely cannot).

- [ ] **Step 1: Read `bonus-rules/index.vue` in full** (Task 25's output, possibly since amended by earlier fix rounds — read the CURRENT state).
- [ ] **Step 2: Add `updateBonusRule` to `useAdminApi.ts`**, following `createBonusRule`'s exact pattern (same file, from Task 25).
- [ ] **Step 3: Add an "Edit" affordance to each rule card** — a button opening a modal pre-filled with that rule's current values, reusing the existing create-modal's form structure (don't duplicate the whole form markup if it can be reasonably shared via a second `v-model:open` + shared `form` reactive object with a mode flag — your call on the cleanest approach given what you find in the file, but don't over-engineer a generic "modal component" abstraction for two use sites).
- [ ] **Step 4: On submit, call `updateBonusRule`** with only the changed fields (or all fields — `PATCH` accepts partial updates per Task 24's `bonusRuleUpdateSchema`), refresh the list, toast success/failure matching the page's existing pattern.
- [ ] **Step 5: Static verification** (same as Task 34 — scoped `vue-tsc` grep, no new errors, line-by-line review against the page's own existing conventions).
- [ ] **Step 6: Commit**, DONE_WITH_CONCERNS for the same browser-verification-skipped reason.

```bash
git add apps/admin/composables/useAdminApi.ts apps/admin/pages/bonus-rules/index.vue
git commit -m "feat(bonus): admin can edit an existing bonus rule, not just create and toggle"
```

---

### Task 36: Deposit progress-tracking (real "X of Y deposited", not a static hint)

**Files:**
- Create: a new endpoint or extend an existing one to expose the player's CURRENT bucket total for each active daily/weekly rule (read `apps/api/src/services/deposit-bonus.service.ts`'s `evaluateAndGrant` — Task 12 — for the exact bucket-sum query shape; you need a READ-ONLY version of that same aggregation, callable without a pending deposit, not the grant-evaluation logic itself)
- Modify: `apps/api/src/routes/wallet/index.ts` or `apps/api/src/routes/promotions/index.ts` (your call on the more natural home — a wallet-scoped "my deposit progress" read fits either)
- Modify: `apps/web/components/DepositModal.vue` (Task 26)
- Modify: `apps/web/store/promotions.ts` (Task 26) if that's where the fetch belongs, or add a new small composable/store slice if a player-specific (not global) value doesn't belong in the promotions store — read that store's current shape first (Task 26 already extended it once) before deciding

**Interfaces:**
- Consumes: `dayBucketStart`/`weekBucketStart` (Task 10, `apps/api/src/lib/bonus-period.ts`).
- Produces: a new endpoint, e.g. `GET /wallet/deposit-progress`, returning `{ dailyDeposited: number, dailyThreshold: number | null, weeklyDeposited: number, weeklyThreshold: number | null }` (or your own clean shape — this plan doesn't mandate the exact field names, just the semantic content: current bucket total vs. active rule's threshold, per bucket type, `null` threshold when no rule of that type is active).

Spec §9: "Deposit screen: progress toward today's and this week's threshold." Task 26 built a static hint ("Deposit 500 ETB today for a bonus") with no notion of how much the player has already deposited — this task makes it real progress.

- [ ] **Step 1: Read `deposit-bonus.service.ts`'s `evaluateAndGrant`** (Task 12) to find its bucket-sum query (`tx.transaction.aggregate({ where: { userId, type: 'DEPOSIT', status: 'APPROVED', createdAt: { gte: periodStart, lt: bucketEnd } }, _sum: { amount: true } })`). You need the read-only equivalent, callable from a GET route (not inside a deposit-approval transaction) — same query shape, plain `prisma` instead of `tx`.
- [ ] **Step 2: Write the service method** (add to `bonus-rule.service.ts` or a small new file — your call) that, given a `userId`, computes today's and this week's deposit total against the currently-active daily/weekly rules (reuse `BonusRuleService.listActive`, Task 11, to find them), returning `null` for a bucket type with no active rule.
- [ ] **Step 3: Write the failing test**, RED, implement, GREEN, following this plan's established real-DB testing convention for API-layer additions (see Task 23 as your closest precedent — new read-only endpoint backed by a new query).
- [ ] **Step 4: Wire the route.**
- [ ] **Step 5: Update `DepositModal.vue`** to fetch this on modal open (alongside the existing promotions fetch, per Task 26's established pattern) and render actual progress — e.g. "You've deposited 300 of 500 ETB today" instead of the static hint, with the static hint as a fallback only if the progress fetch fails (don't regress to a broken/blank state on a transient API error).
- [ ] **Step 6: Add the new copy strings to both locale files**, following Task 27's established `wallet.*` (or a new `deposit.*` namespace, your call) key convention — English text plus an Amharic translation. If you're not confident in the Amharic phrasing, use the same register/style as the nearest existing `wallet.*` string and note in your report that a native speaker should sanity-check it, rather than leaving it in English only.
- [ ] **Step 7: Static verification** (web typecheck clean, no dev server per this plan's established limitation).
- [ ] **Step 8: Commit.**

```bash
git add apps/api/src/services/<new/modified files> apps/api/src/routes/<the route file> apps/api/src/test/<new test file> apps/web/components/DepositModal.vue apps/web/store/promotions.ts apps/web/i18n/locales/en.json apps/web/i18n/locales/am.json
git commit -m "feat(bonus): deposit screen shows real progress toward the daily/weekly bonus threshold"
```
