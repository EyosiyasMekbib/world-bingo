# Game-Scoped Cashback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin scope a `CashbackPromotion` to specific bingo `GameTemplate`(s) and/or specific third-party `ProviderGame`(s), instead of every promotion always summing a player's site-wide net loss.

**Architecture:** Add two Postgres array columns to `CashbackPromotion` (`templateIds`, `providerGameKeys`). `CashbackService` gets a new `getNetLossByUser` method: when both arrays are empty it runs the existing unscoped `groupBy` queries unchanged; when either is non-empty it runs one raw-SQL `UNION ALL` query joining `transactions→games` for bingo and filtering `third_party_transactions` directly for provider games. `checkAndDisburse`'s disbursement loop (grant, ledger, idempotency, notifications) is untouched — it now just iterates a `Map<userId, netLoss>` instead of a `groupBy` result array. The admin route and UI grow a "Games" picker that's optional (empty = today's site-wide behavior).

**Tech Stack:** Fastify v5, Prisma 5 + PostgreSQL, Vitest, Vue 3 / Nuxt 3 + `@nuxt/ui`.

## Global Constraints

- Follow the repo's Prettier config: singleQuote, no semi, trailingComma: all.
- `pnpm --filter @world-bingo/api test` must stay green — the 3 existing tests in `cashback.service.test.ts` exercise the unscoped path and must not change behavior or assertions.
- No edits to `BonusService`, the hourly worker (`cashback-checker.worker.ts`), or the player-facing `CashbackBanner.vue` — out of scope per the spec.
- No migration backfill needed — no `CashbackPromotion` rows exist yet in any real environment.
- Design reference: `docs/superpowers/specs/2026-09-09-game-scoped-cashback-design.md`.

---

## Task 1: Schema migration — add game-scope columns

**Files:**
- Modify: `apps/api/prisma/schema.prisma:451-465` (`CashbackPromotion` model)
- Create: a new migration folder under `apps/api/prisma/migrations/` (name it via the CLI, see Step 2)

**Interfaces:**
- Produces: `CashbackPromotion.templateIds: string[]` (default `[]`), `CashbackPromotion.providerGameKeys: string[]` (default `[]`) — every later task reads/writes these two fields by these exact names.

- [ ] **Step 1: Edit the Prisma model**

Replace the `CashbackPromotion` model at schema.prisma:451-465 with:

```prisma
model CashbackPromotion {
  id               String                 @id @default(uuid())
  name             String
  lossThreshold    Decimal                @db.Decimal(12, 2) // net real-balance loss required to qualify
  refundType       CashbackRefundType // PERCENTAGE or FIXED
  refundValue      Decimal                @db.Decimal(10, 2) // e.g. 10.00 = 10% OR 50.00 = 50 ETB flat
  frequency        CashbackFrequency // evaluation window: DAILY | WEEKLY | MONTHLY
  templateIds      String[]               @default([]) // GameTemplate ids this promotion is scoped to; empty = every bingo template
  providerGameKeys String[]               @default([]) // "<providerId>:<gameCode>" pairs; empty = every provider game
  startsAt         DateTime
  endsAt           DateTime
  isActive         Boolean                @default(true)
  createdAt        DateTime               @default(now())
  disbursements    CashbackDisbursement[]

  @@map("cashback_promotions")
}
```

- [ ] **Step 2: Generate and apply the migration**

Ensure infra is running, then generate the migration:

```bash
pnpm infra:up
```

```bash
cd apps/api && npx prisma migrate dev --name add_cashback_game_scope --env-file ../../.env
```

Expected: a new folder `apps/api/prisma/migrations/<timestamp>_add_cashback_game_scope/migration.sql` is created, containing two `ALTER TABLE "cashback_promotions" ADD COLUMN ... DEFAULT ARRAY[]::TEXT[]` statements, and the Prisma client regenerates without error.

- [ ] **Step 3: Verify the generated client has the new fields**

Run:

```bash
cd apps/api && npx prisma validate --schema prisma/schema.prisma
```

Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(api): add game-scope columns to CashbackPromotion"
```

---

## Task 2: `CashbackService` — scoped net-loss computation

**Files:**
- Modify: `apps/api/src/services/cashback.service.ts`
- Test: `apps/api/src/test/cashback.service.test.ts`

**Interfaces:**
- Consumes: `CashbackPromotion.templateIds: string[]`, `CashbackPromotion.providerGameKeys: string[]` (Task 1).
- Produces: `CashbackService.getNetLossByUser(promotion: { templateIds: string[]; providerGameKeys: string[] }, periodStart: Date, periodEnd: Date): Promise<Map<string, Decimal>>` — later tasks (and `checkAndDisburse` itself) call this by this exact name and signature.

- [ ] **Step 1: Write the failing tests**

Append to the end of `apps/api/src/test/cashback.service.test.ts` (after the closing `})` of the existing `describe` block, i.e. after line 167):

```ts
describe('CashbackService.checkAndDisburse — game scoping', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    async function makeTemplate(suffix: string) {
        return prisma.gameTemplate.create({
            data: {
                title: `Scoped Template ${suffix}`,
                ticketPrice: 10,
                maxPlayers: 70,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE',
            },
        })
    }

    async function makeGameForTemplate(templateId: string | null, suffix: string) {
        return prisma.game.create({
            data: {
                title: `Scoped Game ${suffix}`,
                ticketPrice: 10,
                maxPlayers: 70,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE',
                status: 'COMPLETED',
                calledBalls: [],
                templateId,
            },
        })
    }

    async function makeProviderGame(suffix: string) {
        const provider = await prisma.gameProvider.create({
            data: { code: `prov-scope-${suffix}-${Date.now()}`, name: 'Test Provider', status: 'ACTIVE', apiBaseUrl: '', currency: 'ETB', config: {} },
        })
        const vendor = await prisma.gameVendor.create({
            data: { providerId: provider.id, code: 'V1', name: 'Test Vendor' },
        })
        const game = await prisma.providerGame.create({
            data: {
                providerId: provider.id,
                vendorId: vendor.id,
                gameCode: `GAME-${suffix}`,
                gameName: `Provider Game ${suffix}`,
                categoryCode: 'SLOTS',
                languageCodes: ['en'],
                platformCodes: ['WEB'],
                currencyCodes: ['ETB'],
            },
        })
        return { provider, game }
    }

    it('only counts losses on the scoped bingo template, ignoring losses on other games', async () => {
        const player = await makeUser('scopedbingo1', '+251900000030')
        const inScopeTemplate = await makeTemplate('in')
        const outOfScopeTemplate = await makeTemplate('out')
        const inScopeGame = await makeGameForTemplate(inScopeTemplate.id, 'in')
        const outOfScopeGame = await makeGameForTemplate(outOfScopeTemplate.id, 'out')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Template Scoped', lossThreshold: 50, refundType: 'FIXED', refundValue: 20,
                frequency: 'DAILY', isActive: true, templateIds: [inScopeTemplate.id],
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        // In-scope loss: 100 wagered, 0 won.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED', referenceId: inScopeGame.id },
        })
        // Out-of-scope loss: 500 wagered — must NOT count toward this promotion.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 500, status: 'APPROVED', referenceId: outOfScopeGame.id },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(20)

        const disbursement = await prisma.cashbackDisbursement.findFirstOrThrow({ where: { userId: player.id, promotionId: promotion.id } })
        expect(new Decimal(disbursement.amount).toNumber()).toBe(20)
    })

    it('only counts losses on the scoped provider game', async () => {
        const player = await makeUser('scopedprovider1', '+251900000031')
        const { provider, game } = await makeProviderGame('a')
        const { game: otherGame } = await makeProviderGame('b')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Provider Scoped', lossThreshold: 50, refundType: 'FIXED', refundValue: 15,
                frequency: 'DAILY', isActive: true, providerGameKeys: [`${provider.id}:${game.gameCode}`],
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        // In-scope: net loss of 100 (bet 100, no win).
        await prisma.thirdPartyTransaction.create({
            data: {
                userId: player.id, providerId: provider.id, transactionId: `bet-${Date.now()}-a`,
                gameCode: game.gameCode, type: 'BET', status: 'COMPLETED', amount: -100,
                balanceBefore: 0, balanceAfter: 0,
            },
        })
        // Out-of-scope: a big loss on a different provider game — must NOT count.
        await prisma.thirdPartyTransaction.create({
            data: {
                userId: player.id, providerId: provider.id, transactionId: `bet-${Date.now()}-b`,
                gameCode: otherGame.gameCode, type: 'BET', status: 'COMPLETED', amount: -900,
                balanceBefore: 0, balanceAfter: 0,
            },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(15)
    })

    it('sums losses across a mixed bingo-template + provider-game scope', async () => {
        const player = await makeUser('scopedmixed1', '+251900000032')
        const template = await makeTemplate('mixed')
        const bingoGame = await makeGameForTemplate(template.id, 'mixed')
        const { provider, game: providerGame } = await makeProviderGame('mixed')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Mixed Scoped', lossThreshold: 50, refundType: 'FIXED', refundValue: 25,
                frequency: 'DAILY', isActive: true,
                templateIds: [template.id], providerGameKeys: [`${provider.id}:${providerGame.gameCode}`],
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        // 30 lost on bingo + 30 lost on the provider game = 60 total, clears the 50 threshold.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 30, status: 'APPROVED', referenceId: bingoGame.id },
        })
        await prisma.thirdPartyTransaction.create({
            data: {
                userId: player.id, providerId: provider.id, transactionId: `bet-${Date.now()}-mixed`,
                gameCode: providerGame.gameCode, type: 'BET', status: 'COMPLETED', amount: -30,
                balanceBefore: 0, balanceAfter: 0,
            },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(25)
    })

    it('does not disburse when the scoped loss alone is below threshold, even if site-wide loss would clear it', async () => {
        const player = await makeUser('scopedbelow1', '+251900000033')
        const inScopeTemplate = await makeTemplate('below-in')
        const outOfScopeTemplate = await makeTemplate('below-out')
        const inScopeGame = await makeGameForTemplate(inScopeTemplate.id, 'below-in')
        const outOfScopeGame = await makeGameForTemplate(outOfScopeTemplate.id, 'below-out')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Threshold Scoped', lossThreshold: 100, refundType: 'FIXED', refundValue: 20,
                frequency: 'DAILY', isActive: true, templateIds: [inScopeTemplate.id],
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        // In-scope loss is only 40 — below the 100 threshold.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 40, status: 'APPROVED', referenceId: inScopeGame.id },
        })
        // Out-of-scope loss of 200 would clear the threshold site-wide, but must be ignored.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 200, status: 'APPROVED', referenceId: outOfScopeGame.id },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(0)
        expect(result.skipped).toBe(0)
        const disbursement = await prisma.cashbackDisbursement.findFirst({ where: { userId: player.id, promotionId: promotion.id } })
        expect(disbursement).toBeNull()
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @world-bingo/api test cashback.service.test.ts`
Expected: the 4 new tests FAIL (site-wide behavior currently ignores scope — e.g. the "ignoring losses on other games" test will see `disbursed: 1` but `total: 120` instead of `20`, or similar over-counting), while the 3 pre-existing tests still PASS.

- [ ] **Step 3: Implement `getNetLossByUser` and refactor `checkAndDisburse`**

Add the `Prisma` import and the new method to `apps/api/src/services/cashback.service.ts`. First, update the import line at the top of the file:

```ts
import prisma from '../lib/prisma'
import { Prisma } from '@prisma/client'
import { TransactionType, PaymentStatus, NotificationType, CashbackRefundType, CashbackFrequency } from '@world-bingo/shared-types'
import { Decimal } from '@prisma/client/runtime/library'
import { NotificationService } from './notification.service'
import { BonusService } from './bonus.service'
import { captureEvent } from '../lib/posthog'
```

Then insert this new static method into the `CashbackService` class, directly above `checkAndDisburse`:

```ts
    /**
     * Net loss (wagered − won) per user within [periodStart, periodEnd],
     * restricted to the promotion's game scope. Empty templateIds AND empty
     * providerGameKeys means unscoped — every bingo and provider game counts,
     * matching site-wide behavior.
     */
    static async getNetLossByUser(
        promotion: { templateIds: string[]; providerGameKeys: string[] },
        periodStart: Date,
        periodEnd: Date,
    ): Promise<Map<string, Decimal>> {
        const templateIds = promotion.templateIds ?? []
        const providerGameKeys = promotion.providerGameKeys ?? []

        if (templateIds.length === 0 && providerGameKeys.length === 0) {
            const entries = await prisma.transaction.groupBy({
                by: ['userId'],
                where: {
                    type: TransactionType.GAME_ENTRY,
                    status: PaymentStatus.APPROVED,
                    createdAt: { gte: periodStart, lte: periodEnd },
                },
                _sum: { amount: true },
            })

            const wins = await prisma.transaction.groupBy({
                by: ['userId'],
                where: {
                    type: TransactionType.PRIZE_WIN,
                    status: PaymentStatus.APPROVED,
                    createdAt: { gte: periodStart, lte: periodEnd },
                },
                _sum: { amount: true },
            })

            const winMap = new Map(wins.map((w) => [w.userId, new Decimal(w._sum.amount ?? 0)]))
            const result = new Map<string, Decimal>()
            for (const entry of entries) {
                const wagered = new Decimal(entry._sum.amount ?? 0)
                const won = winMap.get(entry.userId) ?? new Decimal(0)
                result.set(entry.userId, wagered.minus(won))
            }
            return result
        }

        const providerPairs = providerGameKeys
            .map((key) => {
                const separatorIndex = key.indexOf(':')
                if (separatorIndex === -1) return null
                return { providerId: key.slice(0, separatorIndex), gameCode: key.slice(separatorIndex + 1) }
            })
            .filter((pair): pair is { providerId: string; gameCode: string } => pair !== null)

        const bingoFilter = templateIds.length > 0
            ? Prisma.sql`AND g."templateId" = ANY(${templateIds}::text[])`
            : Prisma.sql`AND false`

        const providerFilter = providerPairs.length > 0
            ? Prisma.sql`AND (tpt."providerId", tpt."gameCode") IN (${Prisma.join(
                  providerPairs.map((p) => Prisma.sql`(${p.providerId}, ${p.gameCode})`),
              )})`
            : Prisma.sql`AND false`

        const rows = await prisma.$queryRaw<Array<{ userId: string; netLoss: Decimal }>>(Prisma.sql`
            WITH bingo_loss AS (
                SELECT t."userId",
                       SUM(CASE WHEN t.type = 'GAME_ENTRY' THEN t.amount ELSE 0 END) -
                       SUM(CASE WHEN t.type = 'PRIZE_WIN' THEN t.amount ELSE 0 END) AS "netLoss"
                FROM transactions t
                JOIN games g ON g.id = t."referenceId"
                WHERE t.status = 'APPROVED'
                  AND t.type IN ('GAME_ENTRY', 'PRIZE_WIN')
                  AND t."createdAt" BETWEEN ${periodStart} AND ${periodEnd}
                  ${bingoFilter}
                GROUP BY t."userId"
            ),
            provider_loss AS (
                SELECT tpt."userId", -SUM(tpt.amount) AS "netLoss"
                FROM third_party_transactions tpt
                WHERE tpt.status = 'COMPLETED'
                  AND tpt."createdAt" BETWEEN ${periodStart} AND ${periodEnd}
                  ${providerFilter}
                GROUP BY tpt."userId"
            )
            SELECT "userId", SUM("netLoss") AS "netLoss"
            FROM (SELECT * FROM bingo_loss UNION ALL SELECT * FROM provider_loss) combined
            GROUP BY "userId"
        `)

        const result = new Map<string, Decimal>()
        for (const row of rows) {
            result.set(row.userId, new Decimal(row.netLoss))
        }
        return result
    }
```

Now replace the body of `checkAndDisburse` (the existing lines from `const promotion = await prisma.cashbackPromotion.findUnique(...)` through the final `return { disbursed, skipped, total }`) with:

```ts
    static async checkAndDisburse(
        promotionId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<{ disbursed: number; skipped: number; total: Decimal }> {
        const promotion = await prisma.cashbackPromotion.findUnique({ where: { id: promotionId } })
        if (!promotion || !promotion.isActive) return { disbursed: 0, skipped: 0, total: new Decimal(0) }

        const netLossByUser = await CashbackService.getNetLossByUser(promotion, periodStart, periodEnd)

        const lossThreshold = new Decimal(promotion.lossThreshold)
        const refundValue = new Decimal(promotion.refundValue)

        // Filter out bots
        const userIds = [...netLossByUser.keys()]
        const botUserIds = new Set<string>()
        if (userIds.length > 0) {
            const botUsers = await prisma.user.findMany({
                where: { id: { in: userIds }, username: { startsWith: 'bot_t' } },
                select: { id: true },
            })
            for (const b of botUsers) botUserIds.add(b.id)
        }

        let disbursed = 0
        let skipped = 0
        let total = new Decimal(0)

        for (const [userId, netLoss] of netLossByUser) {
            if (botUserIds.has(userId)) continue

            // Qualifies when netLoss >= lossThreshold (inclusive boundary)
            if (netLoss.lt(lossThreshold)) continue

            // Calculate cashback amount. Rounded down to 2dp: a PERCENTAGE payout
            // can otherwise carry more precision than bonus_grants' Decimal(12,2)
            // can hold, silently truncating there while wallets.bonusBalance
            // (Decimal(20,8)) keeps the extra digits — permanent drift on every
            // percentage disbursement. BonusService.grant() also rounds
            // defensively, so this is belt-and-suspenders for this call site.
            const cashbackAmount =
                promotion.refundType === CashbackRefundType.PERCENTAGE
                    ? netLoss.times(refundValue.div(100)).toDecimalPlaces(2, Decimal.ROUND_DOWN)
                    : refundValue

            if (cashbackAmount.lte(0)) continue

            const result = await prisma.$transaction(async (tx) => {
                // Idempotency: unique constraint on (promotionId, userId, periodStart)
                const existing = await tx.cashbackDisbursement.findUnique({
                    where: {
                        promotionId_userId_periodStart: { promotionId, userId, periodStart },
                    },
                })
                if (existing) return 'skipped'

                // BonusService.grant() reads the wallet with a plain, unlocked
                // SELECT — it assumes the caller already holds a FOR UPDATE lock
                // on the wallet row in this same transaction (the Global
                // Constraint every other BonusService caller follows; see
                // game.service.ts's joinGame). Without it, two disbursements
                // racing for the same player can each read a stale
                // bonusBalance and record a wrong bonusBalanceBefore in their
                // audit row.
                await tx.$queryRaw`
                    SELECT id FROM wallets WHERE "userId" = ${userId} FOR UPDATE
                `

                const grantResult = await BonusService.grant(tx, {
                    userId,
                    amount: cashbackAmount,
                    source: 'CASHBACK',
                })
                if (!grantResult.granted) return 'skipped'

                await tx.transaction.create({
                    data: {
                        userId,
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

                // Record disbursement
                await tx.cashbackDisbursement.create({
                    data: {
                        promotionId,
                        userId,
                        amount: cashbackAmount,
                        periodStart,
                        periodEnd,
                    },
                })

                return cashbackAmount
            })

            if (result === 'skipped') {
                skipped++
            } else {
                disbursed++
                total = total.plus(result as Decimal)
                void captureEvent(userId, 'bonus_granted', {
                    amount: Number(result as Decimal),
                    source: 'CASHBACK',
                    rule_id: promotionId,
                })

                // Push notification (fire-and-forget)
                NotificationService.create(
                    userId,
                    NotificationType.CASHBACK_AWARDED,
                    'Cashback Bonus!',
                    `You received ${Number(result as Decimal).toFixed(2)} ETB cashback from "${promotion.name}".`,
                    { promotionId, amount: (result as Decimal).toFixed(2) },
                ).catch(() => {})
            }
        }

        return { disbursed, skipped, total }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @world-bingo/api test cashback.service.test.ts`
Expected: all 7 tests PASS (3 pre-existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/cashback.service.ts apps/api/src/test/cashback.service.test.ts
git commit -m "feat(api): scope cashback net-loss calculation to specific games"
```

---

## Task 3: Admin route — accept and surface game scope

**Files:**
- Modify: `apps/api/src/services/cashback.service.ts` (`createPromotion`, `listPromotions`)
- Modify: `apps/api/src/routes/admin/index.ts:66-77` (`cashbackCreateSchema`), `apps/api/src/routes/admin/index.ts:669-674` (POST handler)
- Modify: `apps/admin/composables/useAdminApi.ts:499-507` (`createCashbackPromotion` type)

**Interfaces:**
- Consumes: `CashbackService.getNetLossByUser` is unaffected by this task.
- Produces: `CashbackService.createPromotion(data)` accepts optional `templateIds?: string[]` and `providerGameKeys?: string[]`. `CashbackService.listPromotions()` return items grow a `scopedGameNames: string[]` field — Task 4's UI reads this exact field name.

- [ ] **Step 1: Update `CashbackService.createPromotion` and `listPromotions`**

In `apps/api/src/services/cashback.service.ts`, replace the `createPromotion` method with:

```ts
    /**
     * Create a new cashback promotion.
     */
    static async createPromotion(data: {
        name: string
        lossThreshold: number
        refundType: CashbackRefundType
        refundValue: number
        frequency: CashbackFrequency
        startsAt: string
        endsAt: string
        templateIds?: string[]
        providerGameKeys?: string[]
    }) {
        return prisma.cashbackPromotion.create({
            data: {
                name: data.name,
                lossThreshold: data.lossThreshold,
                refundType: data.refundType,
                refundValue: data.refundValue,
                frequency: data.frequency,
                startsAt: new Date(data.startsAt),
                endsAt: new Date(data.endsAt),
                templateIds: data.templateIds ?? [],
                providerGameKeys: data.providerGameKeys ?? [],
            },
        })
    }
```

Replace the `listPromotions` method with:

```ts
    /**
     * List all promotions, newest first. Resolves each promotion's game
     * scope into display names so the admin UI needs no second round-trip.
     */
    static async listPromotions() {
        const promotions = await prisma.cashbackPromotion.findMany({
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { disbursements: true } } },
        })

        const allTemplateIds = [...new Set(promotions.flatMap((p) => p.templateIds))]
        const allProviderGameKeys = [...new Set(promotions.flatMap((p) => p.providerGameKeys))]

        const templates = allTemplateIds.length > 0
            ? await prisma.gameTemplate.findMany({ where: { id: { in: allTemplateIds } }, select: { id: true, title: true } })
            : []
        const templateTitleById = new Map(templates.map((t) => [t.id, t.title]))

        const providerPairs = allProviderGameKeys
            .map((key) => {
                const separatorIndex = key.indexOf(':')
                if (separatorIndex === -1) return null
                return { key, providerId: key.slice(0, separatorIndex), gameCode: key.slice(separatorIndex + 1) }
            })
            .filter((p): p is { key: string; providerId: string; gameCode: string } => p !== null)

        const providerGames = providerPairs.length > 0
            ? await prisma.providerGame.findMany({
                  where: { OR: providerPairs.map((p) => ({ providerId: p.providerId, gameCode: p.gameCode })) },
                  select: { providerId: true, gameCode: true, gameName: true },
              })
            : []
        const providerGameNameByKey = new Map(providerGames.map((g) => [`${g.providerId}:${g.gameCode}`, g.gameName]))

        return promotions.map((promotion) => ({
            ...promotion,
            scopedGameNames: [
                ...promotion.templateIds.map((id) => templateTitleById.get(id) ?? 'Unknown template'),
                ...promotion.providerGameKeys.map((key) => providerGameNameByKey.get(key) ?? 'Unknown game'),
            ],
        }))
    }
```

- [ ] **Step 2: Extend the admin route schema and handler**

In `apps/api/src/routes/admin/index.ts`, replace the `cashbackCreateSchema` (lines 66-77) with:

```ts
const cashbackCreateSchema = z.object({
    name: z.string().min(1),
    lossThreshold: z.coerce.number().min(1),
    refundType: z.enum(['PERCENTAGE', 'FIXED']),
    refundValue: z.coerce.number().positive().max(100000),
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
    startsAt: z.string(),
    endsAt: z.string(),
    templateIds: z.array(z.string().uuid()).default([]),
    providerGameKeys: z.array(z.string()).default([]),
}).refine(
    (data) => new Date(data.startsAt) < new Date(data.endsAt),
    { message: 'endsAt must be after startsAt', path: ['endsAt'] }
)
```

Replace the `f.post('/cashback', ...)` handler (lines 669-674) with:

```ts
        f.post('/cashback', async (req: any, reply) => {
            const parsed = cashbackCreateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            const { name, lossThreshold, refundType, refundValue, frequency, startsAt, endsAt, templateIds, providerGameKeys } = parsed.data
            return CashbackService.createPromotion({ name, lossThreshold, refundType: refundType as any, refundValue, frequency: frequency as any, startsAt, endsAt, templateIds, providerGameKeys })
        })
```

- [ ] **Step 3: Update the admin composable's type**

In `apps/admin/composables/useAdminApi.ts`, replace the `createCashbackPromotion` entry (lines 499-507) with:

```ts
        createCashbackPromotion: (data: {
            name: string
            lossThreshold: number
            refundType: 'PERCENTAGE' | 'FIXED'
            refundValue: number
            frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
            startsAt: string
            endsAt: string
            templateIds?: string[]
            providerGameKeys?: string[]
        }) => apiFetch('/admin/cashback', { method: 'POST', body: data }),
```

- [ ] **Step 4: Add a test for name resolution**

Append to `apps/api/src/test/cashback.service.test.ts`, inside the `describe('CashbackService.checkAndDisburse — game scoping', ...)` block added in Task 2 (before its closing `})`):

```ts
    it('listPromotions resolves scoped template and provider game ids into display names', async () => {
        const template = await makeTemplate('listed')
        const { provider, game } = await makeProviderGame('listed')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Listed Scoped', lossThreshold: 50, refundType: 'FIXED', refundValue: 10,
                frequency: 'DAILY', isActive: true,
                templateIds: [template.id], providerGameKeys: [`${provider.id}:${game.gameCode}`],
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        const list = await CashbackService.listPromotions()
        const found = list.find((p) => p.id === promotion.id)

        expect(found?.scopedGameNames).toEqual([template.title, game.gameName])
    })
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @world-bingo/api test cashback.service.test.ts`
Expected: all 8 tests PASS.

- [ ] **Step 6: Typecheck the API**

Run: `pnpm --filter @world-bingo/api typecheck`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/cashback.service.ts apps/api/src/routes/admin/index.ts apps/admin/composables/useAdminApi.ts apps/api/src/test/cashback.service.test.ts
git commit -m "feat(api): accept and resolve game scope on cashback promotions"
```

---

## Task 4: Admin UI — game picker in the create modal

**Files:**
- Modify: `apps/admin/pages/cashback/index.vue`

**Interfaces:**
- Consumes: `useAdminApi().getGameTemplates(): Promise<any[]>` (existing), `useAdminApi().getProviders(): Promise<any[]>` (existing), `useAdminApi().getProviderGames(code, params): Promise<{ data: any[] }>` (existing), `CashbackService.listPromotions()`'s `scopedGameNames: string[]` field (Task 3), `createCashbackPromotion`'s `templateIds?`/`providerGameKeys?` params (Task 3).

- [ ] **Step 1: Add game-scope state and fetchers to the script**

In `apps/admin/pages/cashback/index.vue`, replace line 4 (`const { getCashbackPromotions, createCashbackPromotion, toggleCashbackPromotion } = useAdminApi()`) with:

```ts
const { getCashbackPromotions, createCashbackPromotion, toggleCashbackPromotion, getGameTemplates, getProviders, getProviderGames } = useAdminApi()
```

Add this new state after the existing `form` reactive object (after line 20):

```ts
const templates = ref<any[]>([])
const providers = ref<any[]>([])
const selectedTemplateIds = ref<string[]>([])
const providerGameQuery = ref('')
const providerGameResults = ref<any[]>([])
const selectedProviderGames = ref<Array<{ providerId: string; gameCode: string; gameName: string }>>([])
const loadingProviderGames = ref(false)
let providerGameSearchTimer: ReturnType<typeof setTimeout> | undefined

const primaryProvider = computed(() => providers.value.find((p: any) => p.isPrimary) ?? providers.value[0] ?? null)
```

Add these functions after `fetchPromotions` (after line 46):

```ts
async function fetchTemplates() {
  templates.value = (await getGameTemplates()) as any[] ?? []
}

async function fetchProviders() {
  providers.value = (await getProviders()) as any[] ?? []
}

function onProviderGameSearch() {
  if (providerGameSearchTimer) clearTimeout(providerGameSearchTimer)
  providerGameSearchTimer = setTimeout(async () => {
    if (!primaryProvider.value) return
    loadingProviderGames.value = true
    try {
      const res = await getProviderGames(primaryProvider.value.code, { search: providerGameQuery.value, limit: 20 })
      providerGameResults.value = (res as any)?.data ?? []
    } finally {
      loadingProviderGames.value = false
    }
  }, 300)
}

function isProviderGameSelected(game: any) {
  return selectedProviderGames.value.some((g) => g.providerId === game.providerId && g.gameCode === game.gameCode)
}

function toggleProviderGame(game: any) {
  const idx = selectedProviderGames.value.findIndex((g) => g.providerId === game.providerId && g.gameCode === game.gameCode)
  if (idx >= 0) selectedProviderGames.value.splice(idx, 1)
  else selectedProviderGames.value.push({ providerId: game.providerId, gameCode: game.gameCode, gameName: game.gameName })
}
```

- [ ] **Step 2: Wire the game scope into `create()` and reset it after success**

Replace the `create()` function (lines 48-79) with:

```ts
async function create() {
  if (!form.name.trim() || !form.startsAt || !form.endsAt) {
    toast.add({ title: 'Missing fields', description: 'Name, Period Start and Period End are required', color: 'error' })
    return
  }
  creating.value = true
  try {
    await createCashbackPromotion({
      name: form.name,
      lossThreshold: form.lossThreshold,
      refundType: form.refundType,
      refundValue: form.refundValue,
      frequency: form.frequency,
      startsAt: new Date(form.startsAt).toISOString(),
      endsAt: new Date(form.endsAt).toISOString(),
      templateIds: selectedTemplateIds.value,
      providerGameKeys: selectedProviderGames.value.map((g) => `${g.providerId}:${g.gameCode}`),
    })
    toast.add({ title: 'Created', description: 'Cashback promotion created', color: 'success' })
    showCreate.value = false
    form.name = ''
    form.lossThreshold = 500
    form.refundType = 'PERCENTAGE'
    form.refundValue = 10
    form.frequency = 'WEEKLY'
    form.startsAt = ''
    form.endsAt = ''
    selectedTemplateIds.value = []
    selectedProviderGames.value = []
    providerGameQuery.value = ''
    providerGameResults.value = []
    await fetchPromotions()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to create', color: 'error' })
  } finally {
    creating.value = false
  }
}
```

- [ ] **Step 3: Show the scope in `describePromo` and fetch templates/providers on mount**

Replace `describePromo` (lines 95-102) with:

```ts
function describePromo(promo: any) {
  const threshold = Number(promo.lossThreshold).toFixed(0)
  const val = promo.refundType === 'PERCENTAGE'
    ? `${Number(promo.refundValue).toFixed(0)}% back`
    : `${Number(promo.refundValue).toFixed(2)} ETB back`
  const freq = (promo.frequency as string).toLowerCase()
  const scope = promo.scopedGameNames?.length ? ` on ${promo.scopedGameNames.join(', ')}` : ''
  return `Lose ${threshold} ETB${scope} → get ${val} · ${freq}`
}
```

Replace `onMounted(fetchPromotions)` (line 104) with:

```ts
onMounted(() => {
  fetchPromotions()
  fetchTemplates()
  fetchProviders()
})
```

- [ ] **Step 4: Add the picker UI to the create modal**

In the `<template>`, inside the `<UModal>`'s `#body` slot, insert this new block right after the `Frequency` `<UFormField>` (after line 165, before the `Period Start` field):

```html
          <UFormField label="Bingo Templates (optional — leave empty for site-wide)">
            <div class="space-y-1 max-h-32 overflow-y-auto border border-(--surface-border) rounded-lg p-2">
              <label v-for="t in templates" :key="t.id" class="flex items-center gap-2 text-sm text-white/80">
                <input type="checkbox" :value="t.id" v-model="selectedTemplateIds" class="accent-primary-500" />
                {{ t.title }}
              </label>
              <p v-if="!templates.length" class="text-xs text-white/30">No templates found</p>
            </div>
          </UFormField>
          <UFormField label="Provider Games (optional)">
            <UInput v-model="providerGameQuery" placeholder="Search provider games..." class="w-full mb-2" @input="onProviderGameSearch" />
            <div class="space-y-1 max-h-32 overflow-y-auto border border-(--surface-border) rounded-lg p-2">
              <p v-if="loadingProviderGames" class="text-xs text-white/30">Searching...</p>
              <label v-for="g in providerGameResults" :key="`${g.providerId}-${g.gameCode}`" class="flex items-center gap-2 text-sm text-white/80">
                <input type="checkbox" :checked="isProviderGameSelected(g)" @change="toggleProviderGame(g)" class="accent-primary-500" />
                {{ g.gameName }}
              </label>
            </div>
            <div v-if="selectedProviderGames.length" class="flex flex-wrap gap-1 mt-2">
              <UBadge v-for="g in selectedProviderGames" :key="`${g.providerId}-${g.gameCode}`" color="primary" variant="soft" :label="g.gameName" />
            </div>
          </UFormField>
```

- [ ] **Step 5: Typecheck the admin app**

Run: `pnpm --filter @world-bingo/admin typecheck`
Expected: no new errors introduced by this file. (Per project memory, admin typecheck may already carry pre-existing unrelated errors — confirm by checking that `cashback/index.vue` doesn't appear in the output, not that the overall command exits 0.)

- [ ] **Step 6: Manual verification in the browser**

Start infra and the admin app dev server, open `/cashback`, click "New Promotion", confirm:
- The Bingo Templates checkbox list populates with real templates.
- Typing in the Provider Games search box returns results after ~300ms.
- Selecting templates/provider games shows badges and doesn't error.
- Submitting with the picker empty still creates a site-wide promotion (regression check).
- Submitting with a template selected creates a promotion whose card shows "... on <template title> ...".

- [ ] **Step 7: Commit**

```bash
git add apps/admin/pages/cashback/index.vue
git commit -m "feat(admin): add game picker to cashback promotion creation"
```

---

## Task 5: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full API test suite**

Run: `pnpm --filter @world-bingo/api test`
Expected: no new failures. (Per project memory, this suite carries ~21 pre-existing environmental failures unrelated to this change — grep the output for `cashback` and confirm every cashback-related test passes, rather than trusting the overall exit code.)

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: no new errors in `apps/api` or the cashback-related files in `apps/admin`.

- [ ] **Step 3: Confirm the migration applies cleanly to a fresh database**

Run: `pnpm --filter @world-bingo/api db:migrate` (with infra up)
Expected: `add_cashback_game_scope` is already applied (no-op) or applies cleanly if this is a fresh DB.
