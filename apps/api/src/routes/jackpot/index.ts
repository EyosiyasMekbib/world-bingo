/**
 * T59 — Jackpot routes
 *
 * GET /jackpot       — returns current jackpot amount (public)
 * GET /jackpot/wins  — returns recent jackpot wins (public)
 */
import { FastifyPluginAsync } from 'fastify'
import { JackpotService } from '../../services/jackpot.service'
import prisma from '../../lib/prisma'

const jackpotRoutes: FastifyPluginAsync = async (fastify) => {
    /** GET /jackpot — current jackpot amount */
    fastify.get('/', async (_req, reply) => {
        const amount = await JackpotService.getCurrentAmount()
        return reply.send({ amount })
    })

    /** GET /jackpot/wins — last 10 jackpot wins */
    fastify.get('/wins', async (_req, reply) => {
        const wins = await prisma.jackpotWin.findMany({
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: {
                jackpot: { select: { id: true } },
            },
        })
        return reply.send(wins)
    })
}

export default jackpotRoutes
