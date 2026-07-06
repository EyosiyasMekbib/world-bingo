import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TelebirrReceiptVerifier } from '../gateways/payment/telebirr-receipt.verifier'
import { getVerifier } from '../services/deposit-verification/registry'
import { isUnavailable } from '../services/deposit-verification/types'

const completed = readFileSync(join(__dirname, 'fixtures', 'telebirr-receipt-completed.html'), 'utf8')

describe('TelebirrReceiptVerifier', () => {
  it('fetches + parses into a ParsedReceipt', async () => {
    const v = new TelebirrReceiptVerifier(async () => ({ ok: true, html: completed }))
    const r = await v.verify('DG61L089CL')
    expect(isUnavailable(r)).toBe(false)
    if (isUnavailable(r)) return
    expect(r.receiptNumber).toBe('DG61L089CL')
  })
  it('propagates a fetch RATE_LIMITED as unavailable', async () => {
    const v = new TelebirrReceiptVerifier(async () => ({ ok: false, reason: 'RATE_LIMITED' }))
    const r = await v.verify('DG61L089CL')
    expect(isUnavailable(r) && r.unavailable).toBe('RATE_LIMITED')
  })
})

describe('getVerifier', () => {
  it('resolves telebirr by common method codes, null otherwise', () => {
    expect(getVerifier('telebirr')?.code).toBe('telebirr')
    expect(getVerifier('TELEBIRR')?.code).toBe('telebirr')
    expect(getVerifier('cbe')).toBeNull()
    expect(getVerifier(null)).toBeNull()
  })
})
