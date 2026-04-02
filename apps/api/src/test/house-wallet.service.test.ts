import { describe, it, expect, beforeEach } from 'vitest'
import { HouseWalletService } from '../services/house-wallet.service'
import { prisma } from './setup'

describe('HouseWalletService', () => {
    describe('getOrCreate', () => {
        it('should create house wallet with 0 balance if it does not exist', async () => {
            const wallet = await HouseWalletService.getOrCreate()
            expect(wallet.id).toBe('house')
            expect(Number(wallet.balance)).toBe(0)
        })

        it('should return existing wallet without resetting balance', async () => {
            await HouseWalletService.getOrCreate()
            await prisma.houseWallet.update({ where: { id: 'house' }, data: { balance: 500 } })

            const wallet = await HouseWalletService.getOrCreate()
            expect(Number(wallet.balance)).toBe(500) // balance preserved
        })
    })

    describe('getBalance', () => {
        it('should return 0 for a fresh wallet', async () => {
            const balance = await HouseWalletService.getBalance()
            expect(balance.toNumber()).toBe(0)
        })

        it('should reflect balance after a credit', async () => {
            await HouseWalletService.credit(250, 'COMMISSION', 'test')
            const balance = await HouseWalletService.getBalance()
            expect(balance.toNumber()).toBe(250)
        })
    })

    describe('credit', () => {
        it('should increase house balance by the credited amount', async () => {
            await HouseWalletService.credit(100, 'COMMISSION', 'Test commission')

            const balance = await HouseWalletService.getBalance()
            expect(balance.toNumber()).toBe(100)
        })

        it('should create a HouseTransaction record with type and description', async () => {
            await HouseWalletService.credit(250, 'COMMISSION', 'Game commission', 'game-1', 'user-1')

            const tx = await prisma.houseTransaction.findFirst({
                where: { type: 'COMMISSION', gameId: 'game-1' },
            })
            expect(tx).not.toBeNull()
            expect(Number(tx!.amount)).toBe(250)
            expect(tx!.description).toBe('Game commission')
            expect(tx!.userId).toBe('user-1')
        })

        it('should record correct balanceBefore and balanceAfter', async () => {
            await HouseWalletService.credit(100, 'COMMISSION', 'first')
            await HouseWalletService.credit(50, 'BOT_PRIZE_WIN', 'second')

            const txs = await prisma.houseTransaction.findMany({
                orderBy: { createdAt: 'asc' },
            })

            expect(Number(txs[0].balanceBefore)).toBe(0)
            expect(Number(txs[0].balanceAfter)).toBe(100)
            expect(Number(txs[1].balanceBefore)).toBe(100)
            expect(Number(txs[1].balanceAfter)).toBe(150)
        })

        it('should handle concurrent credits without losing funds', async () => {
            // 5 concurrent credits of 20 each = expected final balance 100
            await Promise.all([
                HouseWalletService.credit(20, 'COMMISSION', 'c1'),
                HouseWalletService.credit(20, 'COMMISSION', 'c2'),
                HouseWalletService.credit(20, 'COMMISSION', 'c3'),
                HouseWalletService.credit(20, 'COMMISSION', 'c4'),
                HouseWalletService.credit(20, 'COMMISSION', 'c5'),
            ])

            const balance = await HouseWalletService.getBalance()
            expect(balance.toNumber()).toBe(100)

            const txCount = await prisma.houseTransaction.count()
            expect(txCount).toBe(5)
        })

        it('should support BOT_PRIZE_WIN type', async () => {
            await HouseWalletService.credit(300, 'BOT_PRIZE_WIN', 'bot won', 'game-x', 'bot-user')

            const tx = await prisma.houseTransaction.findFirst({ where: { type: 'BOT_PRIZE_WIN' } })
            expect(tx).not.toBeNull()
            expect(Number(tx!.amount)).toBe(300)
        })
    })

    describe('debit', () => {
        beforeEach(async () => {
            // Seed house wallet with 1000 for debit tests
            await prisma.houseWallet.upsert({
                where: { id: 'house' },
                update: { balance: 1000 },
                create: { id: 'house', balance: 1000 },
            })
        })

        it('should decrease house balance by the debited amount', async () => {
            await HouseWalletService.debit(300, 'REFUND_ISSUED', 'Player refund')

            const balance = await HouseWalletService.getBalance()
            expect(balance.toNumber()).toBe(700)
        })

        it('should create a HouseTransaction record for the debit', async () => {
            await HouseWalletService.debit(200, 'REFUND_ISSUED', 'Refund for game-42', 'game-42')

            const tx = await prisma.houseTransaction.findFirst({
                where: { type: 'REFUND_ISSUED', gameId: 'game-42' },
            })
            expect(tx).not.toBeNull()
            expect(Number(tx!.amount)).toBe(200)
        })

        it('should record correct balanceBefore and balanceAfter for debit', async () => {
            await HouseWalletService.debit(400, 'REFUND_ISSUED', 'debit test')

            const tx = await prisma.houseTransaction.findFirst({
                where: { type: 'REFUND_ISSUED' },
            })
            expect(Number(tx!.balanceBefore)).toBe(1000)
            expect(Number(tx!.balanceAfter)).toBe(600)
        })
    })

    describe('getTransactions', () => {
        beforeEach(async () => {
            await HouseWalletService.credit(100, 'COMMISSION', 'c1')
            await HouseWalletService.credit(50, 'BOT_PRIZE_WIN', 'b1')
            // Give enough balance to debit
            await prisma.houseWallet.update({ where: { id: 'house' }, data: { balance: 1000 } })
            await HouseWalletService.debit(30, 'REFUND_ISSUED', 'r1')
        })

        it('should return all transactions paginated', async () => {
            const { transactions, total } = await HouseWalletService.getTransactions(1, 10)
            expect(total).toBe(3)
            expect(transactions).toHaveLength(3)
        })

        it('should filter by type', async () => {
            const { transactions, total } = await HouseWalletService.getTransactions(1, 10, 'COMMISSION')
            expect(total).toBe(1)
            expect(transactions[0].type).toBe('COMMISSION')
        })

        it('should paginate correctly', async () => {
            const page1 = await HouseWalletService.getTransactions(1, 2)
            expect(page1.transactions).toHaveLength(2)
            expect(page1.total).toBe(3)

            const page2 = await HouseWalletService.getTransactions(2, 2)
            expect(page2.transactions).toHaveLength(1)
        })

        it('should order transactions by createdAt descending (newest first)', async () => {
            const { transactions } = await HouseWalletService.getTransactions(1, 10)
            // newest = REFUND_ISSUED, then BOT_PRIZE_WIN, then COMMISSION
            expect(transactions[0].type).toBe('REFUND_ISSUED')
        })
    })

    describe('getSummary', () => {
        it('should aggregate amounts by type', async () => {
            await HouseWalletService.credit(100, 'COMMISSION', 'c1')
            await HouseWalletService.credit(200, 'COMMISSION', 'c2')
            await prisma.houseWallet.update({ where: { id: 'house' }, data: { balance: 1000 } })
            await HouseWalletService.debit(50, 'REFUND_ISSUED', 'r1')

            const summary = await HouseWalletService.getSummary()
            expect(summary.COMMISSION).toBe(300)
            expect(summary.REFUND_ISSUED).toBe(50)
            expect(summary.BOT_PRIZE_WIN).toBe(0)
        })

        it('should return 0 for all types when no transactions exist', async () => {
            const summary = await HouseWalletService.getSummary()
            expect(summary.COMMISSION).toBe(0)
            expect(summary.REFUND_ISSUED).toBe(0)
            expect(summary.BOT_PRIZE_WIN).toBe(0)
        })
    })
})
