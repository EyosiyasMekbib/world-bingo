/**
 * T57 — Referral routes
 *
 * GET  /referral/code   — return (or create) the caller's referral code + stats
 * GET  /referral/stats  — alias for /referral/code (same response)
 */
import { FastifyPluginAsync } from 'fastify'
import { ReferralService } from '../../services/referral.service'

const referralRoutes: FastifyPluginAsync = async (fastify) => {
    // Both endpoints require authentication
    fastify.addHook('onRequest', fastify.authenticate)

    /** GET /referral/code — get or generate the caller's referral code + stats */
    fastify.get('/code', async (request, reply) => {
        const userId = (request.user as any).id
        const stats = await ReferralService.getStats(userId)
        return reply.send(stats)
    })

    /** GET /referral/stats — alias */
    fastify.get('/stats', async (request, reply) => {
        const userId = (request.user as any).id
        const stats = await ReferralService.getStats(userId)
        return reply.send(stats)
    })
}

export default referralRoutes
