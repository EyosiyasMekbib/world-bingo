import crypto from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'

const API_SECRET = process.env.GASEA_API_SECRET ?? ''

/**
 * Fastify preHandler that verifies the X-Signature header sent by GASea on
 * every wallet callback. Uses HMAC-SHA256 of the raw request body.
 *
 * IMPORTANT: This middleware requires rawBody to be available on the request.
 * Register the rawBody content-type parser in the Fastify server before mounting
 * callback routes — see index.ts.
 *
 * All errors return HTTP 200 with SC_INVALID_SIGNATURE (GASea expects 200 always).
 */
export async function verifyGaseaSignature(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const signature = request.headers['x-signature']

    if (!signature || typeof signature !== 'string') {
        return reply.status(200).send({
            traceId: (request.body as any)?.traceId ?? '',
            status: 'SC_INVALID_SIGNATURE',
        })
    }

    const rawBody: string = (request as any).rawBody ?? JSON.stringify(request.body ?? {})

    const expected = crypto
        .createHmac('sha256', API_SECRET)
        .update(rawBody)
        .digest('hex')

    // Constant-time comparison to prevent timing attacks
    const sigBuf = Buffer.from(signature)
    const expBuf = Buffer.from(expected)

    const valid =
        sigBuf.length === expBuf.length &&
        crypto.timingSafeEqual(sigBuf, expBuf)

    if (!valid) {
        return reply.status(200).send({
            traceId: (request.body as any)?.traceId ?? '',
            status: 'SC_INVALID_SIGNATURE',
        })
    }
}
