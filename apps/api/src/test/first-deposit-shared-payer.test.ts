import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import { WalletService } from '../services/wallet.service'
import { PayerIdentityService, FIRST_DEPOSIT_PAYER_LOCK_CLASSID } from '../services/payer-identity.service'
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

/** The lock key an approval for a first deposit paid from 0911222333 takes. */
const SENDER_LOCK_KEY = 'sender_account:911222333'

/** Takes and immediately releases (autocommit) the paying-account lock; false while another transaction holds it. */
async function tryPayerLock(key: string): Promise<boolean> {
    const [row] = await prisma.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${FIRST_DEPOSIT_PAYER_LOCK_CLASSID}::int, hashtext(${key})) AS locked
    `
    return row.locked
}

async function expectCreditedWithIncentivesWithheld(userId: string): Promise<void> {
    const deposit = await prisma.transaction.findFirstOrThrow({ where: { userId, type: TransactionType.DEPOSIT } })
    expect(deposit.status).toBe(PaymentStatus.APPROVED)
    expect(Number(deposit.balanceBefore)).toBe(0)
    expect(Number(deposit.balanceAfter)).toBe(200)

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } })
    expect(Number(wallet.realBalance)).toBe(200)
    expect(Number(wallet.bonusBalance)).toBe(0)
    expect(await firstDepositBonuses(userId)).toBe(0)
    expect(await prisma.referralReward.count({ where: { refereeId: userId } })).toBe(0)
}

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
            await expectCreditedWithIncentivesWithheld(b)
            expect(captureEvent.mock.calls.some(([, event]) => event === 'first_deposit_shared_payer')).toBe(false)
            expect(JSON.stringify(logged.mock.calls)).not.toContain('955666777')
        } finally {
            lookup.mockRestore()
            logged.mockRestore()
        }
    })
})

describe('approveDeposit — paying-account lock for concurrent first deposits', () => {
    beforeEach(async () => {
        await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '100' } })
    })

    afterEach(async () => {
        await expectInvariantClean()
    })

    it('derives one signal-prefixed lock key per paying-account signal, sorted, and none without a signal', async () => {
        const a = await player()
        const both = await WalletService.initiateDeposit(a, { amount: 200, senderAccount: '+251 911-222-333' })
        await prisma.depositVerification.create({
            data: {
                transactionId: both.id,
                status: 'MANUAL_REQUIRED',
                decisionReasons: [],
                payerNumberMasked: ' 2519 **** 2528 ',
                payerName: 'Abebe Kebede',
            },
        })
        const neither = await WalletService.initiateDeposit(a, { amount: 200 })

        const keys = await prisma.$transaction((tx) =>
            Promise.all([
                PayerIdentityService.firstDepositLockKeys(tx, both.id),
                PayerIdentityService.firstDepositLockKeys(tx, neither.id),
            ]),
        )
        expect(keys).toEqual([['receipt_payer:2519****2528', SENDER_LOCK_KEY], []])
    })

    it('waits while another transaction holds its paying-account lock, then credits the deposit', async () => {
        const b = await player()
        const deposit = await WalletService.initiateDeposit(b, { amount: 200, senderAccount: '0911222333' })

        let releaseHolder!: () => void
        const barrier = new Promise<void>((resolve) => {
            releaseHolder = resolve
        })
        let lockTaken!: () => void
        const taken = new Promise<void>((resolve) => {
            lockTaken = resolve
        })
        const holder = prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_DEPOSIT_PAYER_LOCK_CLASSID}::int, hashtext(${SENDER_LOCK_KEY}))`
                lockTaken()
                await barrier
            },
            { timeout: 10_000 },
        )
        await taken

        let settled = false
        const approval = WalletService.approveDeposit(deposit.id).finally(() => {
            settled = true
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
        const settledWhileLockHeld = settled

        releaseHolder()
        await holder
        await approval

        expect(settledWhileLockHeld).toBe(false)
        const credited = await prisma.transaction.findUniqueOrThrow({ where: { id: deposit.id } })
        expect(credited.status).toBe(PaymentStatus.APPROVED)
        expect(Number(credited.balanceBefore)).toBe(0)
        expect(Number(credited.balanceAfter)).toBe(200)
        const walletB = await prisma.wallet.findUniqueOrThrow({ where: { userId: b } })
        expect(Number(walletB.realBalance)).toBe(200)
        expect(await firstDepositBonuses(b)).toBe(1)
    })

    it('holds its paying-account lock through the shared-payer lookup until the approval commits', async () => {
        const b = await player()
        const deposit = await WalletService.initiateDeposit(b, { amount: 200, senderAccount: '0911222333' })

        let releaseLookup!: () => void
        const barrier = new Promise<void>((resolve) => {
            releaseLookup = resolve
        })
        let enteredLookup!: () => void
        const entered = new Promise<void>((resolve) => {
            enteredLookup = resolve
        })
        const realLookup = PayerIdentityService.findPriorFirstDepositByPayer.bind(PayerIdentityService)
        const lookup = vi
            .spyOn(PayerIdentityService, 'findPriorFirstDepositByPayer')
            .mockImplementationOnce(async (tx, input) => {
                enteredLookup()
                await barrier
                return realLookup(tx, input)
            })
        try {
            const approval = WalletService.approveDeposit(deposit.id)
            await entered
            const heldDuringLookup = !(await tryPayerLock(SENDER_LOCK_KEY))
            releaseLookup()
            await approval

            expect(heldDuringLookup).toBe(true)
            expect(await tryPayerLock(SENDER_LOCK_KEY)).toBe(true)
        } finally {
            releaseLookup()
            lookup.mockRestore()
        }
    })

    it('pays first-deposit incentives once when two accounts sharing a paying account are approved at the same time', async () => {
        const referrer = await player()
        const a = await player(referrer)
        const b = await player(referrer)
        const depositA = await WalletService.initiateDeposit(a, { amount: 200, senderAccount: '0911222333' })
        const depositB = await WalletService.initiateDeposit(b, { amount: 200, senderAccount: '+251911222333' })

        await Promise.all([WalletService.approveDeposit(depositA.id), WalletService.approveDeposit(depositB.id)])

        expect(await prisma.transaction.count({ where: { type: TransactionType.FIRST_DEPOSIT_BONUS } })).toBe(1)
        expect(await prisma.referralReward.count()).toBeLessThanOrEqual(1)
        for (const userId of [a, b]) {
            const deposit = await prisma.transaction.findFirstOrThrow({ where: { userId, type: TransactionType.DEPOSIT } })
            expect(deposit.status).toBe(PaymentStatus.APPROVED)
            expect(Number(deposit.balanceBefore)).toBe(0)
            expect(Number(deposit.balanceAfter)).toBe(200)
            const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } })
            expect(Number(wallet.realBalance)).toBe(200)
        }
    })

    it('still credits the deposit but withholds both incentives when taking the paying-account lock fails', async () => {
        captureEvent.mockClear()
        const referrer = await player()
        const b = await player(referrer)
        const lockKeys = vi
            .spyOn(PayerIdentityService, 'firstDepositLockKeys')
            .mockImplementationOnce(async (tx) => {
                // A real statement error: Postgres aborts the enclosing transaction.
                await tx.$queryRaw`SELECT 1 / 0`
                return []
            })
        const lookup = vi.spyOn(PayerIdentityService, 'findPriorFirstDepositByPayer')
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            await approvedDeposit(b, 200, { senderAccount: '0955666777' })

            expect(lockKeys).toHaveBeenCalledTimes(1)
            expect(lookup).not.toHaveBeenCalled()
            await expectCreditedWithIncentivesWithheld(b)
            expect(captureEvent.mock.calls.some(([, event]) => event === 'first_deposit_shared_payer')).toBe(false)
            expect(JSON.stringify(logged.mock.calls)).not.toContain('955666777')
        } finally {
            lockKeys.mockRestore()
            lookup.mockRestore()
            logged.mockRestore()
        }
    })
})
