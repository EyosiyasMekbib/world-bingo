import { describe, it, expect, beforeEach } from 'vitest'
import { RefundService } from '../services/refund.service'
import { WalletService } from '../services/wallet.service'
import { prisma } from './setup'
import { TransactionType, PaymentStatus, GameStatus, PatternType } from '@world-bingo/shared-types'

describe('RefundService', () => {
    let user1Id: string
    let user2Id: string
    let gameId: string

    beforeEach(async () => {
        // Create two users with wallets
        const user1 = await prisma.user.create({
            data: {
                username: 'refund_user1',
                phone: '+251900000001',
                passwordHash: 'hashed:pass1',
                wallet: { create: { balance: 100 } },
            },
        })
        const user2 = await prisma.user.create({
            data: {
                username: 'refund_user2',
                phone: '+251900000002',
                passwordHash: 'hashed:pass2',
                wallet: { create: { balance: 100 } },
            },
        })
        user1Id = user1.id
        user2Id = user2.id

        // Create a game
        const game = await prisma.game.create({
            data: {
                title: 'Refund Test Game',
                status: GameStatus.WAITING,
                ticketPrice: 50,
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: PatternType.ANY_LINE,
                calledBalls: [],
            },
        })
        gameId = game.id

        // Create cartelas
        const cartela1 = await prisma.cartela.create({
            data: {
                serial: 'REFUND-C1',
                grid: [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 0, 14, 15], [16, 17, 18, 19, 20], [21, 22, 23, 24, 25]],
            },
        })
        const cartela2 = await prisma.cartela.create({
            data: {
                serial: 'REFUND-C2',
                grid: [[26, 27, 28, 29, 30], [31, 32, 33, 34, 35], [36, 37, 0, 39, 40], [41, 42, 43, 44, 45], [46, 47, 48, 49, 50]],
            },
        })
        const cartela3 = await prisma.cartela.create({
            data: {
                serial: 'REFUND-C3',
                grid: [[51, 52, 53, 54, 55], [56, 57, 58, 59, 60], [61, 62, 0, 64, 65], [66, 67, 68, 69, 70], [71, 72, 73, 74, 75]],
            },
        })

        // User1 joins with 1 cartela, User2 joins with 2 cartelas
        // Deduct balances manually to simulate joining
        await prisma.wallet.update({ where: { userId: user1Id }, data: { balance: { decrement: 50 } } })
        await prisma.gameEntry.create({ data: { gameId, userId: user1Id, cartelaId: cartela1.id } })

        await prisma.wallet.update({ where: { userId: user2Id }, data: { balance: { decrement: 100 } } })
        await prisma.gameEntry.create({ data: { gameId, userId: user2Id, cartelaId: cartela2.id } })
        await prisma.gameEntry.create({ data: { gameId, userId: user2Id, cartelaId: cartela3.id } })
    })

    describe('refundGame', () => {
        it('should refund all players based on their cartela count', async () => {
            const results = await RefundService.refundGame(gameId)

            expect(results).toHaveLength(2)

            const u1Result = results.find(r => r.userId === user1Id)!
            const u2Result = results.find(r => r.userId === user2Id)!

            expect(u1Result.amount).toBe(50)  // 1 cartela × 50
            expect(u1Result.alreadyRefunded).toBe(false)
            expect(u2Result.amount).toBe(100) // 2 cartelas × 50
            expect(u2Result.alreadyRefunded).toBe(false)

            // Verify wallet balances were restored
            const w1 = await WalletService.getBalance(user1Id)
            expect(Number(w1.balance)).toBe(100) // 50 (remaining) + 50 (refund) = 100

            const w2 = await WalletService.getBalance(user2Id)
            expect(Number(w2.balance)).toBe(100) // 0 (remaining) + 100 (refund) = 100
        })

        it('should create REFUND transactions with correct balance snapshots', async () => {
            await RefundService.refundGame(gameId)

            const refundTxs = await prisma.transaction.findMany({
                where: { type: TransactionType.REFUND, referenceId: gameId },
                orderBy: { createdAt: 'asc' },
            })

            expect(refundTxs).toHaveLength(2)

            for (const tx of refundTxs) {
                expect(tx.status).toBe(PaymentStatus.APPROVED)
                expect(tx.referenceId).toBe(gameId)
                expect(tx.balanceBefore).toBeDefined()
                expect(tx.balanceAfter).toBeDefined()
                // balanceAfter should be greater than balanceBefore
                expect(Number(tx.balanceAfter)).toBeGreaterThan(Number(tx.balanceBefore))
            }
        })

        it('should be idempotent — running twice does not double-refund', async () => {
            // First refund
            await RefundService.refundGame(gameId)

            // Second refund — should be no-op
            const secondResults = await RefundService.refundGame(gameId)

            expect(secondResults).toHaveLength(2)
            expect(secondResults.every(r => r.alreadyRefunded)).toBe(true)

            // Verify balances haven't changed from first refund
            const w1 = await WalletService.getBalance(user1Id)
            expect(Number(w1.balance)).toBe(100) // Still 100, not 150

            const w2 = await WalletService.getBalance(user2Id)
            expect(Number(w2.balance)).toBe(100) // Still 100, not 200

            // Verify only 2 REFUND transactions exist (not 4)
            const refundTxs = await prisma.transaction.count({
                where: { type: TransactionType.REFUND, referenceId: gameId },
            })
            expect(refundTxs).toBe(2)
        })

        it('should return empty array for game with no entries', async () => {
            const emptyGame = await prisma.game.create({
                data: {
                    title: 'Empty Game',
                    status: GameStatus.WAITING,
                    ticketPrice: 50,
                    maxPlayers: 10,
                    minPlayers: 2,
                    houseEdgePct: 10,
                    pattern: PatternType.ANY_LINE,
                    calledBalls: [],
                },
            })

            const results = await RefundService.refundGame(emptyGame.id)
            expect(results).toHaveLength(0)
        })
    })
})
