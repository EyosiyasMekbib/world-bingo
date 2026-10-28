import crypto from 'node:crypto'

/**
 * IGCORE signs every callback with X-Security-Hash: lowercase hex HMAC-SHA256
 * of the raw request body bytes, keyed with the shared secret. The same
 * function signs the staging simulator's callbacks.
 */
export function signIgcoreBody(raw: Buffer | string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(raw).digest('hex')
}

/**
 * Verifies X-Security-Hash over the raw body bytes exactly as received. Never
 * pass a re-serialised body: whitespace, key order and number formatting all
 * change the digest. False when the secret is empty (an unconfigured secret
 * must not validate anything), the header is missing, or the lengths differ.
 */
export function verifyIgcoreSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
    if (!secret || !header) return false
    const expected = Buffer.from(signIgcoreBody(raw, secret), 'utf8')
    const received = Buffer.from(header, 'utf8')
    if (received.length !== expected.length) return false
    return crypto.timingSafeEqual(received, expected)
}
