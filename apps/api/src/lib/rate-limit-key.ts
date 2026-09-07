/**
 * Rate-limit bucket for one request.
 *
 * Keyed by user id whenever the caller is authenticated, because Ethiopian
 * carriers put thousands of players behind a handful of NAT addresses — a
 * per-IP budget makes one busy player throttle a whole neighbourhood, and a
 * 429 on a refresh used to read as "logged out".
 *
 * Anonymous traffic still keys on the client IP, taking the first hop of
 * x-forwarded-for (the proxy appends, so the client is first).
 */
export function rateLimitKey(input: {
    userId: string | null | undefined
    forwardedFor: string | undefined
    ip: string | undefined
}): string {
    if (input.userId) return `user:${input.userId}`
    const hop = input.forwardedFor?.split(',')[0]?.trim()
    return `ip:${hop || input.ip?.trim() || 'unknown'}`
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
    forwardedFor: string | undefined
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
    return rateLimitKey({ userId, forwardedFor: input.forwardedFor, ip: input.ip })
}
