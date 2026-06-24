import { FastifyPluginAsync } from 'fastify'
import { CreateGameSchema, JoinGameSchema, ClaimBingoSchema } from '@world-bingo/shared-types'
import { GameController } from '../../controllers/game.controller'
import { GameService } from '../../services'
import prisma from '../../lib/prisma.js'
import zodToJsonSchema from 'zod-to-json-schema'

const gameRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post('/', {
        preValidation: [fastify.authenticate],
        schema: {
            body: zodToJsonSchema(CreateGameSchema),
        },
        handler: GameController.create,
    })

    fastify.get('/', {
        handler: GameController.list,
    })

    fastify.get('/:id', {
        handler: GameController.get,
    })

    fastify.get('/:id/cartelas', {
        handler: GameController.getAvailableCartelas,
    })

    fastify.post('/:id/join', {
        preValidation: [fastify.authenticate],
        schema: {
            body: zodToJsonSchema(JoinGameSchema),
        },
        handler: async (req, reply) => {
            // @ts-ignore
            const userId = req.user.id
            // @ts-ignore
            const gameId = req.params.id
            const { cartelaSerials } = req.body as { cartelaSerials: string[] }
            return await GameService.joinGame(userId, gameId, cartelaSerials)
        },
    })

    fastify.post('/:id/claim', {
        preValidation: [fastify.authenticate],
        schema: {
            body: zodToJsonSchema(ClaimBingoSchema),
        },
        handler: async (req, reply) => {
            // @ts-ignore
            const userId = req.user.id
            // @ts-ignore
            const gameId = req.params.id
            const { cartelaId } = req.body as { cartelaId: string }
            return await GameService.claimBingo(userId, gameId, cartelaId)
        },
    })
    
    fastify.post('/:id/start', {
        preValidation: [fastify.requireAdmin],
        handler: async (req, reply) => {
            // @ts-ignore
            return await GameService.startGame(req.params.id)
        }
    })

    fastify.post('/:id/cancel', {
        preValidation: [fastify.requireAdmin],
        handler: async (req, reply) => {
            // @ts-ignore
            await GameService.cancelGame(req.params.id)
            return { success: true }
        }
    })

    fastify.post('/:id/leave', {
        preValidation: [fastify.authenticate],
        handler: GameController.leave,
    })

    fastify.get('/recent-winners', {
        handler: async (req, reply) => {
            const { period = 'daily' } = req.query as { period?: string }
            const now = new Date()
            const since = new Date(now)
            if (period === 'weekly') since.setDate(now.getDate() - 7)
            else if (period === 'monthly') since.setMonth(now.getMonth() - 1)
            else since.setDate(now.getDate() - 1)

            const rows = await prisma.transaction.findMany({
                where: {
                    type: 'PRIZE_WIN',
                    status: 'APPROVED',
                    createdAt: { gte: since },
                    amount: { gt: 0 },
                },
                orderBy: { amount: 'desc' },
                take: 20,
                select: {
                    amount: true,
                    createdAt: true,
                    user: { select: { username: true } },
                    referenceId: true,
                },
            })

            return rows.map((r) => {
                const username = r.user?.username ?? 'Player'
                const masked = username.length > 4
                    ? username.slice(0, 2) + '*'.repeat(username.length - 4) + username.slice(-2)
                    : username[0] + '***'
                return {
                    username: masked,
                    amount: Number(r.amount),
                    createdAt: r.createdAt,
                    gameId: r.referenceId,
                }
            })
        },
    })
}

export default gameRoutes
