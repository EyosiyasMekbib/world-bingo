import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    transaction: { findUnique: vi.fn() },
    paymentMethod: { findMany: vi.fn() },
    siteSetting: { findUnique: vi.fn() },
    depositVerification: { upsert: vi.fn() },
  },
}))
vi.mock('../services/wallet.service', () => ({
  WalletService: { approveDeposit: vi.fn() },
}))
vi.mock('../lib/queue', () => ({
  QUEUE_NAMES: { DEPOSIT_VERIFICATION: 'deposit-verification' },
  getQueue: () => ({ add: vi.fn() }),
}))

import prisma from '../lib/prisma'
import { WalletService } from '../services/wallet.service'
import { DepositVerificationService, RateLimitSignal } from '../services/deposit-verification.service'
import { TelebirrReceiptVerifier } from '../gateways/payment/telebirr-receipt.verifier'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const completed = readFileSync(join(__dirname, 'fixtures', 'telebirr-receipt-completed.html'), 'utf8')

const setSettings = (m: Record<string, string>) => {
  ;(prisma as any).siteSetting.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(m[where.key] !== undefined ? { key: where.key, value: m[where.key] } : null),
  )
}

describe('DepositVerificationService.runVerification', () => {
  beforeEach(() => vi.clearAllMocks())

  it('auto-credits a clean match under cap', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue({
      id: 'tx1',
      amount: 500,
      note: 'telebirr',
      paymentTransactionId: 'DG61L089CL',
      senderName: 'Natan Test Payer',
      status: 'PENDING_REVIEW',
    })
    ;(prisma as any).paymentMethod.findMany.mockResolvedValue([
      { merchantName: 'Test Merchant Account', merchantAccount: '251912342107' },
    ])
    setSettings({ deposit_auto_verify_enabled: 'true', deposit_auto_verify_max_amount: '5000' })
    ;(prisma as any).depositVerification.upsert.mockResolvedValue({})

    const verifier = new TelebirrReceiptVerifier(async () => ({ ok: true, html: completed }))
    const out = await DepositVerificationService.runVerification('tx1', { verifier })

    expect(WalletService.approveDeposit).toHaveBeenCalledWith('tx1', 500)
    expect(out.status).toBe('AUTO_CREDITED')
  })

  it('leaves manual on amount mismatch and does NOT credit', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue({
      id: 'tx1',
      amount: 999,
      note: 'telebirr',
      paymentTransactionId: 'DG61L089CL',
      senderName: 'x',
      status: 'PENDING_REVIEW',
    })
    ;(prisma as any).paymentMethod.findMany.mockResolvedValue([
      { merchantName: 'Test Merchant Account', merchantAccount: '251912342107' },
    ])
    setSettings({ deposit_auto_verify_enabled: 'true', deposit_auto_verify_max_amount: '5000' })
    ;(prisma as any).depositVerification.upsert.mockResolvedValue({})

    const verifier = new TelebirrReceiptVerifier(async () => ({ ok: true, html: completed }))
    const out = await DepositVerificationService.runVerification('tx1', { verifier })

    expect(WalletService.approveDeposit).not.toHaveBeenCalled()
    expect(out.status).toBe('MANUAL_REQUIRED')
    expect(out.reasons).toContain('AMOUNT_MISMATCH')
  })

  it('throws RateLimitSignal when the verifier is rate limited', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue({
      id: 'tx1',
      amount: 500,
      note: 'telebirr',
      paymentTransactionId: 'DG61L089CL',
      senderName: 'x',
      status: 'PENDING_REVIEW',
    })
    ;(prisma as any).paymentMethod.findMany.mockResolvedValue([])
    setSettings({ deposit_auto_verify_enabled: 'true', deposit_auto_verify_max_amount: '5000' })
    ;(prisma as any).depositVerification.upsert.mockResolvedValue({})

    const verifier = new TelebirrReceiptVerifier(async () => ({ ok: false, reason: 'RATE_LIMITED' }))
    await expect(DepositVerificationService.runVerification('tx1', { verifier })).rejects.toBeInstanceOf(RateLimitSignal)
  })

  it('no-ops when the feature flag is off', async () => {
    setSettings({ deposit_auto_verify_enabled: 'false' })
    const out = await DepositVerificationService.runVerification('tx1', {})
    expect(prisma.transaction.findUnique).not.toHaveBeenCalled()
    expect(out.status).toBe('PENDING')
  })
})
