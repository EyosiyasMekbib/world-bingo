import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { EventService } from '../../services/event.service.js'

const rawEventSchema = z.object({
    name: z.string(),
    anonId: z.string().max(128).optional().nullable(),
    sessionId: z.string().max(128).optional().nullable(),
    props: z.record(z.unknown()).optional().nullable(),
})

const batchSchema = z.object({
    events: z.array(rawEventSchema).max(50),
    anonId: z.string().max(128).optional().nullable(),
    sessionId: z.string().max(128).optional().nullable(),
})

const identifySchema = z.object({
    anonId: z.string().max(128),
    sessionId: z.string().max(128).optional().nullable(),
})

async function tryGetUserId(request: any): Promise<string | undefined> {
    try {
        await request.jwtVerify()
        return request.user?.id as string | undefined
    } catch {
        return undefined
    }
}

const eventsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post('/events', {
        config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    }, async (req: any, reply) => {
        const parsed = batchSchema.safeParse(req.body)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid payload' })

        const userId = await tryGetUserId(req)
        const { events, anonId: batchAnonId, sessionId: batchSessionId } = parsed.data

        const normalized = events.map(e => ({
            name: e.name,
            anonId: e.anonId ?? batchAnonId ?? null,
            sessionId: e.sessionId ?? batchSessionId ?? null,
            props: (e.props && Object.keys(e.props).length > 0) ? e.props as Record<string, unknown> : null,
        }))

        await EventService.record(normalized, { userId })
        return reply.status(204).send()
    })

    fastify.post('/events/identify', {
        config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    }, async (req: any, reply) => {
        const parsed = identifySchema.safeParse(req.body)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid payload' })

        const userId = await tryGetUserId(req)
        await EventService.record(
            [{ name: 'identify', anonId: parsed.data.anonId, sessionId: parsed.data.sessionId ?? null, props: null }],
            { userId },
        )
        return reply.status(204).send()
    })
}

export default eventsRoutes
