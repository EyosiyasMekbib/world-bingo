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

// Optional IP allowlist. Palace signs no callback body, so the static Callback-Token
// is the only secret — if it leaks, an attacker can POST forged wins. Restricting the
// source IPs is cheap defense-in-depth. Set PALACE_CALLBACK_IP_ALLOWLIST to a
// comma-separated list of Palace's egress IPs to enable; empty = allow all (unchanged).
let _ipAllowlist: string[] | null = null
function getIpAllowlist(): string[] {
    if (_ipAllowlist === null) {
        _ipAllowlist = (process.env.PALACE_CALLBACK_IP_ALLOWLIST ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    }
    return _ipAllowlist
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
    // IP allowlist (if configured) is checked before the token.
    const allowlist = getIpAllowlist()
    if (allowlist.length > 0 && !allowlist.includes(request.ip)) {
        request.log.warn('[Palace] Callback from non-allowlisted IP %s on %s', request.ip, request.url)
        return reply.status(200).send(palaceError(1009, 'TOKEN_INVALID'))
    }

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
