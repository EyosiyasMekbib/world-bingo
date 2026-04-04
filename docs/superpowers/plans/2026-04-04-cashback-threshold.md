# Cashback Threshold-Based Auto-Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual cashback disburse system with an automatic threshold-based system: when a player's net real-balance loss within a configurable frequency window (daily/weekly/monthly) reaches a configured threshold, they are automatically credited a cashback bonus (percentage or fixed) to their bonus balance.

**Architecture:** Schema migration extends `CashbackPromotion` with four new fields and fixes the `CashbackDisbursement` unique constraint. `CashbackService` is rewritten — `disburse()` removed, `checkAndDisburse()` added. A new BullMQ repeatable worker (`cashback-checker`) runs hourly and calls `checkAndDisburse()` per active promotion. API route removes the manual disburse endpoint and updates create/list. Admin UI updates the create form and removes the Disburse button.

**Tech Stack:** Fastify v5, Prisma 5 / PostgreSQL, BullMQ + Redis, Vitest (backend tests), Nuxt 3, `@nuxt/ui`, `useAdminApi` composable.

---

## File Map

| File | Change |
|------|--------|
| `apps/api/prisma/schema.prisma` | Add enums + new fields to `CashbackPromotion`, fix `CashbackDisbursement` unique constraint |
| `apps/api/prisma/migrations/` | New Prisma migration |
| `packages/shared-types/src/enums/index.ts` | Add `CashbackRefundType` and `CashbackFrequency` enums |
| `packages/shared-types/src/index.ts` | Re-export new enums |
| `apps/api/src/services/cashback.service.ts` | Full rewrite — new fields, remove `disburse()`, add `checkAndDisburse()` |
| `apps/api/src/workers/cashback-checker.worker.ts` | New hourly repeatable BullMQ worker |
| `apps/api/src/lib/queue.ts` | Add `CASHBACK_CHECKER` to `QUEUE_NAMES` |
| `apps/api/src/index.ts` | Import new worker so it auto-starts |
| `apps/api/src/routes/admin/index.ts` | Update cashback routes: new create schema, remove disburse endpoint |
| `apps/admin/composables/useAdminApi.ts` | Update `createCashbackPromotion` signature, remove `disburseCashback` |
| `apps/admin/pages/cashback/index.vue` | Update create form fields, remove Disburse button |

---

## Task 1: Schema — extend `CashbackPromotion` and fix `CashbackDisbursement`

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

- [ ] **Step 1: Add new enums to schema**

In `apps/api/prisma/schema.prisma`, add these two enums after the `TournamentStatus` enum (around line 296):

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

- [ ] **Step 2: Replace `CashbackPromotion` fields**

Replace the existing `CashbackPromotion` model (lines 350–361):

```prisma
model CashbackPromotion {
  id             String                 @id @default(uuid())
  name           String
  lossThreshold  Decimal                @db.Decimal(12, 2)   // net real-balance loss required to qualify
  refundType     CashbackRefundType                          // PERCENTAGE or FIXED
  refundValue    Decimal                @db.Decimal(10, 2)   // e.g. 10.00 = 10% OR 50.00 = 50 ETB flat
  frequency      CashbackFrequency                          // evaluation window: DAILY | WEEKLY | MONTHLY
  startsAt       DateTime
  endsAt         DateTime
  isActive       Boolean                @default(true)
  createdAt      DateTime               @default(now())
  disbursements  CashbackDisbursement[]

  @@map("cashback_promotions")
}
```

- [ ] **Step 3: Fix `CashbackDisbursement` unique constraint**

Replace the existing `CashbackDisbursement` model (lines 363–376):

```prisma
model CashbackDisbursement {
  id           String            @id @default(uuid())
  promotionId  String
  userId       String
  amount       Decimal           @db.Decimal(12, 2)
  periodStart  DateTime
  periodEnd    DateTime
  createdAt    DateTime          @default(now())
  promotion    CashbackPromotion @relation(fields: [promotionId], references: [id])
  user         User              @relation(fields: [userId], references: [id])

  @@unique([promotionId, userId, periodStart])
  @@index([promotionId, periodStart])
  @@map("cashback_disbursements")
}
```

- [ ] **Step 4: Run Prisma migration**

```bash
cd apps/api
pnpm db:migrate
```

When prompted, name the migration: `cashback_threshold_based`

