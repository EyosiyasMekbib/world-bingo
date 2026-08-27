import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AdminController } from '../../controllers/admin.controller'
import analyticsRoutes from './analytics'
import crmRoutes, { isBadRules, ruleErrorMessage } from './crm'
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
import { TransactionType, PaymentStatus, UserRole } from '@world-bingo/shared-types'
import bcrypt from 'bcryptjs'
import { Decimal } from '@prisma/client/runtime/library'

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
}).refine(
    (data) => new Date(data.startsAt) < new Date(data.endsAt),
    { message: 'endsAt must be after startsAt', path: ['endsAt'] }
)

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

const adminRoutes: FastifyPluginAsync = async (fastify) => {

    // ── Clerk-accessible routes (admin + clerk) ───────────────────────────────
    await fastify.register(async (f) => {
        f.addHook('preValidation', f.requireAdminOrClerk)

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
                if (type === 'real') {
                    const realAfter = realBefore.plus(adjustAmount)
                    if (realAfter.lessThan(0)) throw new Error('Adjustment would make real balance negative')
                    await tx.wallet.update({ where: { userId }, data: { realBalance: { increment: adjustAmount } } })
                    await tx.transaction.create({ data: { userId, type: TransactionType.ADMIN_REAL_ADJUSTMENT, amount: adjustAmount, status: PaymentStatus.APPROVED, note: `[Admin] ${note}`, balanceBefore: realBefore, balanceAfter: realAfter, bonusBalanceBefore: bonusBefore, bonusBalanceAfter: bonusBefore } })
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
                    return { realBalance: Number(realBefore), bonusBalance: Number(grantOrReduce.bonusBalanceAfter) }
                }
            })
            NotificationService.pushWalletUpdate(userId, result.realBalance, result.bonusBalance)
            return result
        })

        // ── Support inbox ───────────────────────────────────────────────────
        f.get('/support/queue', async (req: any) => {
            const filter = (req.query?.filter ?? 'unassigned') as
                | 'unassigned'
                | 'mine'
                | 'all'
                | 'resolved'
            return SupportService.listQueue(filter, req.user.id)
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
                    isActive: true,
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

        // ── Clerk management ──────────────────────────────────────────────────
        f.get('/clerks', async (_req, _reply) => {
            return prisma.user.findMany({
                where: { role: UserRole.CLERK },
                select: { id: true, username: true, phone: true, isActive: true, createdAt: true },
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
                data: { username, passwordHash, role: UserRole.CLERK, isActive: true },
                select: { id: true, username: true, role: true, isActive: true, createdAt: true },
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

        // ── Player Management ─────────────────────────────────────────────────
        f.get('/players/:id', async (req: any, reply) => {
            const user = await prisma.user.findUnique({
                where: { id: req.params.id },
                select: {
                    id: true, serial: true, username: true, phone: true, role: true,
                    isActive: true, createdAt: true,
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
            const { name, lossThreshold, refundType, refundValue, frequency, startsAt, endsAt } = parsed.data
            return CashbackService.createPromotion({ name, lossThreshold, refundType: refundType as any, refundValue, frequency: frequency as any, startsAt, endsAt })
        })

        f.patch('/cashback/:id/toggle', async (req: any, _reply) => {
            return CashbackService.togglePromotion(req.params.id, (req.body as { isActive: boolean }).isActive)
        })

        // ── Deposit Bonus Rules ─────────────────────────────────────────────────
        f.get('/bonus-rules', async (_req, _reply) => BonusRuleService.list())

        f.post('/bonus-rules', async (req: any, reply) => {
            const parsed = bonusRuleCreateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            const { name, type, threshold, rewardType, rewardValue, maxReward, validityHours, startsAt, endsAt, segmentId } = parsed.data
            try {
                return await BonusRuleService.create({ name, type: type as any, threshold, rewardType: rewardType as any, rewardValue, maxReward, validityHours, startsAt, endsAt, segmentId })
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
            return BonusRuleService.update(req.params.id, {
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
