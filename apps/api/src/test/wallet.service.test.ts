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
                passwordHash: 'hashed',
                wallet: {
                    create: {
                        balance: 100,
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
            
            expect(wallet.balance.toString()).toBe('100')
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
            expect(wallet.balance.toString()).toBe('600') // 100 + 500
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
})
