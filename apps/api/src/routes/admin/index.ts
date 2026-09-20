import { FastifyPluginAsync } from 'fastify'
import { AccountStatusService, STATUS_CATEGORIES } from '../../services/account-status.service.js'
import { z } from 'zod'
import { AdminController } from '../../controllers/admin.controller'
import analyticsRoutes from './analytics'
import crmRoutes, { isBadRules, ruleErrorMessage } from './crm'
import atlasVAdminRoutes from './atlasv'
import fraudAdminRoutes from './fraud'
import heroBannerAdminRoutes from './hero-banners'
import promoArtworkAdminRoutes from './promo-artwork'
import { AdminService } from '../../services/admin.service'
import { BonusService } from '../../services/bonus.service'
import { GameService } from '../../services/game.service'
import { BotService } from '../../services/bot.service'
import prisma from '../../lib/prisma'
import { GameSchedulerService } from '../../services/game-scheduler.service'
import { HouseWalletService } from '../../services/house-wallet.service'
import { CashbackService } from '../../services/cashback.service'
import { BonusRuleService, SegmentNotFoundError, EmptySegmentError } from '../../services/bonus-rule.service'
import { NotificationService } from '../../services/notification.service'
import { FeaturedGameService, PROVIDER_GAME_ORDER_BY } from '../../services/featured-game.service'
import { SupportService } from '../../services/support/support.service'
import { TransactionType, PaymentStatus, UserRole, PromoKind } from '@world-bingo/shared-types'
import bcrypt from 'bcryptjs'
import { captureEvent } from '../../lib/posthog'
import { weekBucketStart } from '../../lib/bonus-period'
import { Decimal } from '@prisma/client/runtime/library'
import type { Prisma } from '@prisma/client'

const templateCreateSchema = z.object({
    title: z.string().min(1),
    ticketPrice: z.coerce.number().positive(),
    maxPlayers: z.coerce.number().int().min(2).default(70),
    minPlayers: z.coerce.number().int().min(2).default(2),
    houseEdgePct: z.coerce.number().min(0).max(100).default(10),
    pattern: z.string().default('ANY_LINE'),
    countdownSecs: z.coerce.number().int().min(10).max(300).default(60),
    botEnabled: z.boolean().default(false),
    botCount: z.coerce.number().int().min(0).max(20).default(0),
    botFillToMin: z.boolean().default(true),
    botMaxSpend: z.coerce.number().positive().nullable().optional(),
    botWinRate: z.coerce.number().int().min(0).max(100).default(100),
})

const templateUpdateSchema = z.object({
    title: z.string().min(1).optional(),
    ticketPrice: z.coerce.number().positive().optional(),
    maxPlayers: z.coerce.number().int().min(2).optional(),
    minPlayers: z.coerce.number().int().min(2).optional(),
    houseEdgePct: z.coerce.number().min(0).max(100).optional(),
    pattern: z.string().optional(),
    countdownSecs: z.coerce.number().int().min(10).max(300).optional(),
    active: z.boolean().optional(),
    botEnabled: z.boolean().optional(),
    botCount: z.coerce.number().int().min(0).max(20).optional(),
    botFillToMin: z.boolean().optional(),
    botMaxSpend: z.coerce.number().positive().nullable().optional(),
    botWinRate: z.coerce.number().int().min(0).max(100).optional(),
})

const clerkCreateSchema = z.object({
    username: z.string().min(3).max(32),
    password: z.string().min(8),
})

const adjustBalanceSchema = z.object({
    type: z.enum(['real', 'bonus']),
    amount: z.number(),
    note: z.string().min(1, 'Note is required for audit trail'),
})

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

// Everything about a live promotion that is safe to change. Absent are the
// fields that would rewrite history rather than the future: `frequency` and
// `refundType` decide how past periods were measured, `startsAt` decides which
// windows were ever eligible, and `templateIds`/`providerGameKeys` scope the
// loss query the closed periods were already settled against.
const cashbackUpdateSchema = z.object({
    name: z.string().min(1).optional(),
    lossThreshold: z.coerce.number().min(1).optional(),
    refundValue: z.coerce.number().positive().max(100000).optional(),
    maxPayoutPerPlayer: z.coerce.number().positive().nullable().optional(),
    periodBudget: z.coerce.number().positive().nullable().optional(),
    bonusValidityHours: z.coerce.number().int().min(0).max(24 * 90).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
})

// Defined as a plain object schema (not the refined create schema below) so
// bonusRuleUpdateSchema can call .partial() on it — ZodEffects (what .refine()
// returns) has no .partial() method in zod v3.
const bonusRuleFields = z.object({
    name: z.string().min(1),
    type: z.enum(['DAILY_DEPOSIT', 'WEEKLY_DEPOSIT']),
    threshold: z.coerce.number().positive(),
    rewardType: z.enum(['FIXED', 'PERCENTAGE']),
    rewardValue: z.coerce.number().positive(),
    maxReward: z.coerce.number().positive().nullable().optional(),
    validityHours: z.coerce.number().int().positive().max(24 * 90),
    startsAt: z.string(),
    endsAt: z.string(),
    segmentId: z.string().uuid().nullable().optional(),
})

const bonusRuleCreateSchema = bonusRuleFields.refine(
    (data) => new Date(data.startsAt) < new Date(data.endsAt),
    { message: 'endsAt must be after startsAt', path: ['endsAt'] },
)

const bonusRuleUpdateSchema = bonusRuleFields.partial().extend({
    isActive: z.boolean().optional(),
})

/**
 * A payment method's card image: either an absolute URL on some CDN, or a
 * root-relative path into the web app's own /public (which is how the bundled
 * brand assets ship). z.string().url() rejects the second, which would have
 * made the shipped defaults unsaveable from the admin panel.
 */
const logoUrlSchema = z
    .string()
    .trim()
    .refine((v) => v === '' || v.startsWith('/') || /^https?:\/\//.test(v), {
        message: 'Must be an absolute http(s) URL or a root-relative path such as /payment-logos/x.svg',
    })
    .nullish()

const statusChangeSchema = z.object({
    reason: z.string().trim().min(3, 'A reason of at least 3 characters is required'),
    category: z.enum(STATUS_CATEGORIES).optional(),
    /** ISO-8601. When set, the hourly pass returns the account to ACTIVE then. */
    expiresAt: z.string().datetime().optional(),
})

const reinstateSchema = z.object({
    reason: z.string().trim().min(3, 'A reason of at least 3 characters is required'),
})

const paymentMethodCreateSchema = z.object({
    code: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(['DEPOSIT', 'WITHDRAWAL']),
    merchantName: z.string().nullish(),
    merchantAccount: z.string().nullish(),
    instructions: z.string().nullish(),
    icon: z.string().nullish(),
    logoUrl: logoUrlSchema,
    enabled: z.boolean().default(true),
    autoVerify: z.boolean().default(false),
    sortOrder: z.number().int().default(0),
})

const paymentMethodUpdateSchema = z.object({
    code: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    type: z.enum(['DEPOSIT', 'WITHDRAWAL']).optional(),
    merchantName: z.string().nullish(),
    merchantAccount: z.string().nullish(),
    instructions: z.string().nullish(),
    icon: z.string().nullish(),
    logoUrl: logoUrlSchema,
    enabled: z.boolean().optional(),
    autoVerify: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
})

