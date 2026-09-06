import { describe, it, expect, vi, beforeEach } from 'vitest'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))
const { emitDepositApproved } = vi.hoisted(() => ({ emitDepositApproved: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog-events', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/posthog-events')>()
    return { ...actual, emitDepositApproved }
})

import { WalletService } from '../services/wallet.service'
import { AdminService } from '../services/admin.service'
import { prisma } from './setup'
import { PaymentStatus } from '@world-bingo/shared-types'

let userId: string

beforeEach(async () => {
    vi.clearAllMocks()
    const user = await prisma.user.create({
        data: {
            username: 'ph_wallet',
            phone: '+251977000010',
            passwordHash: 'hashed:pw',
            wallet: { create: { realBalance: 1000 } },
        },
    })
    userId = user.id
})

describe('deposit hooks', () => {
    it('initiateDeposit emits deposit_submitted for the manual gateway', async () => {
        const tx = await WalletService.initiateDeposit(userId, {
            amount: 300,
            transactionId: 'PH-DEP-1',
            methodCode: 'telebirr',
        } as any)
        expect(captureEvent).toHaveBeenCalledWith(userId, 'deposit_submitted', {
            amount: 300,
            method: 'telebirr',
            gateway: 'manual',
            tx_id: tx.id,
        })
    })

    it('approveDeposit hands the committed id to emitDepositApproved', async () => {
        const tx = await WalletService.initiateDeposit(userId, {
            amount: 300,
            transactionId: 'PH-DEP-2',
            methodCode: 'telebirr',
        } as any)
        await WalletService.approveDeposit(tx.id)
        expect(emitDepositApproved).toHaveBeenCalledWith(tx.id)
    })

    it('approveDeposit emits bonus_granted for a first-deposit bonus', async () => {
        await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '50' } })
        const tx = await WalletService.initiateDeposit(userId, {
            amount: 300,
            transactionId: 'PH-DEP-3',
            methodCode: 'telebirr',
        } as any)
        await WalletService.approveDeposit(tx.id)
        expect(captureEvent).toHaveBeenCalledWith(userId, 'bonus_granted', {
            amount: 50,
            source: 'FIRST_DEPOSIT',
            rule_id: null,
        })
    })

    it('reviewTransaction REJECTED emits deposit_rejected with the method, not the note', async () => {
        const tx = await WalletService.initiateDeposit(userId, {
            amount: 300,
            transactionId: 'PH-DEP-4',
            methodCode: 'cbe',
        } as any)
        captureEvent.mockClear()
        await AdminService.reviewTransaction(tx.id, PaymentStatus.REJECTED, 'blurry receipt')
        expect(captureEvent).toHaveBeenCalledWith(userId, 'deposit_rejected', {
            amount: 300,
            method: 'cbe',
            hours_to_decision: expect.any(Number),
            has_note: true,
            tx_id: tx.id,
        })
    })
})

describe('withdrawal hooks', () => {
    it('requestWithdrawal emits withdrawal_requested without the account number', async () => {
        const tx = await WalletService.requestWithdrawal(userId, {
            amount: 200,
            paymentMethod: 'telebirr',
            accountNumber: '0911000000',
        })
        expect(captureEvent).toHaveBeenCalledWith(userId, 'withdrawal_requested', {
            amount: 200,
            method: 'telebirr',
            gateway: 'manual',
            tx_id: tx.id,
        })
        expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('0911000000')
    })

    it('rejectWithdrawal emits withdrawal_rejected', async () => {
        const tx = await WalletService.requestWithdrawal(userId, {
            amount: 200,
            paymentMethod: 'telebirr',
            accountNumber: '0911000000',
        })
        captureEvent.mockClear()
        await WalletService.rejectWithdrawal(tx.id, 'name mismatch')
        expect(captureEvent).toHaveBeenCalledWith(userId, 'withdrawal_rejected', {
            amount: 200,
            method: 'telebirr',
            hours_to_decision: expect.any(Number),
            tx_id: tx.id,
        })
    })

    it('reviewTransaction APPROVED emits withdrawal_approved', async () => {
        const tx = await WalletService.requestWithdrawal(userId, {
            amount: 200,
            paymentMethod: 'cbe',
            accountNumber: '1000123456',
        })
        captureEvent.mockClear()
        await AdminService.reviewTransaction(tx.id, PaymentStatus.APPROVED, 'paid')
        expect(captureEvent).toHaveBeenCalledWith(userId, 'withdrawal_approved', {
            amount: 200,
            method: 'cbe',
            gateway: 'manual',
            hours_to_decision: expect.any(Number),
            tx_id: tx.id,
        })
    })
})
