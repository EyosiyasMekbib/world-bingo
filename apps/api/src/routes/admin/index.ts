import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AdminController } from '../../controllers/admin.controller'
import { GameService } from '../../services/game.service'
import { BotService } from '../../services/bot.service'
import prisma from '../../lib/prisma'
import { GameSchedulerService } from '../../services/game-scheduler.service'

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
        const { title, ticketPrice, maxPlayers, minPlayers, houseEdgePct, pattern, countdownSecs, botEnabled, botCount, botFillToMin } = parsed.data
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
        const { title, ticketPrice, maxPlayers, minPlayers, houseEdgePct, pattern, countdownSecs, active, botEnabled, botCount, botFillToMin } = parsed.data
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
}

export default adminRoutes