// The lobby priority list, sent whole — array order is the priority order.
const featuredGamesSchema = z.object({
    items: z
        .array(z.object({ nameKey: z.string().min(1).max(120), label: z.string().min(1).max(120) }))
        .max(200),
})

/**
 * The JWT carries only { id, role } — no username — so an audit row's display
 * name has to be resolved here; ./crm.ts resolves it the same way. Takes the
 * client rather than reaching for the global one so a balance adjustment can
 * read it inside the very transaction that moves the money.
 */
async function actorNameFor(db: Prisma.TransactionClient, userId?: string | null): Promise<string | null> {
    if (!userId) return null
    const actor = await db.user.findUnique({ where: { id: userId }, select: { username: true } })
    return actor?.username ?? null
}

/**
 * Append-only trace of a promotion change. Best-effort on purpose: unlike the
 * balance-adjustment audit row — which shares the money's transaction because a
 * credit nobody can attribute is the hole being closed — a promotion edit is
 * already visible in the row it changed, so a failed audit must not fail it.
 */
async function writePromotionAudit(
    req: any,
    action: 'promotion.create' | 'promotion.update' | 'promotion.toggle',
    refId: string,
    detail: Record<string, unknown>,
): Promise<void> {
    await prisma.auditLog
        .create({
            data: {
                action,
                actorId: req.user?.id ?? null,
                actorName: await actorNameFor(prisma, req.user?.id),
                target: `promotion:${refId}`,
                detail: detail as never,
            },
        })
        .catch(() => {
            /* auditing must never block the action it records */
        })
}

/** Decimal and Date both serialize unhelpfully into a Json column. */
function auditValue(value: unknown): unknown {
    if (value == null) return null
    if (value instanceof Date) return value.toISOString()
    if (Decimal.isDecimal(value)) return Number(value)
    return value
}

/** The config a promotion was born with, flattened for the Json column. */
function auditSnapshot(row: Record<string, any>, fields: readonly string[]): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {}
    for (const field of fields) snapshot[field] = auditValue(row[field])
    return snapshot
}

/**
 * Which of `fields` actually moved, as { from, to } — the shape the promotion
 * activity feed renders ("raised the period budget from 6,000 to 8,000").
 */
function auditDiff(
    before: Record<string, any> | null,
    after: Record<string, any>,
    fields: readonly string[],
): Record<string, { from: unknown; to: unknown }> {
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const field of fields) {
        const from = auditValue(before?.[field])
        const to = auditValue(after[field])
        if (from !== to) changes[field] = { from, to }
    }
    return changes
}

const CASHBACK_AUDIT_FIELDS = [
    'name',
    'lossThreshold',
    'refundValue',
    'maxPayoutPerPlayer',
    'periodBudget',
    'bonusValidityHours',
    'startsAt',
    'endsAt',
    'isActive',
] as const

const BONUS_RULE_AUDIT_FIELDS = [
    'name',
    'type',
    'threshold',
    'rewardType',
    'rewardValue',
    'maxReward',
    'validityHours',
    'startsAt',
    'endsAt',
    'isActive',
] as const

// ── Promotions list: money comes from the ledger, never from config ──────────

/** Every transaction type that is a promotion paying a player. */
const PROMO_PAYOUT_TYPES = [
    TransactionType.FIRST_DEPOSIT_BONUS,
    TransactionType.CASHBACK_BONUS,
    TransactionType.DAILY_DEPOSIT_BONUS,
    TransactionType.WEEKLY_DEPOSIT_BONUS,
]

/** The three that name the offer that paid in `referenceId`. */
const REF_PAYOUT_TYPES = [
    TransactionType.CASHBACK_BONUS,
    TransactionType.DAILY_DEPOSIT_BONUS,
    TransactionType.WEEKLY_DEPOSIT_BONUS,
]

type PayoutTotals = { paidThisWeek: number; totalPaid: number; payoutCount: number }

const NO_PAYOUTS: PayoutTotals = { paidThisWeek: 0, totalPaid: 0, payoutCount: 0 }

/**
 * What each offer has actually paid.
 *
 * Deliberately read off `transactions` instead of recomputed from promotion
 * config: thresholds, refund values and caps are all editable, so deriving
 * history from today's settings would restate last month's payouts under this
 * month's rules.
 *
 * Keyed on `referenceId` alone rather than on (type, referenceId): a deposit
 * rule can be switched between DAILY and WEEKLY, and the rows it already paid
 * keep the type it had at the time.
 */
async function payoutsByOffer(weekStart: Date): Promise<{ byRef: Map<string, PayoutTotals>; welcome: PayoutTotals }> {
    const refWhere = { type: { in: REF_PAYOUT_TYPES }, status: PaymentStatus.APPROVED }
    const welcomeWhere = { type: TransactionType.FIRST_DEPOSIT_BONUS, status: PaymentStatus.APPROVED }

    const [refAllTime, refThisWeek, welcomeAllTime, welcomeThisWeek] = await Promise.all([
        prisma.transaction.groupBy({ by: ['referenceId'], where: refWhere, _sum: { amount: true }, _count: true }),
        prisma.transaction.groupBy({
            by: ['referenceId'],
            where: { ...refWhere, createdAt: { gte: weekStart } },
            _sum: { amount: true },
            _count: true,
        }),
        prisma.transaction.aggregate({ where: welcomeWhere, _sum: { amount: true }, _count: true }),
        prisma.transaction.aggregate({ where: { ...welcomeWhere, createdAt: { gte: weekStart } }, _sum: { amount: true } }),
    ])

    const weekByRef = new Map(refThisWeek.map((row) => [row.referenceId ?? '', Number(row._sum.amount ?? 0)]))

    const byRef = new Map<string, PayoutTotals>()
    for (const row of refAllTime) {
        if (!row.referenceId) continue
        byRef.set(row.referenceId, {
            paidThisWeek: weekByRef.get(row.referenceId) ?? 0,
            totalPaid: Number(row._sum.amount ?? 0),
            payoutCount: row._count,
        })
    }

    return {
        byRef,
        // The welcome offer is a site setting with no id, so its rows carry no
        // referenceId to group on — every FIRST_DEPOSIT_BONUS row is its own.
        welcome: {
            paidThisWeek: Number(welcomeThisWeek._sum.amount ?? 0),
            totalPaid: Number(welcomeAllTime._sum.amount ?? 0),
            payoutCount: welcomeAllTime._count,
        },
    }
}

type PromotionStatus = 'live' | 'scheduled' | 'ended' | 'paused'

/**
 * `ended` outranks `paused`: a window that has closed cannot be reopened by
 * flipping isActive, so showing such a row as merely paused would invite an
 * admin to un-pause it and wait for payouts that can never come.
 */
function windowStatus(row: { isActive: boolean; startsAt: Date; endsAt: Date }, now: Date): PromotionStatus {
    if (row.endsAt < now) return 'ended'
    if (!row.isActive) return 'paused'
    if (row.startsAt > now) return 'scheduled'
    return 'live'
}