Expected output: `✔ Generated Prisma Client` with no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(cashback): migrate schema to threshold-based promotion model"
```

---

## Task 2: Shared types — add new enums

**Files:**
- Modify: `packages/shared-types/src/enums/index.ts`

- [ ] **Step 1: Add `CashbackRefundType` and `CashbackFrequency` enums**

At the end of `packages/shared-types/src/enums/index.ts`, add:

```typescript
export enum CashbackRefundType {
    PERCENTAGE = 'PERCENTAGE',
    FIXED = 'FIXED',
}

export enum CashbackFrequency {
    DAILY = 'DAILY',
    WEEKLY = 'WEEKLY',
    MONTHLY = 'MONTHLY',
}
```

- [ ] **Step 2: Verify the enums are exported from the package root**

Open `packages/shared-types/src/index.ts` and confirm it has a line that exports from enums:

```typescript
export * from './enums/index.js'
```

If it does, no change needed. If it doesn't, add that line.

- [ ] **Step 3: Build shared-types to verify no compile errors**

```bash
pnpm --filter @world-bingo/shared-types build
```

Expected: build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared-types/src/enums/index.ts
git commit -m "feat(shared-types): add CashbackRefundType and CashbackFrequency enums"
```

---

## Task 3: Rewrite `CashbackService`

**Files:**
- Modify: `apps/api/src/services/cashback.service.ts`

- [ ] **Step 1: Rewrite the service**

Replace the entire contents of `apps/api/src/services/cashback.service.ts`:

