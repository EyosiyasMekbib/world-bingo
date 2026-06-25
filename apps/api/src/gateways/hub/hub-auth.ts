import crypto from 'node:crypto'

/** HMAC-SHA256 hex digest of the raw request body. */
export function signBody(secret: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
}

/** Timing-safe verification. Never throws — returns false on any malformed input. */
export function verifySignature(secret: string, rawBody: string, received: string): boolean {
  const expected = signBody(secret, rawBody)
  // Compare fixed-length hex digests via HMAC-of-input to avoid length leaks / parse errors.
  const key = Buffer.alloc(32)
  const a = crypto.createHmac('sha256', key).update(expected).digest()
  const b = crypto.createHmac('sha256', key).update(received ?? '').digest()
  return crypto.timingSafeEqual(a, b)
}

export const DEPLOYMENT_HEADER = 'x-deployment'
export const SIGNATURE_HEADER = 'x-signature'