/** Drops a pointless trailing '.00' — a reward reads '50 ETB', not '50.00 ETB'. */
function amountLabel(value: Decimal | number | null | undefined): string {
    return String(Number(new Decimal(value ?? 0).toDecimalPlaces(2)))
}

function cashbackReward(promotion: { refundType: string; refundValue: Decimal; maxPayoutPerPlayer: Decimal | null }): string {
    const value = amountLabel(promotion.refundValue)
    if (promotion.refundType !== 'PERCENTAGE') return `${value} ETB flat`
    return promotion.maxPayoutPerPlayer == null
        ? `${value}% of loss`
        : `${value}% up to ${amountLabel(promotion.maxPayoutPerPlayer)}`
}

function bonusRuleReward(rule: {
    rewardType: string
    rewardValue: Decimal
    threshold: Decimal
    maxReward: Decimal | null
}): string {
    const value = amountLabel(rule.rewardValue)
    if (rule.rewardType !== 'PERCENTAGE') return `${value} ETB per ${amountLabel(rule.threshold)}`
    return rule.maxReward == null ? `${value}% of deposit` : `${value}% up to ${amountLabel(rule.maxReward)}`
}

type PromotionRow = PayoutTotals & {
    kind: PromoKind
    id: string
    name: string
    status: PromotionStatus
    rewardSummary: string
    audience: string
    /** Null for the welcome offer, which is a setting and has no window. */
    startsAt: Date | null
    endsAt: Date | null
    hasArtwork: boolean
}