```typescript
import prisma from '../lib/prisma'
import { TransactionType, PaymentStatus, NotificationType, CashbackRefundType, CashbackFrequency } from '@world-bingo/shared-types'
import { Decimal } from '@prisma/client/runtime/library'
import { NotificationService } from './notification.service'

/**
 * Compute the start and end of the current frequency window (UTC).
 */
export function getCurrentPeriod(frequency: CashbackFrequency, now = new Date()): { periodStart: Date; periodEnd: Date } {
    const y = now.getUTCFullYear()
    const m = now.getUTCMonth()
    const d = now.getUTCDate()
    const day = now.getUTCDay() // 0 = Sunday

    if (frequency === CashbackFrequency.DAILY) {
        const periodStart = new Date(Date.UTC(y, m, d, 0, 0, 0, 0))
        const periodEnd = new Date(Date.UTC(y, m, d, 23, 59, 59, 999))
        return { periodStart, periodEnd }
    }

    if (frequency === CashbackFrequency.WEEKLY) {
        // ISO week: Monday = start
        const daysFromMonday = (day === 0 ? 6 : day - 1)
        const mondayDate = d - daysFromMonday
        const periodStart = new Date(Date.UTC(y, m, mondayDate, 0, 0, 0, 0))
        const periodEnd = new Date(Date.UTC(y, m, mondayDate + 6, 23, 59, 59, 999))
        return { periodStart, periodEnd }
    }

    // MONTHLY
    const periodStart = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0))
    const periodEnd = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999)) // last day of month
    return { periodStart, periodEnd }
}

export class CashbackService {
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
            },
        })
    }

    /**
     * List all promotions, newest first.
     */
    static async listPromotions() {
        return prisma.cashbackPromotion.findMany({
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { disbursements: true } } },
        })
    }

    /**
     * Toggle a promotion's isActive flag.
     */
    static async togglePromotion(id: string, isActive: boolean) {
        return prisma.cashbackPromotion.update({
            where: { id },
            data: { isActive },
        })
    }

    /**
     * Check all active promotions and disburse cashback to qualifying players.
     * Called hourly by the cashback-checker worker.
     *
     * For each active promotion in its date range:
     *   - Compute current frequency window (DAILY/WEEKLY/MONTHLY)
     *   - Find players whose net real-balance loss >= lossThreshold in window
     *   - Skip players already paid in this window (idempotent via unique constraint)
     *   - Credit bonusBalance and record disbursement
     */
    static async runChecks(): Promise<{ promotionsChecked: number; totalDisbursed: number; totalAmount: Decimal }> {
        const now = new Date()

        const activePromotions = await prisma.cashbackPromotion.findMany({
            where: {
                isActive: true,
                startsAt: { lte: now },
                endsAt: { gte: now },
            },
        })

        let totalDisbursed = 0
        let totalAmount = new Decimal(0)

        for (const promotion of activePromotions) {
            const { periodStart, periodEnd } = getCurrentPeriod(promotion.frequency as CashbackFrequency, now)
            const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)
            totalDisbursed += result.disbursed
            totalAmount = totalAmount.plus(result.total)
        }

        return { promotionsChecked: activePromotions.length, totalDisbursed, totalAmount }
    }

    /**
     * Check and disburse cashback for one promotion within one period window.
     * Idempotent: safe to call multiple times for the same (promotionId, periodStart).
     */
    static async checkAndDisburse(
        promotionId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<{ disbursed: number; skipped: number; total: Decimal }> {
        const promotion = await prisma.cashbackPromotion.findUnique({ where: { id: promotionId } })
        if (!promotion || !promotion.isActive) return { disbursed: 0, skipped: 0, total: new Decimal(0) }

        // Sum GAME_ENTRY amounts per user in the window (real balance losses)
        const entries = await prisma.transaction.groupBy({
            by: ['userId'],
            where: {
                type: TransactionType.GAME_ENTRY,
                status: PaymentStatus.APPROVED,
                createdAt: { gte: periodStart, lte: periodEnd },
            },
            _sum: { amount: true },
        })

        // Sum PRIZE_WIN amounts per user in the window
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
        const lossThreshold = new Decimal(promotion.lossThreshold)
        const refundValue = new Decimal(promotion.refundValue)

        // Filter out bots
        const userIds = entries.map((e) => e.userId)
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

        for (const entry of entries) {
            if (botUserIds.has(entry.userId)) continue

            const totalWagered = new Decimal(entry._sum.amount ?? 0)
            const totalWon = winMap.get(entry.userId) ?? new Decimal(0)
            const netLoss = totalWagered.minus(totalWon)

            if (netLoss.lt(lossThreshold)) continue

            // Calculate cashback amount
            const cashbackAmount =
                promotion.refundType === CashbackRefundType.PERCENTAGE
                    ? netLoss.times(refundValue.div(100))
                    : refundValue

            if (cashbackAmount.lte(0)) continue

            const result = await prisma.$transaction(async (tx) => {
                // Idempotency: unique constraint on (promotionId, userId, periodStart)
                const existing = await tx.cashbackDisbursement.findUnique({
                    where: {
                        promotionId_userId_periodStart: { promotionId, userId: entry.userId, periodStart },
                    },
                })
                if (existing) return 'skipped'

                // Lock wallet
                const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                    SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${entry.userId} FOR UPDATE
                `
                const wallet = wallets[0]
                if (!wallet) return 'skipped'

                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const bonusAfter = bonusBefore.plus(cashbackAmount)

                // Credit bonusBalance
                await tx.wallet.update({
                    where: { userId: entry.userId },
                    data: { bonusBalance: { increment: cashbackAmount } },
                })

                // Record transaction
                await tx.transaction.create({
                    data: {
                        userId: entry.userId,
                        type: TransactionType.CASHBACK_BONUS,
                        amount: cashbackAmount,
                        status: PaymentStatus.APPROVED,
                        referenceId: promotionId,
                        note: `Cashback: ${promotion.name}`,
                        balanceBefore: realBefore,
                        balanceAfter: realBefore,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: bonusAfter,
                    },
                })

                // Record disbursement
                await tx.cashbackDisbursement.create({
                    data: {
                        promotionId,
                        userId: entry.userId,
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

                // Push notification (fire-and-forget)
                NotificationService.create(
                    entry.userId,
                    NotificationType.CASHBACK_AWARDED,
                    'Cashback Bonus!',
                    `You received ${Number(result as Decimal).toFixed(2)} ETB cashback from "${promotion.name}".`,
                    { promotionId, amount: Number(result) },
                ).catch(() => {})
            }
        }

        return { disbursed, skipped, total }
    }
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
pnpm --filter @world-bingo/api typecheck
```

Expected: no errors related to cashback.service.ts.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/cashback.service.ts
git commit -m "feat(cashback): rewrite service for threshold-based auto-disbursement"
```

---

## Task 4: Add `CASHBACK_CHECKER` to queue names

**Files:**
- Modify: `apps/api/src/lib/queue.ts`

- [ ] **Step 1: Add the queue name**

In `apps/api/src/lib/queue.ts`, add `CASHBACK_CHECKER` to the `QUEUE_NAMES` object:

