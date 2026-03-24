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
})
