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

/**
 * The exact string Atlas-V hashes: sha1(REQUEST_BODY + PRIVATE_KEY + timestamp),
 * where REQUEST_BODY is the JSON body with BOTH `hash` and `timestamp` removed
 * — confirmed against Atlas-V's real staging test tool across /account, /bet,
 * and /rollback (three independent request/hash pairs, same result each
 * time): `timestamp` is appended once, raw, at the end — never serialized
 * inside the JSON. See docs/superpowers/specs/2026-09-09-atlasv-integration-design.md,
 * "Signature (inbound)" — this was a documented assumption there and got it
 * wrong (it left `timestamp` inside the JSON); this is the verified formula.
 */
function canonicalHashInput(bodyWithoutHash: Record<string, unknown>, timestamp: string, privateKey: string): string {
    const { timestamp: _timestamp, ...rest } = bodyWithoutHash
    return JSON.stringify(rest) + privateKey + timestamp
}

/** Attaches `timestamp` and `hash` to an outbound Atlas-V request body. */
export function signAtlasVBody<T extends Record<string, unknown>>(
    body: T,
): T & { timestamp: string; hash: string } {
    const timestamp = String(Date.now())
    const hash = sha1Hex(canonicalHashInput(body, timestamp, getPrivateKey()))
    return { ...body, timestamp, hash }
}

/**
 * Verifies an inbound Atlas-V callback body (the parsed JSON, still
 * containing `hash`). See canonicalHashInput for the confirmed formula.
 */
export function verifyAtlasVBody(body: Record<string, unknown>): boolean {
    const privateKey = getPrivateKey()
    if (!privateKey) return false
    const { hash, ...rest } = body
    const timestamp = rest.timestamp
    if (typeof hash !== 'string' || typeof timestamp !== 'string') return false
    const expected = sha1Hex(canonicalHashInput(rest, timestamp, privateKey))
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
    const expected = timestamp ? sha1Hex(canonicalHashInput(rest, timestamp, getPrivateKey())) : ''
    return { expected, received: typeof hash === 'string' ? hash : null, timestamp }
}