```typescript
export const QUEUE_NAMES = {
    REFUND: 'refund',
    NOTIFICATION: 'notification',
    WITHDRAWAL: 'withdrawal',
    GAME_ENGINE: 'game-engine',
    GAME_SCHEDULER: 'game-scheduler',
    GAME_COUNTDOWN: 'game-countdown',
    GAME_CATALOG_SYNC: 'game-catalog-sync',
    CASHBACK_CHECKER: 'cashback-checker',
} as const
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/queue.ts
git commit -m "feat(cashback): add cashback-checker queue name"
```

---

## Task 5: Create `cashback-checker.worker.ts`

**Files:**
- Create: `apps/api/src/workers/cashback-checker.worker.ts`

- [ ] **Step 1: Create the worker file**

Create `apps/api/src/workers/cashback-checker.worker.ts`:

```typescript
/**
 * Cashback Checker Worker
 *
 * Runs a repeating job every hour to check all active cashback promotions
 * and automatically disburse cashback to players who have hit the loss threshold
 * within the current frequency window (DAILY/WEEKLY/MONTHLY).
 */

import { Worker, Job, Queue } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { CashbackService } from '../services/cashback.service.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

const CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export interface CashbackCheckerJobData {
    action: 'check'
}

const cashbackCheckerQueue = new Queue<CashbackCheckerJobData>(QUEUE_NAMES.CASHBACK_CHECKER, {
    connection: {
        url: REDIS_URL,
        maxRetriesPerRequest: null as any,
        enableReadyCheck: false,
    } as any,
})

const worker = new Worker<CashbackCheckerJobData>(
    QUEUE_NAMES.CASHBACK_CHECKER,
    async (_job: Job<CashbackCheckerJobData>) => {
        console.log('[CashbackCheckerWorker] Running cashback threshold checks...')
        const result = await CashbackService.runChecks()
        console.log(
            `[CashbackCheckerWorker] Done — ${result.promotionsChecked} promotions checked, ` +
            `${result.totalDisbursed} players paid, total: ${result.totalAmount.toFixed(2)} ETB`,
        )
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
    // Remove any existing repeating jobs to avoid duplicates on restart
    const repeatableJobs = await cashbackCheckerQueue.getRepeatableJobs()
    for (const rj of repeatableJobs) {
        await cashbackCheckerQueue.removeRepeatableByKey(rj.key)
    }

    // Add hourly repeating job
    await cashbackCheckerQueue.add(
        'check-cashback',
        { action: 'check' },
        {
            repeat: { every: CHECK_INTERVAL_MS },
            removeOnComplete: { count: 24 },
            removeOnFail: { count: 24 },
        },
    )

    // Run once immediately on startup
    await cashbackCheckerQueue.add(
        'check-cashback-now',
        { action: 'check' },
        {
            removeOnComplete: { count: 5 },
            removeOnFail: { count: 5 },
        },
    )

    console.log('[CashbackCheckerWorker] Repeating job set up (every 1 hour)')
}

setupRepeatingJob().catch((err) => {
    console.error('[CashbackCheckerWorker] Failed to set up repeating job:', err)
})

worker.on('completed', (job) => {
    console.log(`[CashbackCheckerWorker] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
    console.error(`[CashbackCheckerWorker] Job ${job?.id} failed:`, err.message)
})

worker.on('error', (err) => {
    console.error('[CashbackCheckerWorker] Worker error:', err.message)
})

export default worker
```

- [ ] **Step 2: Register the worker in `apps/api/src/index.ts`**

Open `apps/api/src/index.ts` and add the import after the existing worker imports (around line 36):

```typescript
import './workers/cashback-checker.worker.js'
```

- [ ] **Step 3: TypeScript check**

```bash
pnpm --filter @world-bingo/api typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/workers/cashback-checker.worker.ts apps/api/src/index.ts
git commit -m "feat(cashback): add cashback-checker BullMQ worker (hourly)"
```

---

## Task 6: Update admin API routes

**Files:**
- Modify: `apps/api/src/routes/admin/index.ts`

- [ ] **Step 1: Replace the cashback route block**

Find and replace the entire cashback routes section in `apps/api/src/routes/admin/index.ts` (the block that starts with `// ── Cashback Promotions ──`):

