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

const launchProbeSchema = z.object({
    gameCode: z.string().min(1).max(64),
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

    // Launch probe: calls Atlas-V /init exactly like a player launch, as the calling
    // admin's own account, and returns the upstream error in the response body.
    // Container logs do not survive a redeploy and Dokploy's log search failed during
    // the 2026-09-14 incident, so the real message must be reachable another way.
    // Returns booleans for config and only the host of a working URL: no secrets,
    // no session token. Moves no money (/init only opens a session).
    fastify.post('/launch-probe', async (req: any, reply) => {
        const parsed = launchProbeSchema.safeParse(req.body)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues })
        const adminId: string | undefined = req.user?.id
        if (!adminId) return reply.status(401).send({ error: 'Unauthorized' })

        const config = {
            serverUrlSet: !!process.env.ATLASV_SERVER_URL,
            casinoIdSet: !!process.env.ATLASV_CASINO_ID,
            privateKeySet: !!(process.env.ATLASV_PRIVATE_KEY ?? '').trim(),
        }
        const gateway = getGameProviderGateway('atlasv')
        const startedAt = Date.now()
        try {
            const { gameUrl } = await gateway.getGameUrl({
                username: accountForLaunch(adminId.replace(/-/g, '')),
                gameCode: parsed.data.gameCode,
                language: process.env.ATLASV_DEFAULT_LANGUAGE || 'en',
                platform: 'WEB',
                currency: process.env.ATLASV_DEFAULT_CURRENCY || 'ETB',
                lobbyUrl: `${(process.env.WEB_BASE_URL || 'https://aradabingo.bet').replace(/\/$/, '')}/`,
                ipAddress: req.ip,
            })
            let gameUrlHost: string | null = null
            try {
                gameUrlHost = new URL(gameUrl).host
            } catch {
                gameUrlHost = null
            }
            return { ok: /^https:\/\//i.test(gameUrl), latencyMs: Date.now() - startedAt, gameUrlHost, config }
        } catch (err: any) {
            req.log.error({ err, gameCode: parsed.data.gameCode }, '[Atlas-V] launch probe failed')
            return {
                ok: false,
                latencyMs: Date.now() - startedAt,
                code: err?.code ?? null,
                message: String(err?.message ?? 'unknown error'),
                config,
            }
        }
    })
}

export default atlasVAdminRoutes
