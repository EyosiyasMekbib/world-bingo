import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import { WalletService } from '../services/wallet.service'
import { PayerIdentityService } from '../services/payer-identity.service'
import { prisma, expectInvariantClean } from './setup'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'

let seq = 0
async function player(referredById?: string): Promise<string> {
    seq++
    const user = await prisma.user.create({
        data: {
            username: `farm-${seq}`,
            phone: `+2519400000${String(seq).padStart(2, '0')}`,
            passwordHash: 'x',
            referredById,
            wallet: { create: { realBalance: 0 } },
        },
    })
    return user.id
}

async function approvedDeposit(
    userId: string,
    amount: number,
    payer: { senderAccount?: string; payerNumberMasked?: string; payerName?: string },
): Promise<void> {
    const deposit = await WalletService.initiateDeposit(userId, { amount, senderAccount: payer.senderAccount })
    if (payer.payerNumberMasked) {
        await prisma.depositVerification.create({
            data: {
                transactionId: deposit.id,
                status: 'MANUAL_REQUIRED',
                decisionReasons: [],
                payerNumberMasked: payer.payerNumberMasked,
                payerName: payer.payerName,
            },
        })
    }
    await WalletService.approveDeposit(deposit.id)
}

const firstDepositBonuses = (userId: string) =>
    prisma.transaction.count({ where: { userId, type: TransactionType.FIRST_DEPOSIT_BONUS } })

describe('approveDeposit — shared paying account guard', () => {
    beforeEach(async () => {
        await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '100' } })
    })

    afterEach(async () => {
        await expectInvariantClean()
    })

    it("skips the first-deposit bonus when the paying account already funded another account's first deposit", async () => {
        const a = await player()
        const b = await player()
        await approvedDeposit(a, 200, { senderAccount: '0911222333' })
        await approvedDeposit(b, 200, { senderAccount: '+251911222333' })

        const walletB = await prisma.wallet.findUniqueOrThrow({ where: { userId: b } })
        expect(Number(walletB.realBalance)).toBe(200)
        expect(Number(walletB.bonusBalance)).toBe(0)
        expect(await firstDepositBonuses(b)).toBe(0)
        expect(await firstDepositBonuses(a)).toBe(1)
    })

    it('still grants the bonus when the paying account is new', async () => {
        const a = await player()
        const b = await player()
        await approvedDeposit(a, 200, { senderAccount: '0911222333' })
        await approvedDeposit(b, 200, { senderAccount: '0955666777' })
        expect(await firstDepositBonuses(b)).toBe(1)
    })

    it('skips the bonus when the parsed receipt payer matches', async () => {
        const a = await player()
        const b = await player()
        await approvedDeposit(a, 200, { payerNumberMasked: '2519****2528', payerName: 'Abebe Kebede' })
        await approvedDeposit(b, 200, { payerNumberMasked: '2519****2528', payerName: 'ABEBE KEBEDE' })
        expect(await firstDepositBonuses(b)).toBe(0)
    })

    it('does not pay the referral reward when the paying account is shared', async () => {
        const referrer = await player()
        const a = await player()
        const b = await player(referrer)
        await approvedDeposit(a, 200, { senderAccount: '0911222333' })
        await approvedDeposit(b, 200, { senderAccount: '0911222333' })
        expect(await prisma.referralReward.count({ where: { refereeId: b } })).toBe(0)
    })

    it('still pays the referral reward when the paying account is new', async () => {
        const referrer = await player()
        const b = await player(referrer)
        await approvedDeposit(b, 200, { senderAccount: '0955666777' })
        expect(await prisma.referralReward.count({ where: { refereeId: b } })).toBe(1)
    })

    it('reports a shared payer post-commit with no paying account in the event or the warning', async () => {
        captureEvent.mockClear()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const a = await player()
            const b = await player()
            await approvedDeposit(a, 200, { senderAccount: '0911222333' })
            await approvedDeposit(b, 200, { senderAccount: '+251911222333' })

            const shared = captureEvent.mock.calls.filter(([, event]) => event === 'first_deposit_shared_payer')
            expect(shared).toEqual([[b, 'first_deposit_shared_payer', { matched_on: 'sender_account', bonus_blocked: true }]])

            const warned = warn.mock.calls.filter(([line]) => String(line).startsWith('[WalletService] first deposit'))
            expect(warned).toHaveLength(1)
            expect(JSON.stringify(warned)).not.toContain('911222333')

            // The deposit itself is credited in full, with its ledger snapshot.
            const depositB = await prisma.transaction.findFirstOrThrow({ where: { userId: b, type: TransactionType.DEPOSIT } })
            expect(depositB.status).toBe(PaymentStatus.APPROVED)
            expect(Number(depositB.balanceBefore)).toBe(0)
            expect(Number(depositB.balanceAfter)).toBe(200)
        } finally {
            warn.mockRestore()
        }
    })

    it('still credits the deposit but withholds both incentives when the payer lookup fails', async () => {
        captureEvent.mockClear()
        const referrer = await player()
        const b = await player(referrer)
        const lookup = vi
            .spyOn(PayerIdentityService, 'findPriorFirstDepositByPayer')
            .mockImplementationOnce(async (tx) => {
                // A real statement error: Postgres aborts the enclosing transaction.
                await tx.$queryRaw`SELECT 1 / 0`
                return null
            })
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            await approvedDeposit(b, 200, { senderAccount: '0955666777' })

            expect(lookup).toHaveBeenCalledTimes(1)
            const deposit = await prisma.transaction.findFirstOrThrow({ where: { userId: b, type: TransactionType.DEPOSIT } })
            expect(deposit.status).toBe(PaymentStatus.APPROVED)
            expect(Number(deposit.balanceBefore)).toBe(0)
            expect(Number(deposit.balanceAfter)).toBe(200)

            const walletB = await prisma.wallet.findUniqueOrThrow({ where: { userId: b } })
            expect(Number(walletB.realBalance)).toBe(200)
            expect(Number(walletB.bonusBalance)).toBe(0)
            expect(await firstDepositBonuses(b)).toBe(0)
            expect(await prisma.referralReward.count({ where: { refereeId: b } })).toBe(0)
            expect(captureEvent.mock.calls.some(([, event]) => event === 'first_deposit_shared_payer')).toBe(false)
            expect(JSON.stringify(logged.mock.calls)).not.toContain('955666777')
        } finally {
            lookup.mockRestore()
            logged.mockRestore()
        }
    })
})
