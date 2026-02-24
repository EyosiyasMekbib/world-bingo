import { FastifyPluginAsync } from 'fastify'
import { AdminController } from '../../controllers/admin.controller'
import { GameService } from '../../services/game.service'
import prisma from '../../lib/prisma'
import { GameSchedulerService } from '../../services/game-scheduler.service'

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
        const { title, ticketPrice, maxPlayers, minPlayers, houseEdgePct, pattern, countdownSecs } = req.body
        const template = await prisma.gameTemplate.create({
            data: {
                title,
                ticketPrice,
                maxPlayers: maxPlayers ?? 70,
                minPlayers: minPlayers ?? 2,
                houseEdgePct: houseEdgePct ?? 10,
                pattern: pattern ?? 'ANY_LINE',
                countdownSecs: countdownSecs ?? 60,
                active: true,
            },
        })
        // Immediately create a game from this template
        await GameSchedulerService.replenishTemplate(template.id)
        return template
    })

    // Update a template
    fastify.patch('/game-templates/:id', async (req: any, reply) => {
        const { id } = req.params
        const { title, ticketPrice, maxPlayers, minPlayers, houseEdgePct, pattern, countdownSecs, active } = req.body
        const template = await prisma.gameTemplate.update({
            where: { id },
            data: {
                ...(title !== undefined && { title }),
                ...(ticketPrice !== undefined && { ticketPrice }),
                ...(maxPlayers !== undefined && { maxPlayers }),
                ...(minPlayers !== undefined && { minPlayers }),
                ...(houseEdgePct !== undefined && { houseEdgePct }),
                ...(pattern !== undefined && { pattern }),
                ...(countdownSecs !== undefined && { countdownSecs }),
                ...(active !== undefined && { active }),
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