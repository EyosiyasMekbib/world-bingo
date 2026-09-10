import crypto from 'node:crypto'

let _key: string | null = null
export function getPrivateKey(): string {
    if (!_key) {
        const k = (process.env.ATLASV_PRIVATE_KEY ?? '').trim()
        if (!k) console.warn('[Atlas-V] WARNING: ATLASV_PRIVATE_KEY is empty — all signature checks will fail')
        else _key = k
        return k
    }
    return _key
}

export function sha1Hex(input: string): string {
    return crypto.createHash('sha1').update(input).digest('hex')
}

/** Attaches `timestamp` and `hash` to an outbound Atlas-V request body. */
export function signAtlasVBody<T extends Record<string, unknown>>(
    body: T,
): T & { timestamp: string; hash: string } {
    const timestamp = String(Date.now())
    const withTimestamp = { ...body, timestamp }
    const hash = sha1Hex(JSON.stringify(withTimestamp) + getPrivateKey() + timestamp)
    return { ...withTimestamp, hash }
}

/**
 * Verifies an inbound Atlas-V callback body (the parsed JSON, still
 * containing `hash`). Per the Atlas-V API doc: hash = sha1(REQUEST_BODY +
 * PRIVATE_KEY + timestamp). REQUEST_BODY is assumed to be the JSON body with
 * `hash` itself removed, in the same key order Atlas-V sent it (preserved by
 * JSON.parse → destructure → JSON.stringify round-tripping). This is a
 * documented assumption, not a confirmed fact — see the design doc's
 * "Signature (inbound)" row and Risk #1.
 */
export function verifyAtlasVBody(body: Record<string, unknown>): boolean {
    const privateKey = getPrivateKey()
    if (!privateKey) return false
    const { hash, ...rest } = body
    const timestamp = rest.timestamp
    if (typeof hash !== 'string' || typeof timestamp !== 'string') return false
    const expected = sha1Hex(JSON.stringify(rest) + privateKey + timestamp)
    if (hash.length !== expected.length) return false
    return crypto.timingSafeEqual(Buffer.from(hash, 'utf8'), Buffer.from(expected, 'utf8'))
}

/**
 * Debug-only: exposes the expected hash and what was received, for diagnosing
 * a mismatch. Never used for the actual pass/fail decision — verifyAtlasVBody
 * is. Gated behind ATLASV_CALLBACK_DEBUG by the caller.
 */
export function debugAtlasVHash(body: Record<string, unknown>): { expected: string; received: string | null; timestamp: string | null } {
    const { hash, ...rest } = body
    const timestamp = typeof rest.timestamp === 'string' ? rest.timestamp : null
    const expected = timestamp ? sha1Hex(JSON.stringify(rest) + getPrivateKey() + timestamp) : ''
    return { expected, received: typeof hash === 'string' ? hash : null, timestamp }
}
