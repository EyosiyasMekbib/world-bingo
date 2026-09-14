import { FastifyPluginAsync } from 'fastify'
import { PayerIdentityService } from '../../services/payer-identity.service'

function intParam(raw: unknown, fallback: number, min: number, max: number): number | null {
    if (raw === undefined || raw === '') return fallback
    const n = Number(raw)
    return Number.isInteger(n) && n >= min && n <= max ? n : null
}

// Registered inside the requireAdmin sub-plugin in ./index.ts — no extra auth here.
const fraudAdminRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/shared-payers', async (req, reply) => {
        const query = req.query as { days?: string; limit?: string }
        const days = intParam(query.days, 14, 1, 90)
        const limit = intParam(query.limit, 50, 1, 200)
        if (days === null || limit === null) {
            return reply.status(400).send({ error: 'days must be an integer 1-90 and limit an integer 1-200' })
        }
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        const clusters = await PayerIdentityService.listSharedPayerClusters({ since, limit })
        return { since: since.toISOString(), days, clusters }
    })
}

export default fraudAdminRoutes
