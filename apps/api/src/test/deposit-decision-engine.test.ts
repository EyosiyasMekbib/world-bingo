import { describe, it, expect } from 'vitest'
import { evaluate } from '../services/deposit-verification/decision-engine'
import type { ParsedReceipt, ExpectedDeposit, VerifyConfig } from '../services/deposit-verification/types'

const receipt = (over: Partial<ParsedReceipt> = {}): ParsedReceipt => ({
  receiverName: 'Test Merchant Account',
  receiverNumberMasked: '2519****2107',
  settledAmount: 500,
  totalPaid: 502,
  status: 'Completed',
  receiptNumber: 'DG61L089CL',
  receiptTime: new Date('2026-07-06T10:43:19'),
  payerName: 'Natan Test Payer',
  payerNumberMasked: '2519****2528',
  ...over,
})

const expected = (over: Partial<ExpectedDeposit> = {}): ExpectedDeposit => ({
  statedAmount: 500,
  paymentTransactionId: 'DG61L089CL',
  activeAccounts: [{ name: 'Test Merchant Account', account: '251912342107' }],
  ...over,
})

const config = (over: Partial<VerifyConfig> = {}): VerifyConfig => ({
  maxAutoAmount: 5000,
  maxAgeHours: 0,
  requirePayerMatch: false,
  now: new Date('2026-07-06T11:00:00'),
  ...over,
})

describe('evaluate', () => {
  it('AUTO_CREDIT on a clean match under cap', () => {
    const d = evaluate(receipt(), expected(), config())
    expect(d.decision).toBe('AUTO_CREDIT')
    expect(d.creditAmount).toBe(500)
    expect(d.reasons).toEqual(['CLEAN_MATCH'])
  })

  it('MANUAL on amount mismatch', () => {
    const d = evaluate(receipt({ settledAmount: 450 }), expected(), config())
    expect(d.decision).toBe('MANUAL')
    expect(d.reasons).toContain('AMOUNT_MISMATCH')
  })

  it('MANUAL when receiver is not one of our active accounts', () => {
    const d = evaluate(
      receipt({ receiverName: 'Someone Else', receiverNumberMasked: '2519****9999' }),
      expected(),
      config(),
    )
    expect(d.decision).toBe('MANUAL')
    expect(d.reasons).toContain('RECEIVER_MISMATCH')
  })

  it('MANUAL when status is not a success', () => {
    const d = evaluate(receipt({ status: 'Pending' }), expected(), config())
    expect(d.reasons).toContain('BAD_STATUS')
  })

  it('MANUAL over the cap even when everything matches', () => {
    const d = evaluate(receipt({ settledAmount: 9000 }), expected({ statedAmount: 9000 }), config())
    expect(d.decision).toBe('MANUAL')
    expect(d.reasons).toContain('OVER_CAP')
  })

  it('MANUAL when the receipt number does not match the looked-up id', () => {
    const d = evaluate(receipt({ receiptNumber: 'OTHER123' }), expected(), config())
    expect(d.reasons).toContain('ID_MISMATCH')
  })

  it('MANUAL when receipt is older than the freshness window', () => {
    const d = evaluate(
      receipt({ receiptTime: new Date('2026-07-01T10:00:00') }),
      expected(),
      config({ maxAgeHours: 24 }),
    )
    expect(d.reasons).toContain('STALE_RECEIPT')
  })

  it('MANUAL when payer match required but payer name is absent', () => {
    const d = evaluate(receipt({ payerName: null }), expected(), config({ requirePayerMatch: true }))
    expect(d.reasons).toContain('PAYER_MISMATCH')
  })
})
