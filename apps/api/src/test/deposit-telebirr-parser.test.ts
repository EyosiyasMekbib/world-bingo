import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseReceiptHtml } from '../services/deposit-verification/telebirr-parser'
import { isUnavailable } from '../services/deposit-verification/types'

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

describe('parseReceiptHtml', () => {
  it('parses a completed receipt into normalized fields', () => {
    const r = parseReceiptHtml(fx('telebirr-receipt-completed.html'))
    expect(isUnavailable(r)).toBe(false)
    if (isUnavailable(r)) return
    expect(r.receiverName).toBe('Test Merchant Account')
    expect(r.receiverNumberMasked).toBe('2519****2107')
    expect(r.settledAmount).toBe(500)
    expect(r.totalPaid).toBe(502)
    expect(r.status).toBe('Completed')
    expect(r.receiptNumber).toBe('DG61L089CL')
    expect(r.payerName).toBe('Natan Test Payer')
    expect(r.receiptTime?.getFullYear()).toBe(2026)
  })

  it('detects the not-found page', () => {
    const r = parseReceiptHtml(fx('telebirr-receipt-notfound.html'))
    expect(isUnavailable(r) && r.unavailable).toBe('NOT_FOUND')
  })

  it('returns PARSE_FAILED when required fields are absent', () => {
    const r = parseReceiptHtml(
      '<html><body><table><tr><td>Nothing</td><td>Here</td></tr></table></body></html>',
    )
    expect(isUnavailable(r) && r.unavailable).toBe('PARSE_FAILED')
  })
})