const adminRoutes: FastifyPluginAsync = async (fastify) => {

    // ── Clerk-accessible routes (admin + clerk) ───────────────────────────────
    await fastify.register(async (f) => {
        f.addHook('preValidation', f.requireAdminOrClerk)

        // Containment should not wait for an admin: a clerk who spots something
        // can RESTRICT immediately. Escalating to SUSPENDED, and lifting
        // anything, is ADMIN-only and lives in the scope below.
        f.post('/players/:id/restrict', async (req: any, reply) => {
            const parsed = statusChangeSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
            try {
                return await AccountStatusService.restrict(req.params.id, {
                    reason: parsed.data.reason,
                    category: parsed.data.category ?? null,
                    expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
                    actorId: req.user.id,
                })
            } catch (err: any) {
                return reply.status(err?.statusCode ?? 500).send({ error: err?.message, code: err?.code })
            }
        })

        f.get('/players/:id/status-history', async (req: any) =>
            AccountStatusService.history(req.params.id),
        )

        f.get('/transactions/pending', AdminController.getPendingDeposits)
        f.get('/transactions/history', AdminController.getOrdersHistory)
        f.get('/withdrawals', AdminController.getWithdrawals)
        f.post('/transactions/:id/approve', AdminController.approveTransaction)
        f.post('/transactions/:id/decline', AdminController.declineTransaction)

        // On-demand receipt verification. The clerk's browser (egressing from
        // Ethiopia) fetches the telebirr receipt the API server can't reach, and
        // POSTs the raw HTML here; we run the same parse→match→credit pipeline as
        // the background worker. Crediting honours the auto-verify toggle + cap.
        f.post('/transactions/:id/verify-receipt', async (req: any, reply) => {
            const parsed = z.object({ html: z.string().min(1).max(5_000_000) }).safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'html is required' })
            const { DepositVerificationService } = await import(
                '../../services/deposit-verification.service'
            )
            const result = await DepositVerificationService.verifyFromHtml(
                req.params.id,
                parsed.data.html,
            )
            return reply.send(result)
        })
        f.get('/stats', AdminController.getStats)

        // ── Support inbox ───────────────────────────────────────────────────
        // Returns the badge count alongside the rows rather than a bare array:
        // the count is global (unassigned threads anywhere), so a clerk sitting
        // on the "mine" filter could not derive it from the rows they were
        // given and their badge sat empty until the first socket event.
        f.get('/support/queue', async (req: any) => {
            const filter = (req.query?.filter ?? 'unassigned') as
                | 'unassigned'
                | 'mine'
                | 'all'
                | 'resolved'
            const [items, unassignedCount] = await Promise.all([
                SupportService.listQueue(filter, req.user.id),
                SupportService.unassignedCount(),
            ])
            return { items, unassignedCount }
        })

        // A support-scoped projection rather than reusing /admin/players/:id:
        // that route lives in the requireAdmin scope and 403s for the clerks who
        // actually answer support. Widening it would hand clerks the full player
        // record; this returns only what the context panel renders.
        f.get('/support/context/:userId', async (req: any, reply: any) => {
            const userId = req.params.userId
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    serial: true,
                    username: true,
                    phone: true,
                    accountStatus: true,
                    createdAt: true,
                    wallet: { select: { realBalance: true, bonusBalance: true } },
                },
            })
            if (!user) return reply.status(404).send({ error: 'Player not found' })

            const [deposits, withdrawals] = await Promise.all([
                prisma.transaction.findMany({
                    where: { userId, type: 'DEPOSIT' },
                    orderBy: { createdAt: 'desc' },
                    take: 5,
                    select: { id: true, amount: true, status: true, createdAt: true },
                }),
                prisma.transaction.findMany({
                    where: { userId, type: 'WITHDRAWAL' },
                    orderBy: { createdAt: 'desc' },
                    take: 5,
                    select: { id: true, amount: true, status: true, createdAt: true },
                }),
            ])

            return { ...user, deposits, withdrawals }
        })
    })

    // ── Admin-only routes ─────────────────────────────────────────────────────
    await fastify.register(async (f) => {
        f.addHook('preValidation', f.requireAdmin)

        // ── Analytics ─────────────────────────────────────────────────────────
        await f.register(analyticsRoutes, { prefix: '/analytics' })

        // ── Player CRM (segments, metrics, CSV export) ────────────────────────
        await f.register(crmRoutes, { prefix: '/crm' })

        // ── Atlas-V game provider (freespin grants) ────────────────────────────
        await f.register(atlasVAdminRoutes, { prefix: '/game-providers/atlasv' })

        // ── Duplicate-account detection (accounts sharing a paying account) ────
        await f.register(fraudAdminRoutes, { prefix: '/fraud' })

        // ── Lobby hero banners ────────────────────────────────────────────────
        await f.register(heroBannerAdminRoutes, { prefix: '/hero-banners' })

        // ── Promo tile artwork (one image per offer, keyed by kind + refId) ────
        await f.register(promoArtworkAdminRoutes, { prefix: '/promo-artwork' })

        // ── Clerk management ──────────────────────────────────────────────────
        f.get('/clerks', async (_req, _reply) => {
            return prisma.user.findMany({
                where: { role: UserRole.CLERK },
                select: { id: true, username: true, phone: true, accountStatus: true, createdAt: true },
                orderBy: { createdAt: 'desc' },
            })
        })

        f.post('/clerks', async (req: any, reply) => {
            const parsed = clerkCreateSchema.safeParse(req.body)
            if (!parsed.success) {
                return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            }
            const { username, password } = parsed.data
            const existing = await prisma.user.findFirst({ where: { username } })
            if (existing) {
                return reply.status(409).send({ error: 'Username already taken' })
            }
            const passwordHash = await bcrypt.hash(password, 10)
            const clerk = await prisma.user.create({
                // accountStatus defaults to ACTIVE; disabling a clerk is a
                // SUSPENDED transition through AccountStatusService like any other.
                data: { username, passwordHash, role: UserRole.CLERK },
                select: { id: true, username: true, role: true, accountStatus: true, createdAt: true },
            })
            return reply.status(201).send(clerk)
        })

        f.delete('/clerks/:id', async (req: any, reply) => {
            const clerk = await prisma.user.findUnique({ where: { id: req.params.id } })
            if (!clerk || clerk.role !== UserRole.CLERK) {
                return reply.status(404).send({ error: 'Clerk not found' })
            }
            await prisma.user.delete({ where: { id: req.params.id } })
            return { success: true }
        })

        // ── User management ───────────────────────────────────────────────────
        f.get('/users', AdminController.getUsers)

        // ── Game management ───────────────────────────────────────────────────
        f.get('/games', AdminController.getGames)
        f.post('/games/:id/cancel', async (req: any, reply) => {
            await GameService.cancelGame(req.params.id)
            return { success: true }
        })
        f.post('/games/:id/start', async (req: any, reply) => {
            return await GameService.startGame(req.params.id)
        })

        f.post('/games/:gameId/inject-bots', async (req: any, reply) => {
            const { gameId } = req.params
            const game = await prisma.game.findUnique({
                where: { id: gameId },
                select: { status: true, templateId: true },
            })
            if (!game) return reply.status(404).send({ error: 'Game not found' })
            if (!game.templateId) return reply.status(400).send({ error: 'Bots are only supported for template-based games' })
            if (game.status !== 'WAITING') return reply.status(409).send({ error: 'Game is not waiting for players' })
            await BotService.injectBots(gameId)
            return { injected: true }
        })

        // ── Game Templates ────────────────────────────────────────────────────
        f.get('/game-templates', async (req, reply) => {
            return prisma.gameTemplate.findMany({
                orderBy: { createdAt: 'desc' },
                include: { _count: { select: { games: { where: { status: 'WAITING' } } } } },
            })
        })

        f.post('/game-templates', async (req: any, reply) => {
            const parsed = templateCreateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues })
            const { title, ticketPrice, maxPlayers, minPlayers, houseEdgePct, pattern, countdownSecs, botEnabled, botCount, botFillToMin, botMaxSpend, botWinRate } = parsed.data
            const template = await prisma.gameTemplate.create({
                data: {
                    title, ticketPrice, maxPlayers, minPlayers, houseEdgePct,
                    pattern: pattern as any, countdownSecs, active: true,
                    botEnabled, botCount, botFillToMin,
                    ...(botMaxSpend != null && { botMaxSpend }),
                    botWinRate,
                },
            })
            await GameSchedulerService.replenishTemplate(template.id)
            return template
        })

        f.patch('/game-templates/:id', async (req: any, reply) => {
            const { id } = req.params
            const parsed = templateUpdateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues })
            const { title, ticketPrice, maxPlayers, minPlayers, houseEdgePct, pattern, countdownSecs, active, botEnabled, botCount, botFillToMin, botMaxSpend, botWinRate } = parsed.data
            const template = await prisma.gameTemplate.update({
                where: { id },
                data: {
                    ...(title !== undefined && { title }),
                    ...(ticketPrice !== undefined && { ticketPrice }),
                    ...(maxPlayers !== undefined && { maxPlayers }),
                    ...(minPlayers !== undefined && { minPlayers }),
                    ...(houseEdgePct !== undefined && { houseEdgePct }),
                    ...(pattern !== undefined && { pattern: pattern as any }),
                    ...(countdownSecs !== undefined && { countdownSecs }),
                    ...(active !== undefined && { active }),
                    ...(botEnabled !== undefined && { botEnabled }),
                    ...(botCount !== undefined && { botCount }),
                    ...(botFillToMin !== undefined && { botFillToMin }),
                    ...(botMaxSpend !== undefined && { botMaxSpend }),
                    ...(botWinRate !== undefined && { botWinRate }),
                },
            })
            if (active === true) await GameSchedulerService.replenishTemplate(template.id)
            return template
        })

        f.delete('/game-templates/:id', async (req: any, reply) => {
            const { id } = req.params
            await prisma.gameTemplate.update({ where: { id }, data: { active: false } })
            await prisma.gameTemplate.delete({ where: { id } })
            return { success: true }
        })

        // ── House Wallet ──────────────────────────────────────────────────────
        f.get('/house/wallet', async (_req, _reply) => {
            const [balance, summary] = await Promise.all([HouseWalletService.getBalance(), HouseWalletService.getSummary()])
            return { balance: balance.toFixed(2), currency: 'ETB', summary }
        })

        f.get('/house/transactions', async (req: any, _reply) => {
            const page = Number(req.query.page ?? 1)
            const limit = Number(req.query.limit ?? 20)
            const type = req.query.type as 'COMMISSION' | 'BOT_PRIZE_WIN' | 'REFUND_ISSUED' | undefined
            return { ...(await HouseWalletService.getTransactions(page, limit, type)), page, limit }
        })

        f.get('/house/bots', async (_req, _reply) => HouseWalletService.getBotActivity())

        f.patch('/house/bots/:id/rename', async (req: any, reply) => {
            const { id } = req.params
            const { firstName, lastName } = req.body ?? {}
            const bot = await prisma.user.findFirst({ where: { id, username: { startsWith: 'bot_t' } }, select: { id: true } })
            if (!bot) return reply.status(404).send({ error: 'Bot not found' })
            const updated = await prisma.user.update({
                where: { id },
                data: { firstName: firstName ?? null, lastName: lastName ?? null },
                select: { id: true, username: true, firstName: true, lastName: true },
            })
            return updated
        })

        f.get('/money-flow', async (req: any, _reply) => {
            const q = req.query as Record<string, any>
            const types = q['type[]'] ? (Array.isArray(q['type[]']) ? q['type[]'] : [q['type[]']]) : undefined
            return AdminService.getMoneyFlow({
                page: q.page ? Number(q.page) : undefined,
                limit: q.limit ? Number(q.limit) : undefined,
                direction: q.direction as 'IN' | 'OUT' | undefined,
                types,
                from: q.from ? new Date(q.from) : undefined,
                to: q.to ? new Date(q.to) : undefined,
                search: q.search || undefined,
            })
        })

        // ── Account status ────────────────────────────────────────────────────
        f.post('/players/:id/suspend', async (req: any, reply) => {
            const parsed = statusChangeSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
            try {
                return await AccountStatusService.suspend(req.params.id, {
                    reason: parsed.data.reason,
                    category: parsed.data.category ?? null,
                    expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
                    actorId: req.user.id,
                })
            } catch (err: any) {
                return reply.status(err?.statusCode ?? 500).send({ error: err?.message, code: err?.code })
            }
        })

        f.post('/players/:id/reinstate', async (req: any, reply) => {
            const parsed = reinstateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
            try {
                return await AccountStatusService.reinstate(req.params.id, {
                    reason: parsed.data.reason,
                    actorId: req.user.id,
                })
            } catch (err: any) {
                return reply.status(err?.statusCode ?? 500).send({ error: err?.message, code: err?.code })
            }
        })

        // ── Player Management ─────────────────────────────────────────────────
        // Moving real or bonus money is an ADMIN act, not a clerk one: this route
        // takes any amount, in either direction, on any account. It sat in the
        // clerk scope with no cap and no record of who used it.
        f.post('/players/:id/adjust-balance', async (req: any, reply) => {
            const parsed = adjustBalanceSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            const { type, amount, note } = parsed.data
            const userId = req.params.id
            const result = await prisma.$transaction(async (tx) => {
                const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                    SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
                `
                const wallet = wallets[0]
                if (!wallet) throw new Error('Wallet not found')
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const adjustAmount = new Decimal(amount)

                // In the money's own transaction, and awaited rather than
                // best-effort: an adjustment that commits without its audit row
                // is exactly the untraceable credit this route used to allow.
                const actorName = await actorNameFor(tx, req.user?.id)
                const recordAdjustment = (appliedDelta: Decimal) =>
                    tx.auditLog.create({
                        data: {
                            action: 'player.balance.adjust',
                            actorId: req.user?.id ?? null,
                            actorName,
                            target: `player:${userId}`,
                            detail: {
                                type,
                                requestedAmount: Number(adjustAmount),
                                appliedDelta: Number(appliedDelta),
                                note,
                            },
                        },
                    })

                if (type === 'real') {
                    const realAfter = realBefore.plus(adjustAmount)
                    if (realAfter.lessThan(0)) throw new Error('Adjustment would make real balance negative')
                    await tx.wallet.update({ where: { userId }, data: { realBalance: { increment: adjustAmount } } })
                    await tx.transaction.create({ data: { userId, type: TransactionType.ADMIN_REAL_ADJUSTMENT, amount: adjustAmount, status: PaymentStatus.APPROVED, note: `[Admin] ${note}`, balanceBefore: realBefore, balanceAfter: realAfter, bonusBalanceBefore: bonusBefore, bonusBalanceAfter: bonusBefore } })
                    await recordAdjustment(adjustAmount)
                    return { realBalance: Number(realAfter), bonusBalance: Number(bonusBefore) }
                } else {
                    const grantOrReduce =
                        adjustAmount.gte(0)
                            ? await BonusService.grant(tx, { userId, amount: adjustAmount, source: 'ADMIN' })
                            : await BonusService.reduce(tx, userId, adjustAmount.abs()).then((r) => ({
                                  bonusBalanceBefore: r.bonusBalanceBefore,
                                  bonusBalanceAfter: r.bonusBalanceAfter,
                              }))
                    // Record the actual applied delta, not the admin's requested one — reduce()
                    // clamps at zero, so a request to remove more bonus than the player has would
                    // otherwise write a Transaction.amount that overstates what really moved.
                    const actualDelta = grantOrReduce.bonusBalanceAfter.minus(grantOrReduce.bonusBalanceBefore)
                    await tx.transaction.create({
                        data: {
                            userId,
                            type: TransactionType.ADMIN_BONUS_ADJUSTMENT,
                            amount: actualDelta,
                            status: PaymentStatus.APPROVED,
                            note: `[Admin] ${note}`,
                            balanceBefore: realBefore,
                            balanceAfter: realBefore,
                            bonusBalanceBefore: grantOrReduce.bonusBalanceBefore,
                            bonusBalanceAfter: grantOrReduce.bonusBalanceAfter,
                        },
                    })
                    await recordAdjustment(actualDelta)
                    return { realBalance: Number(realBefore), bonusBalance: Number(grantOrReduce.bonusBalanceAfter) }
                }
            })
            NotificationService.pushWalletUpdate(userId, result.realBalance, result.bonusBalance)
            if (type === 'bonus' && Number(amount) > 0) {
                void captureEvent(userId, 'bonus_granted', {
                    amount: Number(amount),
                    source: 'ADMIN',
                    rule_id: null,
                })
            }
            return result
        })

        f.get('/players/:id', async (req: any, reply) => {
            const user = await prisma.user.findUnique({
                where: { id: req.params.id },
                select: {
                    id: true, serial: true, username: true, phone: true, role: true,
                    accountStatus: true, createdAt: true,
                    wallet: { select: { realBalance: true, bonusBalance: true } },
                },
            })
            if (!user) return reply.status(404).send({ error: 'Player not found' })
            const transactions = await prisma.transaction.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 50 })
            const stats = await Promise.all([
                prisma.transaction.aggregate({ where: { userId: req.params.id, type: TransactionType.GAME_ENTRY }, _count: true, _sum: { amount: true } }),
                prisma.transaction.aggregate({ where: { userId: req.params.id, type: TransactionType.PRIZE_WIN }, _count: true, _sum: { amount: true } }),
                prisma.transaction.aggregate({ where: { userId: req.params.id, type: TransactionType.DEPOSIT, status: PaymentStatus.APPROVED }, _count: true, _sum: { amount: true } }),
                prisma.transaction.aggregate({ where: { userId: req.params.id, type: TransactionType.WITHDRAWAL, status: PaymentStatus.APPROVED }, _count: true, _sum: { amount: true } }),
            ])
            return {
                ...user, transactions,
                stats: {
                    gamesPlayed: stats[0]._count, totalWagered: Number(stats[0]._sum.amount ?? 0),
                    gamesWon: stats[1]._count, totalWon: Number(stats[1]._sum.amount ?? 0),
                    depositCount: stats[2]._count, totalDeposited: Number(stats[2]._sum.amount ?? 0),
                    withdrawalCount: stats[3]._count, totalWithdrawn: Number(stats[3]._sum.amount ?? 0),
                },
            }
        })

        // ── Game Providers ────────────────────────────────────────────────────
        f.get('/providers', async (_req, _reply) => prisma.gameProvider.findMany({ orderBy: { createdAt: 'asc' } }))

        f.patch('/providers/:id/status', async (req: any, reply) => {
            const { status } = req.body as { status: string }
            const allowed = ['ACTIVE', 'INACTIVE', 'MAINTENANCE']
            if (!allowed.includes(status)) return reply.status(400).send({ error: 'Invalid status' })
            return prisma.gameProvider.update({ where: { id: req.params.id }, data: { status: status as any } })
        })

        f.post('/providers/:code/sync', async (req: any, reply) => {
            const { GameCatalogService } = await import('../../services/game-catalog.service.js')
            const summary = await GameCatalogService.syncAll(req.params.code)
            return { success: true, ...summary }
        })

        f.get('/providers/:code/vendors', async (req: any, _reply) => {
            const provider = await prisma.gameProvider.findUnique({ where: { code: req.params.code } })
            if (!provider) return _reply.status(404).send({ error: 'Provider not found' })
            return prisma.gameVendor.findMany({ where: { providerId: provider.id }, orderBy: { name: 'asc' } })
        })

        f.patch('/providers/:code/vendors/:vendorCode/status', async (req: any, reply) => {
            const provider = await prisma.gameProvider.findUnique({ where: { code: req.params.code } })
            if (!provider) return reply.status(404).send({ error: 'Provider not found' })
            const vendor = await prisma.gameVendor.findUnique({ where: { providerId_code: { providerId: provider.id, code: req.params.vendorCode } } })
            if (!vendor) return reply.status(404).send({ error: 'Vendor not found' })
            return prisma.gameVendor.update({ where: { id: vendor.id }, data: { isActive: req.body.isActive } })
        })

        f.get('/providers/:code/games', async (req: any, _reply) => {
            const provider = await prisma.gameProvider.findUnique({ where: { code: req.params.code } })
            if (!provider) return _reply.status(404).send({ error: 'Provider not found' })
            const page = Math.max(1, Number(req.query.page ?? 1))
            const limit = Math.min(100, Number(req.query.limit ?? 50))
            const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
            const where = {
                providerId: provider.id,
                ...(search ? { gameName: { contains: search, mode: 'insensitive' as const } } : {}),
            }
            const [data, total] = await Promise.all([
                prisma.providerGame.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: PROVIDER_GAME_ORDER_BY }),
                prisma.providerGame.count({ where }),
            ])
            return { data, total, page, limit }
        })

        // ── Featured games (lobby priority order) ─────────────────────────────
        // One global list, ordered; a pin matches provider games by normalized
        // name so it covers every provider carrying the title.
        f.get('/featured-games', async () => ({ items: await FeaturedGameService.list() }))

        f.put('/featured-games', async (req: any, reply) => {
            const parsed = featuredGamesSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            // This package compiles with `strict: false`, so zod infers every field
            // as optional — restate the shape; the service rejects empty names.
            const items = (parsed.data.items ?? []).map((item) => ({
                nameKey: item.nameKey ?? '',
                label: item.label ?? '',
            }))
            try {
                return { items: await FeaturedGameService.replace(items) }
            } catch (err: any) {
                return reply.status(400).send({ error: err.message })
            }
        })

        f.patch('/providers/:code/games/:gameCode/status', async (req: any, reply) => {
            const provider = await prisma.gameProvider.findUnique({ where: { code: req.params.code } })
            if (!provider) return reply.status(404).send({ error: 'Provider not found' })
            const game = await prisma.providerGame.findUnique({ where: { providerId_gameCode: { providerId: provider.id, gameCode: req.params.gameCode } } })
            if (!game) return reply.status(404).send({ error: 'Game not found' })
            // Manual admin action always wins — clear the auto-hidden flag so a
            // later sync won't override a deliberate enable/disable.
            return prisma.providerGame.update({ where: { id: game.id }, data: { isActive: req.body.isActive, autoHidden: false } })
        })

        f.get('/providers/:code/transactions', async (req: any, _reply) => {
            const provider = await prisma.gameProvider.findUnique({ where: { code: req.params.code } })
            if (!provider) return _reply.status(404).send({ error: 'Provider not found' })
            const page = Math.max(1, Number(req.query.page ?? 1))
            const limit = Math.min(100, Number(req.query.limit ?? 30))
            const [data, total] = await Promise.all([
                prisma.thirdPartyTransaction.findMany({ where: { providerId: provider.id }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
                prisma.thirdPartyTransaction.count({ where: { providerId: provider.id } }),
            ])
            return { data, total, page, limit }
        })

        f.patch('/providers/:id/primary', async (req: any, reply) => {
            const { id } = req.params as { id: string }
            const { isPrimary } = req.body as { isPrimary: boolean }
            if (typeof isPrimary !== 'boolean') return reply.status(400).send({ error: 'isPrimary must be a boolean' })
            if (isPrimary) {
                await prisma.gameProvider.updateMany({ data: { isPrimary: false } })
            }
            const provider = await prisma.gameProvider.update({ where: { id }, data: { isPrimary } })
            return provider
        })

        // ── Cashback Promotions ───────────────────────────────────────────────
        f.get('/cashback', async (_req, _reply) => CashbackService.listPromotions())

        f.post('/cashback', async (req: any, reply) => {
            const parsed = cashbackCreateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            const { name, lossThreshold, refundType, refundValue, frequency, startsAt, endsAt, templateIds, providerGameKeys } = parsed.data
            const promotion = await CashbackService.createPromotion({ name, lossThreshold, refundType: refundType as any, refundValue, frequency: frequency as any, startsAt, endsAt, templateIds, providerGameKeys })
            await writePromotionAudit(req, 'promotion.create', promotion.id, {
                kind: PromoKind.CASHBACK,
                ...auditSnapshot(promotion, CASHBACK_AUDIT_FIELDS),
                refundType: promotion.refundType,
                frequency: promotion.frequency,
                payoutTiming: promotion.payoutTiming,
                templateIds: promotion.templateIds,
                providerGameKeys: promotion.providerGameKeys,
            })
            return promotion
        })

        // No edit route existed: a promotion's budget, caps and end date could
        // only be set at creation, so raising a cap meant creating a second
        // promotion and splitting its history in two.
        f.patch('/cashback/:id', async (req: any, reply) => {
            const parsed = cashbackUpdateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
            const { id } = req.params
            const existing = await prisma.cashbackPromotion.findUnique({ where: { id } })
            if (!existing) return reply.status(404).send({ error: 'Promotion not found' })

            const { name, lossThreshold, refundValue, maxPayoutPerPlayer, periodBudget, bonusValidityHours } = parsed.data
            const endsAt = parsed.data.endsAt === undefined ? undefined : new Date(parsed.data.endsAt)
            if (endsAt && endsAt <= existing.startsAt) {
                return reply.status(400).send({ error: 'endsAt must be after startsAt' })
            }

            const data = {
                ...(name !== undefined && { name }),
                ...(lossThreshold !== undefined && { lossThreshold }),
                ...(refundValue !== undefined && { refundValue }),
                // null is meaningful on both caps — it is how an admin removes one.
                ...(maxPayoutPerPlayer !== undefined && { maxPayoutPerPlayer }),
                ...(periodBudget !== undefined && { periodBudget }),
                ...(bonusValidityHours !== undefined && { bonusValidityHours }),
                ...(endsAt !== undefined && { endsAt }),
            }
            if (Object.keys(data).length === 0) return reply.status(400).send({ error: 'No fields to update' })

            const updated = await prisma.cashbackPromotion.update({ where: { id }, data })
            const changes = auditDiff(existing, updated, CASHBACK_AUDIT_FIELDS)
            // A row per no-op save buries the edits that did change something.
            if (Object.keys(changes).length > 0) {
                await writePromotionAudit(req, 'promotion.update', id, { kind: PromoKind.CASHBACK, changes })
            }
            return updated
        })

        // Ending is not pausing. isActive alone leaves a future endsAt behind, so
        // resuming the promotion would settle every window that closed meanwhile;
        // endsAt alone does not stop it, because a PERIOD_CLOSE promotion settles
        // the window that closed after its own end date. Both, together, stop it.
        f.post('/cashback/:id/end', async (req: any, reply) => {
            const { id } = req.params
            const existing = await prisma.cashbackPromotion.findUnique({ where: { id } })
            if (!existing) return reply.status(404).send({ error: 'Promotion not found' })

            const updated = await prisma.cashbackPromotion.update({
                where: { id },
                data: { endsAt: new Date(), isActive: false },
            })
            await writePromotionAudit(req, 'promotion.update', id, {
                kind: PromoKind.CASHBACK,
                ended: true,
                changes: auditDiff(existing, updated, CASHBACK_AUDIT_FIELDS),
            })
            return updated
        })

        f.patch('/cashback/:id/toggle', async (req: any, _reply) => {
            const promotion = await CashbackService.togglePromotion(req.params.id, (req.body as { isActive: boolean }).isActive)
            await writePromotionAudit(req, 'promotion.toggle', promotion.id, {
                kind: PromoKind.CASHBACK,
                isActive: promotion.isActive,
            })
            return promotion
        })

        // ── Deposit Bonus Rules ─────────────────────────────────────────────────
        f.get('/bonus-rules', async (_req, _reply) => BonusRuleService.list())

        f.post('/bonus-rules', async (req: any, reply) => {
            const parsed = bonusRuleCreateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            const { name, type, threshold, rewardType, rewardValue, maxReward, validityHours, startsAt, endsAt, segmentId } = parsed.data
            try {
                const rule = await BonusRuleService.create({ name, type: type as any, threshold, rewardType: rewardType as any, rewardValue, maxReward, validityHours, startsAt, endsAt, segmentId })
                await writePromotionAudit(req, 'promotion.create', rule.id, {
                    kind: PromoKind.DEPOSIT_RULE,
                    ...auditSnapshot(rule, BONUS_RULE_AUDIT_FIELDS),
                    segmentId: rule.segmentId,
                    segmentName: rule.segmentName,
                    memberCount: rule.memberCount,
                })
                return rule
            } catch (err: any) {
                if (err instanceof SegmentNotFoundError || err instanceof EmptySegmentError) return reply.status(400).send({ error: err.message })
                if (isBadRules(err)) return reply.status(400).send({ error: ruleErrorMessage(err) })
                throw err
            }
        })

        f.patch('/bonus-rules/:id', async (req: any, reply) => {
            const parsed = bonusRuleUpdateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            if (parsed.data.segmentId !== undefined) {
                return reply.status(400).send({
                    error: "A rule's segment targeting cannot be changed after creation — create a new rule instead",
                })
            }
            const { name, type, threshold, rewardType, rewardValue, maxReward, validityHours, startsAt, endsAt, isActive } = parsed.data
            const before = await prisma.bonusRule.findUnique({ where: { id: req.params.id } })
            const updated = await BonusRuleService.update(req.params.id, {
                ...(name !== undefined && { name }),
                ...(type !== undefined && { type: type as any }),
                ...(threshold !== undefined && { threshold }),
                ...(rewardType !== undefined && { rewardType: rewardType as any }),
                ...(rewardValue !== undefined && { rewardValue }),
                ...(maxReward !== undefined && { maxReward }),
                ...(validityHours !== undefined && { validityHours }),
                ...(startsAt !== undefined && { startsAt }),
                ...(endsAt !== undefined && { endsAt }),
                ...(isActive !== undefined && { isActive }),
            })
            const changes = auditDiff(before, updated, BONUS_RULE_AUDIT_FIELDS)
            if (Object.keys(changes).length > 0) {
                await writePromotionAudit(req, 'promotion.update', updated.id, { kind: PromoKind.DEPOSIT_RULE, changes })
            }
            return updated
        })

        f.patch('/bonus-rules/:id/toggle', async (req: any, reply) => {
            const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'isActive is required' })
            const updated = await BonusRuleService.update(req.params.id, { isActive: parsed.data.isActive })
            await writePromotionAudit(req, 'promotion.toggle', updated.id, {
                kind: PromoKind.DEPOSIT_RULE,
                isActive: updated.isActive,
            })
            return updated
        })

        // ── Promotions (every offer type in one list) ──────────────────────────
        // One screen owns the welcome setting, cashback promotions and deposit
        // bonus rules, so one endpoint projects all three into the same row
        // shape. Money figures come from the ledger; see payoutsByOffer.
        f.get('/promotions', async () => {
            const now = new Date()
            const weekStart = weekBucketStart(now)
            const [welcomeSetting, promotions, rules, artworks, payouts] = await Promise.all([
                prisma.siteSetting.findUnique({ where: { key: 'first_deposit_bonus_amount' } }),
                prisma.cashbackPromotion.findMany({ orderBy: { createdAt: 'desc' } }),
                BonusRuleService.list(),
                prisma.promoArtwork.findMany({ select: { kind: true, refId: true } }),
                payoutsByOffer(weekStart),
            ])

            const withArtwork = new Set(artworks.map((art) => `${art.kind}:${art.refId}`))
            const hasArtwork = (kind: PromoKind, refId: string) => withArtwork.has(`${kind}:${refId}`)

            const rawWelcome = Number(welcomeSetting?.value ?? 0)
            const welcomeAmount = Number.isFinite(rawWelcome) ? rawWelcome : 0

            // Welcome first, then cashback and deposit rules newest-first — the
            // same natural order PromotionsService gives the public tiles.
            const items: PromotionRow[] = [
                {
                    kind: PromoKind.WELCOME,
                    id: 'welcome',
                    name: 'Welcome Bonus',
                    // A site setting has no window to be inside or outside, so a
                    // zero amount is the only way this offer is ever switched off.
                    status: welcomeAmount > 0 ? 'live' : 'paused',
                    rewardSummary: `${amountLabel(welcomeAmount)} ETB flat`,
                    audience: 'All players',
                    startsAt: null,
                    endsAt: null,
                    ...payouts.welcome,
                    hasArtwork: hasArtwork(PromoKind.WELCOME, 'welcome'),
                },
                ...promotions.map((promotion) => ({
                    kind: PromoKind.CASHBACK,
                    id: promotion.id,
                    name: promotion.name,
                    status: windowStatus(promotion, now),
                    rewardSummary: cashbackReward(promotion),
                    audience: 'All players',
                    startsAt: promotion.startsAt,
                    endsAt: promotion.endsAt,
                    ...(payouts.byRef.get(promotion.id) ?? NO_PAYOUTS),
                    hasArtwork: hasArtwork(PromoKind.CASHBACK, promotion.id),
                })),
                ...rules.map((rule) => ({
                    kind: PromoKind.DEPOSIT_RULE,
                    id: rule.id,
                    name: rule.name,
                    status: windowStatus(rule, now),
                    rewardSummary: bonusRuleReward(rule),
                    // A segment-scoped rule pays only its frozen cohort and never
                    // appears on a player surface, so the badge here is the only
                    // place its audience is visible at all.
                    audience: rule.segmentName ? `${rule.segmentName} · ${rule.memberCount ?? 0}` : 'All players',
                    startsAt: rule.startsAt,
                    endsAt: rule.endsAt,
                    ...(payouts.byRef.get(rule.id) ?? NO_PAYOUTS),
                    hasArtwork: hasArtwork(PromoKind.DEPOSIT_RULE, rule.id),
                })),
            ]

            return { items }
        })

        f.get('/promotions/summary', async () => {
            const weekStart = weekBucketStart(new Date())
            const paidWhere = { type: { in: PROMO_PAYOUT_TYPES }, status: PaymentStatus.APPROVED }
            const [thisWeek, allTime, reached, liability] = await Promise.all([
                prisma.transaction.aggregate({ where: { ...paidWhere, createdAt: { gte: weekStart } }, _sum: { amount: true } }),
                prisma.transaction.aggregate({ where: paidWhere, _sum: { amount: true } }),
                // groupBy rather than a raw COUNT(DISTINCT): this is a header tile
                // over bonus payouts only, and it keeps the query in Prisma.
                prisma.transaction.groupBy({ by: ['userId'], where: paidWhere }),
                // The grants are the liability, not wallets.bonusBalance: the cached
                // balance is derived from them (see the ledger invariant), and a
                // drift would otherwise be reported here as real money owed.
                prisma.bonusGrant.aggregate({ where: { status: 'ACTIVE' }, _sum: { remaining: true } }),
            ])

            return {
                paidThisWeek: Number(thisWeek._sum.amount ?? 0),
                paidAllTime: Number(allTime._sum.amount ?? 0),
                playersReached: reached.length,
                outstandingLiability: Number(liability._sum.remaining ?? 0),
            }
        })

        f.get('/promotions/cashback/:id', async (req: any, reply) => {
            const { id } = req.params
            const promotion = await prisma.cashbackPromotion.findUnique({ where: { id } })
            if (!promotion) return reply.status(404).send({ error: 'Promotion not found' })

            const [periods, activity, artwork] = await Promise.all([
                // One disbursement per (player, period) — the unique index on
                // (promotionId, userId, periodStart) is what makes a row count a
                // player count rather than a payout attempt count.
                prisma.cashbackDisbursement.groupBy({
                    by: ['periodStart', 'periodEnd'],
                    where: { promotionId: id },
                    _count: true,
                    _sum: { amount: true },
                    _max: { amount: true },
                    orderBy: { periodStart: 'desc' },
                }),
                prisma.auditLog.findMany({
                    where: { target: `promotion:${id}` },
                    orderBy: { createdAt: 'desc' },
                    take: 50,
                }),
                prisma.promoArtwork.findUnique({ where: { kind_refId: { kind: PromoKind.CASHBACK, refId: id } } }),
            ])

            return {
                promotion: {
                    ...promotion,
                    status: windowStatus(promotion, new Date()),
                    rewardSummary: cashbackReward(promotion),
                    hasArtwork: artwork !== null,
                },
                history: periods.map((period) => {
                    const players = period._count
                    const total = Number(period._sum.amount ?? 0)
                    return {
                        periodStart: period.periodStart,
                        periodEnd: period.periodEnd,
                        players,
                        total,
                        // Averaged over the period's own payouts, so a closed
                        // period keeps the figure it was settled at even after the
                        // refund value changes.
                        average: players > 0 ? Number((total / players).toFixed(2)) : 0,
                        largest: Number(period._max.amount ?? 0),
                    }
                }),
                activity: activity.map((row) => ({
                    id: row.id,
                    action: row.action,
                    actorName: row.actorName,
                    detail: row.detail,
                    createdAt: row.createdAt,
                })),
            }
        })

        // What the OPEN period would pay if it closed now. Recomputed on every
        // call — it is a live projection, not a stored figure.
        f.get('/promotions/cashback/:id/qualifiers', async (req: any, reply) => {
            try {
                const preview = await CashbackService.previewQualifiers(req.params.id)
                return {
                    periodStart: preview.periodStart,
                    periodEnd: preview.periodEnd,
                    players: preview.players,
                    projectedTotal: Number(preview.projectedTotal),
                    largest: Number(preview.largest),
                    top: preview.top.map((qualifier) => ({
                        username: qualifier.username,
                        netLoss: Number(qualifier.netLoss),
                        payout: Number(qualifier.payout),
                    })),
                }
            } catch (err: any) {
                if (err?.code === 'P2025') return reply.status(404).send({ error: 'Promotion not found' })
                throw err
            }
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

        // ── Payment Methods ───────────────────────────────────────────────────
        f.get('/payment-methods', async (_req, _reply) => prisma.paymentMethod.findMany({ orderBy: { sortOrder: 'asc' } }))

        f.post('/payment-methods', async (req: any, reply) => {
            const parsed = paymentMethodCreateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues })
            try {
                const d = parsed.data
                const method = await prisma.paymentMethod.create({
                    data: { code: d.code, name: d.name, type: d.type as import('@prisma/client').PaymentMethodType, merchantName: d.merchantName ?? null, merchantAccount: d.merchantAccount ?? null, instructions: d.instructions ?? null, icon: d.icon ?? null, enabled: d.enabled, autoVerify: d.autoVerify, sortOrder: d.sortOrder },
                })
                return reply.status(201).send(method)
            } catch (err: any) {
                if (err?.code === 'P2002') return reply.status(409).send({ error: 'A payment method with that code already exists' })
                throw err
            }
        })

        f.put('/payment-methods/:id', async (req: any, reply) => {
            const { id } = req.params as { id: string }
            const parsed = paymentMethodUpdateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues })
            try {
                const { type, merchantName, merchantAccount, instructions, icon, ...rest } = parsed.data
                return await prisma.paymentMethod.update({
                    where: { id },
                    data: {
                        ...rest,
                        ...(type ? { type: type as import('@prisma/client').PaymentMethodType } : {}),
                        ...(merchantName !== undefined ? { merchantName: merchantName ?? null } : {}),
                        ...(merchantAccount !== undefined ? { merchantAccount: merchantAccount ?? null } : {}),
                        ...(instructions !== undefined ? { instructions: instructions ?? null } : {}),
                        ...(icon !== undefined ? { icon: icon ?? null } : {}),
                    },
                })
            } catch (err: any) {
                if (err?.code === 'P2025') return reply.status(404).send({ error: 'Payment method not found' })
                if (err?.code === 'P2002') return reply.status(409).send({ error: 'A payment method with that code already exists' })
                throw err
            }
        })

        f.delete('/payment-methods/:id', async (req: any, reply) => {
            try {
                await prisma.paymentMethod.delete({ where: { id: (req.params as { id: string }).id } })
                return { success: true }
            } catch (err: any) {
                if (err?.code === 'P2025') return reply.status(404).send({ error: 'Payment method not found' })
                throw err
            }
        })
    })

    // ── Super-admin-only routes ───────────────────────────────────────────────
    // Role changes mint privilege, so they are not an ADMIN-level operation. An
    // ADMIN who can create other ADMINs can manufacture the second pair of eyes
    // for any approval flow. AdminService.updateUserRole additionally refuses to
    // assign SUPER_ADMIN at all — this guard is the outer layer, not the only one.
    await fastify.register(async (f) => {
        f.addHook('preValidation', f.requireSuperAdmin)

        f.patch('/users/:id/status', AdminController.updateUserStatus)
    })
}

export default adminRoutes
