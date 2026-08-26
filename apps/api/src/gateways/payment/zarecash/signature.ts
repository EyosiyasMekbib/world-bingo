/**
 * ZareCash webhook signature.
 *
 * Header: pmv2-signature: t=<unix>,v1=<hex hmac-sha256("<t>.<raw body>")>
 *
 * The HMAC MUST be computed over the raw request bytes. A re-serialised object
 * will not match — key order and number formatting both differ.
 */

import crypto from 'node:crypto'

export const SIGNATURE_HEADER = 'pmv2-signature'
export const EVENT_TYPE_HEADER = 'pmv2-event-type'
const DEFAULT_TOLERANCE_SECONDS = 300

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

export function verifyWebhookSignature(opts: {
  secret: string
  rawBody: string
  header: string | undefined
  toleranceSeconds?: number
  nowMs?: number
}): boolean {
  const { secret, rawBody, header } = opts
  if (!secret || !header) return false

  const parts = new Map<string, string>()
  for (const segment of header.split(',')) {
    const idx = segment.indexOf('=')
    if (idx === -1) continue
    parts.set(segment.slice(0, idx).trim(), segment.slice(idx + 1).trim())
  }

  const rawT = parts.get('t')
  const received = parts.get('v1')
  if (!rawT || !received) return false

  const t = Number.parseInt(rawT, 10)
  if (!Number.isFinite(t)) return false

  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  const nowSeconds = (opts.nowMs ?? Date.now()) / 1000
  if (Math.abs(nowSeconds - t) > tolerance) return false

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return timingSafeHexEqual(expected, received)
}
