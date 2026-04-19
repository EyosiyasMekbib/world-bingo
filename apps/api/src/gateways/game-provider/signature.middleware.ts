import crypto from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'

/**
 * Resolve API_SECRET lazily so dotenv.config() has a chance to run first
 * (ESM evaluates imports before the importing module body).
 */
let _secret: string | null = null
function getSecret(): string {
    if (_secret === null) {
        _secret = process.env.GASEA_API_SECRET ?? ''
        if (!_secret) {
            console.warn('[GASea] WARNING: GASEA_API_SECRET is empty — all signature checks will fail')
        }
    }
    return _secret
}

/**
 * Fastify preHandler that verifies the X-Signature header sent by GASea on
 * every wallet callback.
 *
 * Per GASea Seamless Wallet API v3.1.0: X-Signature = HMAC-SHA256(secret, rawBody).
 * The entire request body (including token) is signed.
 *
 * rawBody is set by the custom content type parser in wallet.ts.
 * All responses are HTTP 200 — GASea interprets non-200 as a network failure.
 */
export async function verifyGaseaSignature(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const signature = request.headers['x-signature']

    if (!signature || typeof signature !== 'string') {
        request.log.warn('[GASea] Missing X-Signature header on %s', request.url)
        return reply.status(200).send({
            traceId: (request.body as any)?.traceId ?? '',
            status: 'SC_INVALID_SIGNATURE',
        })
    }

    const rawBody: string | undefined = (request as any).rawBody
    if (!rawBody) {
        request.log.error('[GASea] rawBody not set on %s — content type parser did not fire', request.url)
        return reply.status(200).send({
            traceId: (request.body as any)?.traceId ?? '',
            status: 'SC_INVALID_SIGNATURE',
        })
    }

    const secret = getSecret()
    const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex')

    // Constant-time comparison to prevent timing attacks
    const sigBuf = Buffer.from(signature)
    const expBuf = Buffer.from(expected)

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        request.log.warn(
            '[GASea] Signature mismatch on %s | received=%s expected=%s bodyLen=%d',
            request.url, signature, expected, rawBody.length,
        )
        return reply.status(200).send({
            traceId: (request.body as any)?.traceId ?? '',
            status: 'SC_INVALID_SIGNATURE',
        })
    }
}
