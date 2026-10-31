import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import prisma from '../../lib/prisma'
import { rateLimitKey } from '../../lib/rate-limit-key'
import { NotificationService } from '../../services/notification.service'

const broadcastSchema = z.object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(1000),
})

/**
 * Broadcast announcements to every player. Registered inside the requireAdmin
 * sub-plugin in ./index.ts — no extra auth here.
 */
const notificationAdminRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/broadcasts', async () => {
        return { items: await NotificationService.listBroadcasts() }
    })

    fastify.post(
        '/broadcast',
        {
            config: {
                rateLimit: {
                    // One broadcast writes a row per player; a double-click or a
                    // runaway script must not flood every inbox.
                    max: 5,
                    timeWindow: '10 minutes',
                    hook: 'preValidation',
                    keyGenerator: (req: any) =>
                        `notification-broadcast:${rateLimitKey({ userId: req.user?.id, ip: req.ip })}`,
                },
            },
        },
        async (req: any, reply) => {
            const parsed = broadcastSchema.safeParse(req.body)
            if (!parsed.success) {
                return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' })
            }
            const actor = await prisma.user.findUnique({
                where: { id: req.user.id },
                select: { username: true },
            })
            const { title, body } = parsed.data as z.infer<typeof broadcastSchema> & { title: string; body: string }
            const item = await NotificationService.broadcast({
                title,
                body,
                sentById: req.user.id,
                sentByName: actor?.username ?? null,
            })
            return reply.status(201).send({ item })
        },
    )
}

export default notificationAdminRoutes
