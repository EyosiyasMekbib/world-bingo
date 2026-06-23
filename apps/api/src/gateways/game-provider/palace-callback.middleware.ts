import crypto from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'

let _token: string | null = null

function getCallbackToken(): string {
    if (!_token) {
        const t = (process.env.PALACE_CALLBACK_TOKEN ?? '').trim()
        if (!t) console.warn('[Palace] WARNING: PALACE_CALLBACK_TOKEN is empty — all callback auth will fail')
        else _token = t
        return t
    }
    return _token
}

function palaceError(result: number, status: string) {
    return { result, status, data: null }
}

/**
 * Fastify preHandler that verifies the Callback-Token header sent by Palace Casino
 * on every wallet callback. Uses timing-safe comparison to prevent timing attacks.
 *
 * Palace response format on failure: { result: number, status: string, data: null }
 * Returns HTTP 200 even on auth failure — Palace retries on non-200.
 */
export async function verifyPalaceCallbackToken(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const received = request.headers['callback-token']

    if (!received || typeof received !== 'string') {
        request.log.warn('[Palace] Missing Callback-Token header on %s', request.url)
        return reply.status(200).send(palaceError(1007, 'TOKEN_NOT_FOUND'))
    }

    const expected = getCallbackToken()
    if (!expected) {
        return reply.status(200).send(palaceError(1001, 'INTERNAL_SERVER_ERROR'))
    }

    // Hash both sides to fixed-length digests before comparing — hides both value and length
    const hmacKey = Buffer.alloc(32)
    const digestA = crypto.createHmac('sha256', hmacKey).update(received).digest()
    const digestB = crypto.createHmac('sha256', hmacKey).update(expected).digest()
    const same = crypto.timingSafeEqual(digestA, digestB)

    if (!same) {
        request.log.warn('[Palace] Invalid Callback-Token on %s', request.url)
        return reply.status(200).send(palaceError(1009, 'TOKEN_INVALID'))
    }
    // Passes — preHandler returns undefined (Fastify continues to handler)
}