```typescript
    // ── Cashback Promotions ──────────────────────────────────────────────────

    fastify.get('/cashback', async (_req, _reply) => {
        return CashbackService.listPromotions()
    })

    const cashbackCreateSchema = z.object({
        name: z.string().min(1),
        lossThreshold: z.coerce.number().positive(),
        refundType: z.enum(['PERCENTAGE', 'FIXED']),
        refundValue: z.coerce.number().positive().max(100000),
        frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
        startsAt: z.string(),
        endsAt: z.string(),
    })

    fastify.post('/cashback', async (req: any, reply) => {
        const parsed = cashbackCreateSchema.safeParse(req.body)
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
        }
        const { name, lossThreshold, refundType, refundValue, frequency, startsAt, endsAt } = parsed.data
        return CashbackService.createPromotion({
            name,
            lossThreshold,
            refundType: refundType as any,
            refundValue,
            frequency: frequency as any,
            startsAt,
            endsAt,
        })
    })

    fastify.patch('/cashback/:id/toggle', async (req: any, _reply) => {
        const body = req.body as { isActive: boolean }
        return CashbackService.togglePromotion(req.params.id, body.isActive)
    })
```

- [ ] **Step 2: TypeScript check**

```bash
pnpm --filter @world-bingo/api typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/admin/index.ts
git commit -m "feat(cashback): update admin routes — new create schema, remove disburse endpoint"
```

---

## Task 7: Update admin composable

**Files:**
- Modify: `apps/admin/composables/useAdminApi.ts`

- [ ] **Step 1: Replace the cashback section in the composable**

Find the cashback section in `apps/admin/composables/useAdminApi.ts` (lines ~223–230) and replace it:

```typescript
        // ── Cashback Promotions ───────────────────────────────────────────
        getCashbackPromotions: () => apiFetch<any[]>('/admin/cashback'),
        createCashbackPromotion: (data: {
            name: string
            lossThreshold: number
            refundType: 'PERCENTAGE' | 'FIXED'
            refundValue: number
            frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
            startsAt: string
            endsAt: string
        }) => apiFetch('/admin/cashback', { method: 'POST', body: data }),
        toggleCashbackPromotion: (id: string, isActive: boolean) =>
            apiFetch(`/admin/cashback/${id}/toggle`, { method: 'PATCH', body: { isActive } }),
```

- [ ] **Step 2: Commit**

```bash
git add apps/admin/composables/useAdminApi.ts
git commit -m "feat(cashback): update useAdminApi — new create signature, remove disburseCashback"
```

---

## Task 8: Update admin UI page

**Files:**
- Modify: `apps/admin/pages/cashback/index.vue`

- [ ] **Step 1: Rewrite `pages/cashback/index.vue`**

Replace the entire file:

