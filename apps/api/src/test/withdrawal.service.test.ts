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
                wallet: { create: { realBalance: 1000 } },
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
            expect(Number(wallet.realBalance)).toBe(800)
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

        it('refuses a second withdrawal while one is still pending, and debits only once', async () => {
            // This replaces a test that queued two withdrawals back to back and
            // expected both to land. requestWithdrawal now allows one pending
            // request per user at a time — a deliberate rule, guarded twice: a
            // fast-path read up front and an authoritative re-check inside the
            // wallet lock. The old premise is simply no longer the contract.
            const first = await WalletService.requestWithdrawal(testUserId, {
                amount: 400,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            })
            expect(first.status).toBe(PaymentStatus.PENDING_REVIEW)

            await expect(
                WalletService.requestWithdrawal(testUserId, {
                    amount: 400,
                    paymentMethod: 'Telebirr',
                    accountNumber: '0911111111',
                }),
            ).rejects.toThrow('already have a pending withdrawal')

            // The refusal must cost the player nothing: one debit, one row.
            const wallet = await WalletService.getBalance(testUserId)
            expect(Number(wallet.realBalance)).toBe(600)
            expect(
                await prisma.transaction.count({
                    where: { userId: testUserId, type: TransactionType.WITHDRAWAL },
                }),
            ).toBe(1)
        })

        it('carries a 409 on the refusal, so a retrying client can tell it apart from a validation error', async () => {
            await WalletService.requestWithdrawal(testUserId, {
                amount: 400,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            })

            const err = await WalletService.requestWithdrawal(testUserId, {
                amount: 100,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            }).catch((e) => e)

            expect(err.statusCode).toBe(409)
        })

        it('lets the next withdrawal through once the pending one is resolved', async () => {
            // The rule is "one at a time", not "one ever" — without this the suite
            // would pass just as well against a service that refused every
            // withdrawal after the first.
            const first = await WalletService.requestWithdrawal(testUserId, {
                amount: 400,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            })
            await prisma.transaction.update({
                where: { id: first.id },
                data: { status: PaymentStatus.APPROVED },
            })

            const second = await WalletService.requestWithdrawal(testUserId, {
                amount: 400,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            })

            expect(second.status).toBe(PaymentStatus.PENDING_REVIEW)
            const wallet = await WalletService.getBalance(testUserId)
            expect(Number(wallet.realBalance)).toBe(200)
        })

        it('serializes two concurrent requests, so the guard holds without relying on the fast path', async () => {
            // The pre-check outside the transaction is racy by its own admission;
            // the guard that counts is the one inside the wallet lock. Firing both
            // at once is the only way to reach it, and exactly one must win.
            const results = await Promise.allSettled([
                WalletService.requestWithdrawal(testUserId, {
                    amount: 400,
                    paymentMethod: 'Telebirr',
                    accountNumber: '0911111111',
                }),
                WalletService.requestWithdrawal(testUserId, {
                    amount: 400,
                    paymentMethod: 'Telebirr',
                    accountNumber: '0911111111',
                }),
            ])

            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
            expect(
                await prisma.transaction.count({
                    where: { userId: testUserId, type: TransactionType.WITHDRAWAL },
                }),
            ).toBe(1)
            const wallet = await WalletService.getBalance(testUserId)
            expect(Number(wallet.realBalance)).toBe(600)
        })

        it('should reject withdrawal that would make balance negative', async () => {
            // First withdrawal succeeds and debits immediately.
            const first = await WalletService.requestWithdrawal(testUserId, {
                amount: 900,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            })
            // Resolve it, or the single-pending guard answers first and this test
            // passes for the wrong reason — it is about the balance check, and the
            // whole point is that the debit already happened.
            await prisma.transaction.update({
                where: { id: first.id },
                data: { status: PaymentStatus.APPROVED },
            })

            // Only 100 left, asking for 200.
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
            // Two withdrawals and a deposit, still written by the real services.
            // Only one withdrawal may be pending at a time, so the first is
            // resolved before the second is asked for — the shape these tests
            // need, without a fixture that the service would now refuse.
            const first = await WalletService.requestWithdrawal(testUserId, {
                amount: 100,
                paymentMethod: 'Telebirr',
                accountNumber: '0911111111',
            })
            await prisma.transaction.update({
                where: { id: first.id },
                data: { status: PaymentStatus.APPROVED },
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
