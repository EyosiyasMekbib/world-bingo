import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { verifyWebhookSignature } from '../gateways/payment/zarecash/signature'

const SECRET = 'whsec_test'
const BODY = '{"id":"evt_1","type":"deposit.approved","created":1785840764,"data":{"id":"dp_1"}}'

function sign(t: number, body = BODY, secret = SECRET): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

describe('verifyWebhookSignature', () => {
  const now = 1785840764_000

  it('accepts a correctly signed body', () => {
    const header = sign(1785840764)
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header, nowMs: now })).toBe(true)
  })

  it('rejects a body that was altered after signing', () => {
    const header = sign(1785840764)
    const tampered = BODY.replace('dp_1', 'dp_2')
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: tampered, header, nowMs: now })).toBe(
      false,
    )
  })

  it('rejects the wrong secret', () => {
    const header = sign(1785840764, BODY, 'whsec_other')
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header, nowMs: now })).toBe(
      false,
    )
  })

  it('rejects a timestamp older than the tolerance', () => {
    const stale = 1785840764 - 301
    expect(
      verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header: sign(stale), nowMs: now }),
    ).toBe(false)
  })

  it('rejects a timestamp too far in the future', () => {
    const ahead = 1785840764 + 301
    expect(
      verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header: sign(ahead), nowMs: now }),
    ).toBe(false)
  })

  it('accepts a timestamp inside the tolerance', () => {
    const recent = 1785840764 - 299
    expect(
      verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header: sign(recent), nowMs: now }),
    ).toBe(true)
  })

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['missing v1', 't=1785840764'],
    ['missing t', 'v1=abc'],
    ['non-numeric t', 't=abc,v1=deadbeef'],
    ['v1 not hex', 't=1785840764,v1=zzzz'],
  ])('rejects a malformed header (%s)', (_label, header) => {
    expect(
      verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header: header as any, nowMs: now }),
    ).toBe(false)
  })

  it('rejects when no secret is configured', () => {
    expect(
      verifyWebhookSignature({ secret: '', rawBody: BODY, header: sign(1785840764), nowMs: now }),
    ).toBe(false)
  })
})
