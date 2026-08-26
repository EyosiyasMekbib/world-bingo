/**
 * POST /v1/zarecash/webhook
 *
 * Public, unauthenticated by JWT — the HMAC is the authentication. Verifies over
 * the RAW body, dedupes on the event id, returns 200 immediately, and hands the
 * work to a worker. The contract allows 10 seconds; we use a fraction of it.
 */

import { FastifyPluginAsync } from 'fastify'
import prisma from '../../lib/prisma.js'
import { getQueue, QUEUE_NAMES } from '../../lib/queue.js'
import { zarecashConfig } from '../../gateways/payment/zarecash/config.js'
import { verifyWebhookSignature, SIGNATURE_HEADER } from '../../gateways/payment/zarecash/signature.js'

interface RawBodyPayload {
    __rawBody?: string
    id?: string
    type?: string
    [k: string]: unknown
}

const zarecashWebhookRoute: FastifyPluginAsync = async (fastify) => {
    // Route-scoped raw-body capture — same pattern as routes/hub/spoke-callback.ts.
    fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
        try {
            done(null, { ...JSON.parse(body as string), __rawBody: body as string })
        } catch (e) {
            done(e as Error, undefined)
        }
    })

    fastify.post('/', async (req, reply) => {
        const cfg = zarecashConfig()
        const payload = req.body as RawBodyPayload
        const raw = payload?.__rawBody ?? ''
        const header = req.headers[SIGNATURE_HEADER] as string | undefined

        if (!verifyWebhookSignature({ secret: cfg.webhookSecret, rawBody: raw, header })) {
            req.log.warn('[ZareCash] webhook rejected: invalid signature')
            return reply.code(401).send({ error: 'invalid_signature' })
        }

        const { __rawBody, ...envelope } = payload
        if (!envelope.id || !envelope.type) {
            return reply.code(400).send({ error: 'invalid_envelope' })
        }

        try {
            await prisma.zareCashEvent.create({
                data: { id: String(envelope.id), type: String(envelope.type), payload: envelope as object },
            })
        } catch (err: any) {
            // P2002 = unique violation = at-least-once redelivery. Already have it.
            if (err?.code === 'P2002') {
                // If a prior delivery inserted the row but crashed (or the enqueue
                // itself threw) before the job was created, processedAt is still null
                // and no job exists — re-enqueue now so the event isn't stranded.
                const existing = await prisma.zareCashEvent.findUnique({ where: { id: String(envelope.id) } })
                if (existing && existing.processedAt === null) {
                    await getQueue(QUEUE_NAMES.ZARECASH_EVENT).add('process', { eventId: String(envelope.id) })
                }
                return reply.code(200).send({ received: true, duplicate: true })
            }
            throw err
        }

        await getQueue(QUEUE_NAMES.ZARECASH_EVENT).add('process', { eventId: String(envelope.id) })
        return reply.code(200).send({ received: true })
    })
}

export default zarecashWebhookRoute
