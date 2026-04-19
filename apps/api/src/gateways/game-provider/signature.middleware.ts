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
        request.log.warn('[GASea] Missing or invalid X-Signature header on %s', request.url)
        return reply.status(200).send({
            traceId: (request.body as any)?.traceId ?? '',
            status: 'SC_INVALID_SIGNATURE',
        })
    }

    const hasRawBody = typeof (request as any).rawBody === 'string' && (request as any).rawBody.length > 0
    const rawBody: string = hasRawBody
        ? (request as any).rawBody
        : JSON.stringify(request.body ?? {})

    if (!hasRawBody) {
        request.log.warn('[GASea] rawBody missing on %s — falling back to JSON.stringify (signature may fail)', request.url)
    }

    const secret = getSecret()
    const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex')

    // Constant-time comparison to prevent timing attacks
    const sigBuf = Buffer.from(signature)
    const expBuf = Buffer.from(expected)

    const valid =
        sigBuf.length === expBuf.length &&
        crypto.timingSafeEqual(sigBuf, expBuf)

    if (!valid) {
        request.log.warn(
            '[GASea] Signature mismatch on %s | received=%s expected=%s rawBodyLen=%d hasRawBody=%s',
            request.url, signature, expected, rawBody.length, hasRawBody,
        )
        return reply.status(200).send({
            traceId: (request.body as any)?.traceId ?? '',
            status: 'SC_INVALID_SIGNATURE',
        })
    }
}
