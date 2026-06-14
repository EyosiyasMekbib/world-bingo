import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AnalyticsService } from '../../services/analytics.service'

const rangeQuerySchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
})

const retentionQuerySchema = z.object({
    weeks: z.coerce.number().int().min(2).max(26).default(8),
})

// Registered inside the requireAdmin sub-plugin in ./index.ts — no extra auth here.
const analyticsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/funnel', async (req: any, reply) => {
        const parsed = rangeQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        try {
            const { from, to } = AnalyticsService.parseRange(parsed.data.from, parsed.data.to)
            return await AnalyticsService.getFunnel(from, to)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })

    fastify.get('/retention', async (req: any, reply) => {
        const parsed = retentionQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        return AnalyticsService.getRetention(parsed.data.weeks)
    })

    fastify.get('/games-health', async (req: any, reply) => {
        const parsed = rangeQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        try {
            const { from, to } = AnalyticsService.parseRange(parsed.data.from, parsed.data.to)
            return await AnalyticsService.getGamesHealth(from, to)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })

    fastify.get('/engagement', async (_req, _reply) => {
        return AnalyticsService.getEngagement()
    })

    fastify.get('/browse-funnel', async (req: any, reply) => {
        const parsed = rangeQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        try {
            const { from, to } = AnalyticsService.parseRange(parsed.data.from, parsed.data.to)
            return await AnalyticsService.getBrowseFunnel(from, to)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })

    fastify.get('/deposit-funnel', async (req: any, reply) => {
        const parsed = rangeQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        try {
            const { from, to } = AnalyticsService.parseRange(parsed.data.from, parsed.data.to)
            return await AnalyticsService.getDepositFunnel(from, to)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })

    fastify.get('/conversion-kpis', async (req: any, reply) => {
        const parsed = rangeQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        try {
            const { from, to } = AnalyticsService.parseRange(parsed.data.from, parsed.data.to)
            return await AnalyticsService.getConversionKpis(from, to)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })

    fastify.get('/game-retention', async (req: any, reply) => {
        const parsed = rangeQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        try {
            const { from, to } = AnalyticsService.parseRange(parsed.data.from, parsed.data.to)
            return await AnalyticsService.getGameRetentionScorecard(from, to)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })

    fastify.get('/provider-browse-funnel', async (req: any, reply) => {
        const parsed = rangeQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        try {
            const { from, to } = AnalyticsService.parseRange(parsed.data.from, parsed.data.to)
            return await AnalyticsService.getProviderBrowseFunnel(from, to)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })
}

export default analyticsRoutes
