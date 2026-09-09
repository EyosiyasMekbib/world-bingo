import { createHash } from 'crypto'

/**
 * Rate-limit bucket for one request.
 *
 * Keyed by user id whenever the caller is authenticated, because Ethiopian
 * carriers put thousands of players behind a handful of NAT addresses — a
 * per-IP budget makes one busy player throttle a whole neighbourhood, and a
 * 429 on a refresh used to read as "logged out".
 *
 * Anonymous traffic keys on `ip`, which MUST be Fastify's `request.ip` and
 * never a raw `x-forwarded-for` value. This used to read the header's first
 * hop directly, which any client could set: sending a fresh
 * `X-Forwarded-For` per request minted a fresh bucket per request and made
 * the limiter a no-op against exactly the traffic it exists to stop. Traefik
 * *appends* rather than replaces, so the leftmost entry is attacker-chosen.
 *
 * `request.ip` is safe only because the server pins how many proxy hops it
 * trusts (`TRUST_PROXY_HOPS`, see index.ts): Fastify then walks the header
 * from the right, skips exactly that many trusted hops, and takes the next
 * address — a spoofed prefix is ignored no matter how long it is.
 */
/**
 * Rate-limit bucket for /login: the identifier being tried, hashed, so a
 * shared carrier address is not one 10/min budget for a whole neighbourhood.
 * A brute-force on one account still lands in one bucket. Credential
 * stuffing across many identifiers is caught by the route's IP ceiling, not
 * by this key. Falls back to the resolved ip when the body has no usable
 * identifier (the limiter runs at preValidation, so a malformed body lands
 * here rather than 400ing first).
 */
function identityRateLimitKey(scope: string, identifier: unknown, ip: string | undefined): string {
    const id = typeof identifier === 'string' ? identifier.trim().toLowerCase() : ''
    if (id) return `${scope}:${createHash('sha256').update(id).digest('hex')}`
    return rateLimitKey({ userId: null, ip })
}

export function loginRateLimitKey(input: { identifier: unknown; ip: string | undefined }): string {
    return identityRateLimitKey('login', input.identifier, input.ip)
}

/**
 * Same idea for /register, keyed on the phone being registered. Its own
 * namespace: a login attempt and a registration on the same number must not
 * spend each other's budget. 25 people hit the old per-IP 5/min in 14 hours.
 */
export function registerRateLimitKey(input: { phone: unknown; ip: string | undefined }): string {
    return identityRateLimitKey('register', input.phone, input.ip)
}

export function rateLimitKey(input: {
    userId: string | null | undefined
    ip: string | undefined
}): string {
    if (input.userId) return `user:${input.userId}`
    return `ip:${input.ip?.trim() || 'unknown'}`
}

/**
 * Pulls the bearer token out of an `authorization` header. Pure and
 * exception-free: anything that isn't exactly `Bearer <token>` (missing
 * header, wrong scheme, empty token) yields `null`.
 */
export function extractBearerToken(authorizationHeader: string | undefined | null): string | null {
    if (!authorizationHeader) return null
    const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim())
    return match?.[1] ?? null
}

/**
 * Rate-limit key for the global limiter, keyed on a *verified* user id when
 * the request carries a valid bearer token, falling back to the IP key
 * otherwise.
 *
 * `@fastify/rate-limit`'s global limiter runs at the `onRequest` hook, which
 * fires strictly before the `authenticate` preHandler/preValidation hook that
 * populates `request.user` — so `request.user` is never available here and
 * cannot be used to key by identity. Reading an unverified JWT payload isn't
 * a safe substitute either: anyone could forge an arbitrary `id` claim and
 * mint themselves an unlimited rate-limit budget, which is a straightforward
 * bypass of the whole limiter. So this function verifies the token itself.
 *
 * `verify` is expected to throw (or reject) on any invalid token — wrong
 * signature, expired, malformed — and in production is `server.jwt.verify`
 * (RS256, checked against the server's own public key). This function never
 * throws: a missing, malformed, forged, or expired token is treated exactly
 * like anonymous traffic and falls back to the IP key. An exception escaping
 * this function must never be able to fail the request it's rate-limiting.
 */
export async function verifiedUserRateLimitKey(input: {
    authorizationHeader: string | undefined | null
    verify: (token: string) => unknown | Promise<unknown>
    ip: string | undefined
}): Promise<string> {
    let userId: string | null = null
    try {
        const token = extractBearerToken(input.authorizationHeader)
        if (token) {
            const decoded = await input.verify(token)
            if (decoded && typeof decoded === 'object' && typeof (decoded as { id?: unknown }).id === 'string') {
                userId = (decoded as { id: string }).id
            }
        }
    } catch {
        // Wrong signature (forged), expired, malformed — all fall back to
        // IP-keying, same as having no token at all.
    }
    return rateLimitKey({ userId, ip: input.ip })
}