```vue
<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { getCashbackPromotions, createCashbackPromotion, toggleCashbackPromotion } = useAdminApi()
const toast = useToast()

const promotions = ref<any[]>([])
const loading = ref(true)
const showCreate = ref(false)
const creating = ref(false)

const form = reactive({
  name: '',
  lossThreshold: 500,
  refundType: 'PERCENTAGE' as 'PERCENTAGE' | 'FIXED',
  refundValue: 10,
  frequency: 'WEEKLY' as 'DAILY' | 'WEEKLY' | 'MONTHLY',
  startsAt: '',
  endsAt: '',
})

const refundTypeOptions = [
  { label: 'Percentage of loss', value: 'PERCENTAGE' },
  { label: 'Fixed amount (ETB)', value: 'FIXED' },
]

const frequencyOptions = [
  { label: 'Daily', value: 'DAILY' },
  { label: 'Weekly', value: 'WEEKLY' },
  { label: 'Monthly', value: 'MONTHLY' },
]

const refundValueLabel = computed(() =>
  form.refundType === 'PERCENTAGE' ? 'Refund Percentage (%)' : 'Refund Amount (ETB)'
)

async function fetchPromotions() {
  loading.value = true
  try {
    promotions.value = (await getCashbackPromotions()) as any[] ?? []
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load promotions', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function create() {
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
    await fetchPromotions()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to create', color: 'error' })
  } finally {
    creating.value = false
  }
}

async function toggle(promo: any) {
  try {
    await toggleCashbackPromotion(promo.id, !promo.isActive)
    promo.isActive = !promo.isActive
    toast.add({ title: 'Updated', color: 'success' })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to toggle', color: 'error' })
  }
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-ET', { year: 'numeric', month: 'short', day: 'numeric' })
}

function describePromo(promo: any) {
  const threshold = Number(promo.lossThreshold).toFixed(0)
  const val = promo.refundType === 'PERCENTAGE'
    ? `${Number(promo.refundValue).toFixed(0)}% back`
    : `${Number(promo.refundValue).toFixed(2)} ETB back`
  const freq = (promo.frequency as string).toLowerCase()
  return `Lose ${threshold} ETB → get ${val} · ${freq}`
}

onMounted(fetchPromotions)
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Cashback Promotions</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Configure automatic cashback for players who reach a loss threshold</p>
      </div>
      <UButton icon="i-heroicons:plus" label="New Promotion" color="primary" @click="showCreate = true" />
    </div>

    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" /> Loading...
    </div>

    <div v-else-if="!promotions.length" class="text-center py-16 text-white/30 bg-white/5 rounded-2xl border border-white/5">
      <UIcon name="i-heroicons:gift" class="w-12 h-12 mx-auto mb-3 opacity-20" />
      <p class="text-lg font-medium">No promotions yet</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="promo in promotions"
        :key="promo.id"
        class="rounded-2xl border border-(--surface-border) p-5 shadow-lg"
        style="background: var(--surface-raised);"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex-1">
            <div class="flex items-center gap-3">
              <h3 class="text-base font-bold text-white">{{ promo.name }}</h3>
              <UBadge :color="promo.isActive ? 'success' : 'neutral'" variant="soft" :label="promo.isActive ? 'Active' : 'Inactive'" />
            </div>
            <p class="text-sm text-white/40 mt-1">{{ describePromo(promo) }}</p>
            <p class="text-xs text-white/30 mt-1">{{ formatDate(promo.startsAt) }} — {{ formatDate(promo.endsAt) }} &middot; {{ promo._count?.disbursements ?? 0 }} disbursements</p>
          </div>
          <USwitch :model-value="promo.isActive" color="primary" @update:model-value="toggle(promo)" />
        </div>
      </div>
    </div>

    <!-- Create Modal -->
    <UModal v-model:open="showCreate" title="Create Cashback Promotion" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Name">
            <UInput v-model="form.name" placeholder="Weekend Cashback" class="w-full" />
          </UFormField>
          <UFormField label="Loss Threshold (ETB)">
            <UInput v-model.number="form.lossThreshold" type="number" min="1" class="w-full" />
          </UFormField>
          <UFormField label="Refund Type">
            <USelect v-model="form.refundType" :options="refundTypeOptions" value-key="value" label-key="label" class="w-full" />
          </UFormField>
          <UFormField :label="refundValueLabel">
            <UInput v-model.number="form.refundValue" type="number" min="0.01" class="w-full" />
          </UFormField>
          <UFormField label="Frequency">
            <USelect v-model="form.frequency" :options="frequencyOptions" value-key="value" label-key="label" class="w-full" />
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

- [ ] **Step 2: Commit**

```bash
git add apps/admin/pages/cashback/index.vue
git commit -m "feat(cashback): update admin UI — threshold fields, remove manual disburse"
```

---

## Task 9: Smoke test

- [ ] **Step 1: Start infra and API**

```bash
pnpm infra:up
pnpm --filter @world-bingo/api dev
```

- [ ] **Step 2: Verify Swagger shows updated routes**

Open http://localhost:8080/docs and confirm:
- `POST /admin/cashback` body schema shows `lossThreshold`, `refundType`, `refundValue`, `frequency`
- `POST /admin/cashback/:id/disburse` is gone

- [ ] **Step 3: Create a test promotion via API**

```bash
curl -s -X POST http://localhost:8080/admin/cashback \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin_jwt>" \
  -d '{
    "name": "Test Cashback",
    "lossThreshold": 100,
    "refundType": "PERCENTAGE",
    "refundValue": 10,
    "frequency": "DAILY",
    "startsAt": "2026-01-01T00:00:00Z",
    "endsAt": "2026-12-31T23:59:59Z"
  }' | jq .
```

Expected: JSON response with the new fields, no `percentage` field.

- [ ] **Step 4: Verify BullMQ dashboard shows cashback-checker queue**

Open http://localhost:8080/admin/queues and confirm the `cashback-checker` queue appears with a repeatable job scheduled.

- [ ] **Step 5: Commit if any fixes needed, then done**

```bash
git add -p
git commit -m "fix(cashback): smoke test fixes"
```
