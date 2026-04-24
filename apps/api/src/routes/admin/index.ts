import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AdminController } from '../../controllers/admin.controller'
import { AdminService } from '../../services/admin.service'
import { GameService } from '../../services/game.service'
import { BotService } from '../../services/bot.service'
import prisma from '../../lib/prisma'
import { GameSchedulerService } from '../../services/game-scheduler.service'
import { HouseWalletService } from '../../services/house-wallet.service'
import { CashbackService } from '../../services/cashback.service'
import { NotificationService } from '../../services/notification.service'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'
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
})

const adminRoutes: FastifyPluginAsync = async (fastify) => {
    // Both hooks will run sequentially
    fastify.addHook('preValidation', fastify.authenticate)
    fastify.addHook('preValidation', async (request: any, reply) => {
        if (request.user.role !== 'ADMIN' && request.user.role !== 'SUPER_ADMIN') {
            reply.status(403).send({ error: 'Forbidden: Admin access only' })
        }
    })

    fastify.get('/stats', AdminController.getStats)
    fastify.get('/transactions/pending', AdminController.getPendingDeposits)
    fastify.get('/transactions/history', AdminController.getOrdersHistory)
    fastify.get('/withdrawals', AdminController.getWithdrawals)

    fastify.post('/transactions/:id/approve', AdminController.approveTransaction)
    fastify.post('/transactions/:id/decline', AdminController.declineTransaction)

    // User management (T21 / T43)
    fastify.get('/users', AdminController.getUsers)
    fastify.patch('/users/:id/status', AdminController.updateUserStatus)

    // Game management (T21 / T42)
    fastify.get('/games', AdminController.getGames)
    fastify.post('/games/:id/cancel', async (req: any, reply) => {
        await GameService.cancelGame(req.params.id)
        return { success: true }
    })
    fastify.post('/games/:id/start', async (req: any, reply) => {
        return await GameService.startGame(req.params.id)
    })

    // Manually inject bots into a waiting game (admin-only)
    fastify.post('/games/:gameId/inject-bots', async (req: any, reply) => {
        const { gameId } = req.params

        const game = await prisma.game.findUnique({
            where: { id: gameId },
            select: { status: true, templateId: true },
        })

        if (!game) {
            return reply.status(404).send({ error: 'Game not found' })
        }

        if (!game.templateId) {
            return reply.status(400).send({ error: 'Bots are only supported for template-based games' })
        }

        if (game.status !== 'WAITING') {
            return reply.status(409).send({ error: 'Game is not waiting for players' })
        }

        await BotService.injectBots(gameId)
        return { injected: true }
    })

    // ── Game Templates (always-on preconfigured games) ──────────────────────

    // List all templates
    fastify.get('/game-templates', async (req, reply) => {
        const templates = await prisma.gameTemplate.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                _count: {
                    select: {
                        games: { where: { status: 'WAITING' } },
                    },
                },
            },
        })
        return templates
    })

    // Create a template
    fastify.post('/game-templates', async (req: any, reply) => {
        const parsed = templateCreateSchema.safeParse(req.body)
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues })
        }
        const { title, ticketPrice, maxPlayers, minPlayers, houseEdgePct, pattern, countdownSecs, botEnabled, botCount, botFillToMin, botMaxSpend } = parsed.data
        const template = await prisma.gameTemplate.create({
            data: {
                title,
                ticketPrice,
                maxPlayers,
                minPlayers,
                houseEdgePct,
                pattern: pattern as any,
                countdownSecs,
                active: true,
                botEnabled,
                botCount,
                botFillToMin,
                ...(botMaxSpend != null && { botMaxSpend }),
            },
        })
        // Immediately create a game from this template
        await GameSchedulerService.replenishTemplate(template.id)
        return template
    })

    // Update a template
    fastify.patch('/game-templates/:id', async (req: any, reply) => {
        const { id } = req.params
        const parsed = templateUpdateSchema.safeParse(req.body)
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues })
        }
        const { title, ticketPrice, maxPlayers, minPlayers, houseEdgePct, pattern, countdownSecs, active, botEnabled, botCount, botFillToMin, botMaxSpend } = parsed.data
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
            },
        })
        // If just activated, replenish immediately
        if (active === true) {
            await GameSchedulerService.replenishTemplate(template.id)
        }
        return template
    })

    // Delete a template
    fastify.delete('/game-templates/:id', async (req: any, reply) => {
        const { id } = req.params
        // Deactivate first (don't delete games that are running)
        await prisma.gameTemplate.update({
            where: { id },
            data: { active: false },
        })
        // Optionally delete the template entirely
        await prisma.gameTemplate.delete({ where: { id } })
        return { success: true }
    })

    // ── House Wallet ──────────────────────────────────────────────────────────

    fastify.get('/house/wallet', async (_req, _reply) => {
        const [balance, summary] = await Promise.all([
            HouseWalletService.getBalance(),
            HouseWalletService.getSummary(),
        ])
        return { balance: balance.toFixed(2), currency: 'ETB', summary }
    })

    fastify.get('/house/transactions', async (req: any, _reply) => {
        const page = Number(req.query.page ?? 1)
        const limit = Number(req.query.limit ?? 20)
        const type = req.query.type as 'COMMISSION' | 'BOT_PRIZE_WIN' | 'REFUND_ISSUED' | undefined
        const result = await HouseWalletService.getTransactions(page, limit, type)
        return { ...result, page, limit }
    })

    fastify.get('/house/bots', async (_req, _reply) => {
        return HouseWalletService.getBotActivity()
    })

    fastify.get('/money-flow', async (req: any, _reply) => {
        const q = req.query as Record<string, any>
        const types = q['type[]']
            ? (Array.isArray(q['type[]']) ? q['type[]'] : [q['type[]']])
            : undefined
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

    // ── Player Management ──────────────────────────────────────────────────────

    // Get single player detail with wallet + recent transactions
    fastify.get('/players/:id', async (req: any, reply) => {
        const user = await prisma.user.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                serial: true,
                username: true,
                phone: true,
                role: true,
                isActive: true,
                createdAt: true,
                wallet: { select: { realBalance: true, bonusBalance: true } },
            },
        })
        if (!user) return reply.status(404).send({ error: 'Player not found' })

        const transactions = await prisma.transaction.findMany({
            where: { userId: req.params.id },
            orderBy: { createdAt: 'desc' },
            take: 50,
        })

        const stats = await Promise.all([
            prisma.transaction.aggregate({
                where: { userId: req.params.id, type: TransactionType.GAME_ENTRY },
                _count: true,
                _sum: { amount: true },
            }),
            prisma.transaction.aggregate({
                where: { userId: req.params.id, type: TransactionType.PRIZE_WIN },
                _count: true,
                _sum: { amount: true },
            }),
        ])

        return {
            ...user,
            transactions,
            stats: {
                gamesPlayed: stats[0]._count,
                totalWagered: Number(stats[0]._sum.amount ?? 0),
                gamesWon: stats[1]._count,
                totalWon: Number(stats[1]._sum.amount ?? 0),
            },
        }
    })

    // Admin balance adjustment
    const adjustBalanceSchema = z.object({
        type: z.enum(['real', 'bonus']),
        amount: z.number(),
        note: z.string().min(1, 'Note is required for audit trail'),
    })

    fastify.post('/players/:id/adjust-balance', async (req: any, reply) => {
        const parsed = adjustBalanceSchema.safeParse(req.body)
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
        }

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

                await tx.wallet.update({
                    where: { userId },
                    data: { realBalance: { increment: adjustAmount } },
                })
                await tx.transaction.create({
                    data: {
                        userId,
                        type: TransactionType.ADMIN_REAL_ADJUSTMENT,
                        amount: adjustAmount.abs(),
                        status: PaymentStatus.APPROVED,
                        note: `[Admin] ${note}`,
                        balanceBefore: realBefore,
                        balanceAfter: realAfter,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: bonusBefore,
                    },
                })
                return { realBalance: Number(realAfter), bonusBalance: Number(bonusBefore) }
            } else {
                const bonusAfter = bonusBefore.plus(adjustAmount)
                if (bonusAfter.lessThan(0)) throw new Error('Adjustment would make bonus balance negative')

                await tx.wallet.update({
                    where: { userId },
                    data: { bonusBalance: { increment: adjustAmount } },
                })
                await tx.transaction.create({
                    data: {
                        userId,
                        type: TransactionType.ADMIN_BONUS_ADJUSTMENT,
                        amount: adjustAmount.abs(),
                        status: PaymentStatus.APPROVED,
                        note: `[Admin] ${note}`,
                        balanceBefore: realBefore,
                        balanceAfter: realBefore,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: bonusAfter,
                    },
                })
                return { realBalance: Number(realBefore), bonusBalance: Number(bonusAfter) }
            }
        })

        // Push real-time balance update
        NotificationService.pushWalletUpdate(userId, result.realBalance, result.bonusBalance)

        return result
    })

    // ── Game Providers (Third-Party) ─────────────────────────────────────────

    fastify.get('/providers', async (_req, _reply) => {
        return prisma.gameProvider.findMany({ orderBy: { createdAt: 'asc' } })
    })

    fastify.patch('/providers/:id/status', async (req: any, reply) => {
        const { status } = req.body as { status: string }
        const allowed = ['ACTIVE', 'INACTIVE', 'MAINTENANCE']
        if (!allowed.includes(status)) {
            return reply.status(400).send({ error: 'Invalid status' })
        }
        return prisma.gameProvider.update({
            where: { id: req.params.id },
            data: { status: status as any },
        })
    })

    fastify.post('/providers/:code/sync', async (req: any, reply) => {
        const { GameCatalogService } = await import('../../services/game-catalog.service.js')
        await GameCatalogService.syncAll(req.params.code)
        return { success: true }
    })

    fastify.get('/providers/:code/vendors', async (req: any, _reply) => {
        const provider = await prisma.gameProvider.findUnique({ where: { code: req.params.code } })
        if (!provider) return _reply.status(404).send({ error: 'Provider not found' })
        return prisma.gameVendor.findMany({ where: { providerId: provider.id }, orderBy: { name: 'asc' } })
    })

    fastify.patch('/providers/:code/vendors/:vendorCode/status', async (req: any, reply) => {
        const provider = await prisma.gameProvider.findUnique({ where: { code: req.params.code } })
        if (!provider) return reply.status(404).send({ error: 'Provider not found' })
        const vendor = await prisma.gameVendor.findUnique({
            where: { providerId_code: { providerId: provider.id, code: req.params.vendorCode } },
        })
        if (!vendor) return reply.status(404).send({ error: 'Vendor not found' })
        return prisma.gameVendor.update({
            where: { id: vendor.id },
            data: { isActive: req.body.isActive },
        })
    })

    fastify.get('/providers/:code/games', async (req: any, _reply) => {
        const provider = await prisma.gameProvider.findUnique({ where: { code: req.params.code } })
        if (!provider) return _reply.status(404).send({ error: 'Provider not found' })
        const page = Math.max(1, Number(req.query.page ?? 1))
        const limit = Math.min(100, Number(req.query.limit ?? 50))
        const [data, total] = await Promise.all([
            prisma.providerGame.findMany({
                where: { providerId: provider.id },
                skip: (page - 1) * limit,
                take: limit,
                orderBy: [{ sortOrder: 'asc' }, { gameName: 'asc' }],
            }),
            prisma.providerGame.count({ where: { providerId: provider.id } }),
        ])
        return { data, total, page, limit }
    })

    fastify.patch('/providers/:code/games/:gameCode/status', async (req: any, reply) => {
        const provider = await prisma.gameProvider.findUnique({ where: { code: req.params.code } })
        if (!provider) return reply.status(404).send({ error: 'Provider not found' })
        const game = await prisma.providerGame.findUnique({
            where: { providerId_gameCode: { providerId: provider.id, gameCode: req.params.gameCode } },
        })
        if (!game) return reply.status(404).send({ error: 'Game not found' })
        return prisma.providerGame.update({
            where: { id: game.id },
            data: { isActive: req.body.isActive },
        })
    })

    fastify.get('/providers/:code/transactions', async (req: any, _reply) => {
        const provider = await prisma.gameProvider.findUnique({ where: { code: req.params.code } })
        if (!provider) return _reply.status(404).send({ error: 'Provider not found' })
        const page = Math.max(1, Number(req.query.page ?? 1))
        const limit = Math.min(100, Number(req.query.limit ?? 30))
        const [data, total] = await Promise.all([
            prisma.thirdPartyTransaction.findMany({
                where: { providerId: provider.id },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.thirdPartyTransaction.count({ where: { providerId: provider.id } }),
        ])
        return { data, total, page, limit }
    })

    // ── Cashback Promotions ──────────────────────────────────────────────────

    fastify.get('/cashback', async (_req, _reply) => {
        return CashbackService.listPromotions()
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

    // ── Payment Methods ──────────────────────────────────────────────────────

    const paymentMethodCreateSchema = z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        type: z.enum(['DEPOSIT', 'WITHDRAWAL']),
        merchantAccount: z.string().optional(),
        instructions: z.string().optional(),
        icon: z.string().optional(),
        enabled: z.boolean().default(true),
        sortOrder: z.number().int().default(0),
    })

    const paymentMethodUpdateSchema = z.object({
        code: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        type: z.enum(['DEPOSIT', 'WITHDRAWAL']).optional(),
        merchantAccount: z.string().optional(),
        instructions: z.string().optional(),
        icon: z.string().optional(),
        enabled: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
    })

    // GET /admin/payment-methods — all methods including disabled
    fastify.get('/payment-methods', async (_req, _reply) => {
        return prisma.paymentMethod.findMany({
            orderBy: { sortOrder: 'asc' },
        })
    })

    // POST /admin/payment-methods — create a new method
    fastify.post('/payment-methods', async (req: any, reply) => {
        const parsed = paymentMethodCreateSchema.safeParse(req.body)
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues })
        }
        try {
            const d = parsed.data
            const method = await prisma.paymentMethod.create({
                data: {
                    code: d.code,
                    name: d.name,
                    type: d.type as import('@prisma/client').PaymentMethodType,
                    merchantAccount: d.merchantAccount,
                    instructions: d.instructions,
                    icon: d.icon,
                    enabled: d.enabled,
                    sortOrder: d.sortOrder,
                },
            })
            return reply.status(201).send(method)
        } catch (err: any) {
            if (err?.code === 'P2002') {
                return reply.status(409).send({ error: 'A payment method with that code already exists' })
            }
            throw err
        }
    })

    // PUT /admin/payment-methods/:id — partial update
    fastify.put('/payment-methods/:id', async (req: any, reply) => {
        const { id } = (req.params as { id: string })
        const parsed = paymentMethodUpdateSchema.safeParse(req.body)
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues })
        }
        try {
            const { type, ...rest } = parsed.data
            const method = await prisma.paymentMethod.update({
                where: { id },
                data: {
                    ...rest,
                    ...(type ? { type: type as import('@prisma/client').PaymentMethodType } : {}),
                },
            })
            return method
        } catch (err: any) {
            if (err?.code === 'P2025') {
                return reply.status(404).send({ error: 'Payment method not found' })
            }
            if (err?.code === 'P2002') {
                return reply.status(409).send({ error: 'A payment method with that code already exists' })
            }
            throw err
        }
    })

    // DELETE /admin/payment-methods/:id — hard delete
    fastify.delete('/payment-methods/:id', async (req: any, reply) => {
        const { id } = (req.params as { id: string })
        try {
            await prisma.paymentMethod.delete({ where: { id } })
            return { success: true }
        } catch (err: any) {
            if (err?.code === 'P2025') {
                return reply.status(404).send({ error: 'Payment method not found' })
            }
            throw err
        }
    })

}

export default adminRoutes
