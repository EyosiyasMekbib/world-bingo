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

/** HMAC-SHA256 helper */
function hmac(secret: string, data: string): string {
    return crypto.createHmac('sha256', secret).update(data).digest('hex')
}

/** Constant-time signature comparison */
function signaturesMatch(received: string, expected: string): boolean {
    const a = Buffer.from(received)
    const b = Buffer.from(expected)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Fastify preHandler that verifies the X-Signature header sent by GASea on
 * every wallet callback. Uses HMAC-SHA256 of the raw request body.
 *
 * GASea Seamless Wallet API v3.1.0 excludes the `token` field from the
 * signed payload. We try the raw body first, then fall back to body-without-token.
 *
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

    const hasRawBody = typeof (request as any).rawBody === 'string' && (request as any).rawBody.length > 0
    const rawBody: string = hasRawBody
        ? (request as any).rawBody
        : JSON.stringify(request.body ?? {})

    if (!hasRawBody) {
        request.log.warn('[GASea] rawBody missing on %s — using JSON.stringify fallback', request.url)
    }

    const secret = getSecret()

    // ── Attempt 1: verify against the raw body as-is ─────────────────────────
    const expectedRaw = hmac(secret, rawBody)
    if (signaturesMatch(signature, expectedRaw)) return // ✓ passed

    // ── Attempt 2: verify excluding `token` from the payload ─────────────────
    // GASea's seamless wallet API excludes the session token from the HMAC.
    try {
        const parsed = request.body as Record<string, unknown> | null
        if (parsed && typeof parsed === 'object' && 'token' in parsed) {
            const { token: _excluded, ...withoutToken } = parsed
            const expectedNoToken = hmac(secret, JSON.stringify(withoutToken))
            if (signaturesMatch(signature, expectedNoToken)) return // ✓ passed
        }
    } catch { /* body parse edge case — fall through to reject */ }

    // ── Both failed ──────────────────────────────────────────────────────────
    request.log.warn(
        '[GASea] Signature mismatch on %s | received=%s expectedRaw=%s rawBodyLen=%d hasRawBody=%s',
        request.url, signature, expectedRaw, rawBody.length, hasRawBody,
    )
    return reply.status(200).send({
        traceId: (request.body as any)?.traceId ?? '',
        status: 'SC_INVALID_SIGNATURE',
    })
}
