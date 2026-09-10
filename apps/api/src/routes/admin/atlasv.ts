import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import prisma from '../../lib/prisma.js'
import { getGameProviderGateway } from '../../gateways/game-provider/index.js'
import { accountForLaunch } from '../game-provider/account-for-launch.js'

const grantFreespinsSchema = z.object({
    userId: z.string().uuid(),
    endDate: z.string(), // ISO 8601, e.g. "2026-12-14T11:55:00+00:00"
    freespinsCount: z.number().int().positive(),
})

// Registered inside the requireAdmin sub-plugin in ./index.ts — no extra auth here.
const atlasVAdminRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post('/freespins', async (req: any, reply) => {
        const parsed = grantFreespinsSchema.safeParse(req.body)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues })

        const { userId, endDate, freespinsCount } = parsed.data
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
        if (!user) return reply.status(404).send({ error: 'User not found' })

        const gateway = getGameProviderGateway('atlasv') as any
        const playerId = accountForLaunch(userId.replace(/-/g, ''))
        try {
            await gateway.createFreeSpins(playerId, endDate, freespinsCount)
        } catch (err: any) {
            req.log.error({ err, userId, freespinsCount }, '[Atlas-V] freespin grant failed')
            return reply.status(502).send({ error: 'Atlas-V freespin grant failed', message: err?.message })
        }
        return { success: true }
    })
}

export default atlasVAdminRoutes
