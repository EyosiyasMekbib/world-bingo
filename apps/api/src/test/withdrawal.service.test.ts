import { describe, it, expect, beforeEach } from 'vitest'
import { WalletService } from '../services/wallet.service'
import { prisma } from './setup'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'

describe('WalletService — Withdrawal flow (T15)', () => {
    let testUserId: string

    beforeEach(async () => {
        const user = await prisma.user.create({
            data: {
                username: 'withdraw_test_user',
                phone: '+251900100001',
                passwordHash: 'hashed:testpass',
                wallet: { create: { balance: 1000 } },
            },
        })
        testUserId = user.id
    })

    describe('requestWithdrawal — complete flow', () => {
        it('should enforce minimum withdrawal of 100 Birr', async () => {
            await expect(
                WalletService.requestWithdrawal(testUserId, {
                    amount: 50,
                    paymentMethod: 'Telebirr',
                    accountNumber: '0911111111',
                }),
            ).rejects.toThrow('Minimum withdrawal amount is 100 Birr')
        })

        it('should deduct balance immediately on request', async () => {
            const tx = await WalletService.requestWithdrawal(testUserId, {
                amount: 200,
                paymentMethod: 'CBE Birr',
                accountNumber: '1234567890',
            })

            expect(tx.type).toBe(TransactionType.WITHDRAWAL)
            expect(tx.status).toBe(PaymentStatus.PENDING_REVIEW)
            expect(tx.amount.toString()).toBe('200')
            expect(tx.note).toContain('CBE Birr')
            expect(tx.note).toContain('1234567890')

            const wallet = await WalletService.getBalance(testUserId)
            expect(Number(wallet.balance)).toBe(800)
        })

        it('should record balance snapshots on withdrawal', async () => {
            const tx = await WalletService.requestWithdrawal(testUserId, {
                amount: 300,
                paymentMethod: 'Telebirr',
                accountNumber: '0912345678',
            })

            expect(tx.balanceBefore?.toString()).toBe('1000')
            expect(tx.balanceAfter?.toString()).toBe('700')
        })

        it('should prevent withdrawal exceeding balance', async () => {
            await expect(
                WalletService.requestWithdrawal(testUserId, {
                    amount: 5000,
                    paymentMethod: 'Telebirr',
                    accountNumber: '0911111111',
                }),
            ).rejects.toThrow('Insufficient balance')
        })

        it('should allow multiple withdrawals that do not exceed balance', async () => {
            await WalletService.requestWithdrawal(testUserId, {
                amount: 400,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            })

            await WalletService.requestWithdrawal(testUserId, {
                amount: 400,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            })

            const wallet = await WalletService.getBalance(testUserId)
            expect(Number(wallet.balance)).toBe(200) // 1000 - 400 - 400
        })

        it('should reject withdrawal that would make balance negative', async () => {
            // First withdrawal succeeds
            await WalletService.requestWithdrawal(testUserId, {
                amount: 900,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            })

            // Second withdrawal should fail (only 100 left, need 200)
            await expect(
                WalletService.requestWithdrawal(testUserId, {
                    amount: 200,
                    paymentMethod: 'Telebirr',
                    accountNumber: '0911111111',
                }),
            ).rejects.toThrow('Insufficient balance')
        })
    })

    describe('getTransactions — pagination and filtering', () => {
        beforeEach(async () => {
            // Create some transactions
            await WalletService.requestWithdrawal(testUserId, {
                amount: 100,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            })
            await WalletService.requestWithdrawal(testUserId, {
                amount: 200,
                paymentMethod: 'CBE',
                accountNumber: '1234567890',
            })
            await WalletService.initiateDeposit(testUserId, { amount: 500 })
        })

        it('should return all transactions with pagination', async () => {
            const result = await WalletService.getTransactions(testUserId, { page: 1, limit: 10 })

            expect(result.data.length).toBe(3)
            expect(result.pagination.total).toBe(3)
            expect(result.pagination.page).toBe(1)
        })

        it('should filter by transaction type', async () => {
            const withdrawals = await WalletService.getTransactions(testUserId, {
                type: TransactionType.WITHDRAWAL,
            })
            expect(withdrawals.data.length).toBe(2)
            expect(withdrawals.data.every(t => t.type === TransactionType.WITHDRAWAL)).toBe(true)

            const deposits = await WalletService.getTransactions(testUserId, {
                type: TransactionType.DEPOSIT,
            })
            expect(deposits.data.length).toBe(1)
        })

        it('should paginate correctly', async () => {
            const page1 = await WalletService.getTransactions(testUserId, { page: 1, limit: 2 })
            expect(page1.data.length).toBe(2)
            expect(page1.pagination.totalPages).toBe(2)

            const page2 = await WalletService.getTransactions(testUserId, { page: 2, limit: 2 })
            expect(page2.data.length).toBe(1)
        })
    })
})
