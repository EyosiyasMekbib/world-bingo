import { describe, it, expect, vi, beforeEach } from 'vitest'

// Prisma is fully mocked; each test seeds the specific rows it needs.
vi.mock('../lib/prisma', () => ({
  default: {
    transaction: { findUnique: vi.fn() },
    paymentMethod: { findMany: vi.fn() },
    siteSetting: { findUnique: vi.fn() },
    depositVerification: { upsert: vi.fn().mockResolvedValue({}) },
  },
}))
// WalletService is dynamically imported inside the service; mock the crediting call.
vi.mock('../services/wallet.service', () => ({
  WalletService: { approveDeposit: vi.fn().mockResolvedValue({}) },
}))

import prisma from '../lib/prisma'
import { WalletService } from '../services/wallet.service'
import { DepositVerificationService } from '../services/deposit-verification.service'
import type { DepositVerifier, ParsedReceipt } from '../services/deposit-verification/types'

const CLEAN: ParsedReceipt = {
  receiverName: 'MERCHANT',
  receiverNumberMasked: '2519****1234',
  settledAmount: 500,
  totalPaid: 500,
  status: 'Completed',
  receiptNumber: 'CHQ123',
  receiptTime: null,
  payerName: 'ALEMU NEBEBE',
  payerNumberMasked: '2519****9144',
}

/** A verifier stub whose parse() returns a fixed result — no network, no real HTML. */
const stubVerifier = (parsed: ParsedReceipt | { unavailable: any }): DepositVerifier => ({
  code: 'telebirr',
  verify: vi.fn(),
  parse: vi.fn().mockReturnValue(parsed),
})

function seedConfig(over: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    deposit_auto_verify_enabled: 'true',
    deposit_auto_verify_max_amount: '1000',
    deposit_auto_verify_max_age_hours: '0',
    deposit_auto_verify_require_payer_match: 'false',
    ...over,
  }
  ;(prisma as any).siteSetting.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(defaults[where.key] !== undefined ? { value: defaults[where.key] } : null),
  )
}

function seedTx(over: Record<string, unknown> = {}) {
  ;(prisma as any).transaction.findUnique.mockResolvedValue({
    id: 'tx1',
    status: 'PENDING_REVIEW',
    paymentTransactionId: 'CHQ123',
    amount: 500,
    senderName: null,
    note: 'telebirr',
    ...over,
  })
}

function seedAccounts() {
  ;(prisma as any).paymentMethod.findMany.mockResolvedValue([
    { merchantName: 'MERCHANT', merchantAccount: '251900001234' },
  ])
}

describe('DepositVerificationService.verifyFromHtml', () => {
  beforeEach(() => vi.clearAllMocks())

  it('clean match + enabled + within cap → auto-credits', async () => {
    seedConfig()
    seedTx()
    seedAccounts()
    const res = await DepositVerificationService.verifyFromHtml('tx1', '<html/>', {
      verifier: stubVerifier(CLEAN),
    })
    expect(res.status).toBe('AUTO_CREDITED')
    expect(WalletService.approveDeposit).toHaveBeenCalledWith('tx1', 500)
    expect(res.parsed?.receiptNumber).toBe('CHQ123')
  })

  it('clean match but auto-verify disabled → verdict shown, NO credit (shadow)', async () => {
    seedConfig({ deposit_auto_verify_enabled: 'false' })
    seedTx()
    seedAccounts()
    const res = await DepositVerificationService.verifyFromHtml('tx1', '<html/>', {
      verifier: stubVerifier(CLEAN),
    })
    expect(res.status).toBe('MANUAL_REQUIRED')
    expect(res.reasons).toContain('CLEAN_MATCH')
    expect(WalletService.approveDeposit).not.toHaveBeenCalled()
  })

  it('clean match but over cap → manual, no credit', async () => {
    seedConfig({ deposit_auto_verify_max_amount: '100' })
    seedTx()
    seedAccounts()
    const res = await DepositVerificationService.verifyFromHtml('tx1', '<html/>', {
      verifier: stubVerifier(CLEAN),
    })
    expect(res.status).toBe('MANUAL_REQUIRED')
    expect(res.reasons).toContain('OVER_CAP')
    expect(WalletService.approveDeposit).not.toHaveBeenCalled()
  })

  it('amount mismatch → manual with reason', async () => {
    seedConfig()
    seedTx({ amount: 999 })
    seedAccounts()
    const res = await DepositVerificationService.verifyFromHtml('tx1', '<html/>', {
      verifier: stubVerifier(CLEAN),
    })
    expect(res.status).toBe('MANUAL_REQUIRED')
    expect(res.reasons).toContain('AMOUNT_MISMATCH')
    expect(WalletService.approveDeposit).not.toHaveBeenCalled()
  })

  it('unparseable HTML → unavailable', async () => {
    seedConfig()
    seedTx()
    seedAccounts()
    const res = await DepositVerificationService.verifyFromHtml('tx1', 'garbage', {
      verifier: stubVerifier({ unavailable: 'PARSE_FAILED' }),
    })
    expect(res.status).toBe('UNAVAILABLE')
    expect(res.reasons).toContain('PARSE_FAILED')
  })

  it('transaction not pending → no-op', async () => {
    seedConfig()
    seedTx({ status: 'COMPLETED' })
    const res = await DepositVerificationService.verifyFromHtml('tx1', '<html/>', {
      verifier: stubVerifier(CLEAN),
    })
    expect(res.status).toBe('PENDING')
    expect(res.reasons).toContain('NOT_PENDING')
  })
})
