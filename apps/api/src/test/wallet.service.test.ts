import { describe, it, expect, beforeEach } from 'vitest'
import { WalletService } from '../services/wallet.service'
import { prisma } from './setup'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'

describe('WalletService', () => {
    let testUserId: string

    beforeEach(async () => {
        // Create a test user with wallet
        const user = await prisma.user.create({
            data: {
                username: 'wallettest',
                phone: '+251912345700',
                passwordHash: 'hashed:testpassword',
                wallet: {
                    create: {
                        realBalance: 500,
                    },
                },
            },
            include: {
                wallet: true,
            },
        })
        testUserId = user.id
    })

    describe('getBalance', () => {
        it('should return wallet balance', async () => {
            const wallet = await WalletService.getBalance(testUserId)
            
            expect(wallet.realBalance.toString()).toBe('500')
        })

        it('should throw error for non-existent user', async () => {
            await expect(
                WalletService.getBalance('non-existent-id')
            ).rejects.toThrow('Wallet not found')
        })
    })

    describe('initiateDeposit', () => {
        it('should create a pending deposit transaction', async () => {
            const depositData = {
                amount: 500,
                receiptUrl: 'https://example.com/receipt.jpg',
            }

            const transaction = await WalletService.initiateDeposit(testUserId, depositData)

            expect(transaction.type).toBe(TransactionType.DEPOSIT)
            expect(transaction.amount.toString()).toBe('500')
            expect(transaction.status).toBe(PaymentStatus.PENDING_REVIEW)
            expect(transaction.receiptUrl).toBe(depositData.receiptUrl)
        })
    })

    describe('approveDeposit', () => {
        it('should approve deposit and update wallet balance', async () => {
            // First create a deposit
            const deposit = await WalletService.initiateDeposit(testUserId, {
                amount: 500,
                receiptUrl: 'https://example.com/receipt.jpg',
            })

            // Approve the deposit
            await WalletService.approveDeposit(deposit.id)

            // Check wallet balance was updated
            const wallet = await WalletService.getBalance(testUserId)
            expect(wallet.realBalance.toString()).toBe('1000') // 500 + 500
        })

        it('should throw error for invalid transaction', async () => {
            await expect(
                WalletService.approveDeposit('invalid-id')
            ).rejects.toThrow('Invalid transaction')
        })

        it('should throw error for already approved transaction', async () => {
            const deposit = await WalletService.initiateDeposit(testUserId, {
                amount: 500,
                receiptUrl: 'https://example.com/receipt.jpg',
            })

            // First approval
            await WalletService.approveDeposit(deposit.id)

            // Second approval should fail
            await expect(
                WalletService.approveDeposit(deposit.id)
            ).rejects.toThrow('Invalid transaction')
        })
    })

    describe('requestWithdrawal', () => {
        it('should deduct balance on withdrawal request', async () => {
            const transaction = await WalletService.requestWithdrawal(testUserId, {
                amount: 100,
                paymentMethod: 'Telebirr',
                accountNumber: '0912345678',
            })

            expect(transaction.amount.toString()).toBe('100')
            expect(transaction.status).toBe(PaymentStatus.PENDING_REVIEW)
            expect(transaction.type).toBe(TransactionType.WITHDRAWAL)

            const wallet = await WalletService.getBalance(testUserId)
            expect(wallet.realBalance.toString()).toBe('400') // 500 - 100
        })

        it('should throw on insufficient balance', async () => {
            await expect(
                WalletService.requestWithdrawal(testUserId, {
                    amount: 9999,
                    paymentMethod: 'CBE',
                    accountNumber: '1234567890',
                })
            ).rejects.toThrow('Insufficient balance')
        })

        it('should record balance_before and balance_after on withdrawal', async () => {
            const transaction = await WalletService.requestWithdrawal(testUserId, {
                amount: 100,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            })

            expect(transaction.balanceBefore?.toString()).toBe('500')
            expect(transaction.balanceAfter?.toString()).toBe('400')
        })

        it('concurrent withdrawals: only one should succeed when total > balance', async () => {
            // Both requests try to withdraw 300 from a 500 balance.
            // Only one should succeed; the other should fail (300+300 > 500).
            const results = await Promise.allSettled([
                WalletService.requestWithdrawal(testUserId, {
                    amount: 300,
                    paymentMethod: 'Telebirr',
                    accountNumber: '0912345678',
                }),
                WalletService.requestWithdrawal(testUserId, {
                    amount: 300,
                    paymentMethod: 'Telebirr',
                    accountNumber: '0912345678',
                }),
            ])

            const successes = results.filter(r => r.status === 'fulfilled')
            const failures = results.filter(r => r.status === 'rejected')

            expect(successes.length).toBe(1)
            expect(failures.length).toBe(1)

            const wallet = await WalletService.getBalance(testUserId)
            // Balance should be 200 (500 - 300), not negative
            expect(Number(wallet.realBalance)).toBeGreaterThanOrEqual(0)
        })
    })

    describe('approveDeposit — first deposit bonus', () => {
        beforeEach(async () => {
            // Create the site setting that triggers first-deposit bonus
            await prisma.siteSetting.create({
                data: { key: 'first_deposit_bonus_amount', value: '100' },
            })
        })

        it('should credit bonus balance on first deposit when setting is configured', async () => {
            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 500 })
            await WalletService.approveDeposit(deposit.id)

            const wallet = await WalletService.getBalance(testUserId)
            expect(Number(wallet.realBalance)).toBe(1000)  // 500 existing + 500 deposited
            expect(Number(wallet.bonusBalance)).toBe(100)  // first deposit bonus
        })

        it('should create a FIRST_DEPOSIT_BONUS transaction', async () => {
            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 500 })
            await WalletService.approveDeposit(deposit.id)

            const bonusTx = await prisma.transaction.findFirst({
                where: { userId: testUserId, type: TransactionType.FIRST_DEPOSIT_BONUS },
            })
            expect(bonusTx).not.toBeNull()
            expect(Number(bonusTx!.amount)).toBe(100)
            expect(bonusTx!.status).toBe(PaymentStatus.APPROVED)
        })

        it('should record correct bonus balance snapshots in FIRST_DEPOSIT_BONUS transaction', async () => {
            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 200 })
            await WalletService.approveDeposit(deposit.id)

            const bonusTx = await prisma.transaction.findFirst({
                where: { userId: testUserId, type: TransactionType.FIRST_DEPOSIT_BONUS },
            })
            // bonusBefore = 0 (fresh user), bonusAfter = 100 (bonus awarded)
            expect(Number(bonusTx!.bonusBalanceBefore)).toBe(0)
            expect(Number(bonusTx!.bonusBalanceAfter)).toBe(100)
        })

        it('should NOT award bonus on second and subsequent deposits', async () => {
            // First deposit
            const d1 = await WalletService.initiateDeposit(testUserId, { amount: 200 })
            await WalletService.approveDeposit(d1.id)

            // Second deposit
            const d2 = await WalletService.initiateDeposit(testUserId, { amount: 300 })
            await WalletService.approveDeposit(d2.id)

            const bonusTxCount = await prisma.transaction.count({
                where: { userId: testUserId, type: TransactionType.FIRST_DEPOSIT_BONUS },
            })
            expect(bonusTxCount).toBe(1) // only the first deposit triggers bonus
        })

        it('should NOT award bonus when setting value is 0', async () => {
            await prisma.siteSetting.update({
                where: { key: 'first_deposit_bonus_amount' },
                data: { value: '0' },
            })

            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 500 })
            await WalletService.approveDeposit(deposit.id)

            const wallet = await WalletService.getBalance(testUserId)
            expect(Number(wallet.bonusBalance)).toBe(0)

            const bonusTxCount = await prisma.transaction.count({
                where: { userId: testUserId, type: TransactionType.FIRST_DEPOSIT_BONUS },
            })
            expect(bonusTxCount).toBe(0)
        })

        it('should NOT award bonus when setting is absent', async () => {
            await prisma.siteSetting.deleteMany()

            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 500 })
            await WalletService.approveDeposit(deposit.id)

            const wallet = await WalletService.getBalance(testUserId)
            expect(Number(wallet.bonusBalance)).toBe(0)
        })
    })

    describe('approveDeposit — concurrent approval (double-credit prevention)', () => {
        it('should only credit once if two approvals race for the same transaction', async () => {
            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 300 })

            // Fire two concurrent approvals
            const results = await Promise.allSettled([
                WalletService.approveDeposit(deposit.id),
                WalletService.approveDeposit(deposit.id),
            ])

            const successes = results.filter((r) => r.status === 'fulfilled')
            const failures = results.filter((r) => r.status === 'rejected')

            expect(successes.length).toBe(1)
            expect(failures.length).toBe(1)

            // Balance should reflect exactly one credit, not two
            const wallet = await WalletService.getBalance(testUserId)
            // Starting balance was 500, deposit was 300 → exactly 800
            expect(Number(wallet.realBalance)).toBe(800)
        })
    })
})
