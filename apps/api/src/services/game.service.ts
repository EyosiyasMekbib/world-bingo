import prisma from '../lib/prisma'
import { getIo } from '../lib/socket'
import { GameStatus, TransactionType, PaymentStatus } from '@world-bingo/shared-types'
import { drawBall, createBallPool, checkPattern, PatternName } from '@world-bingo/game-logic'
import { Decimal } from '@prisma/client/runtime/library'

export class GameService {
    static async joinGame(userId: string, gameId: string, cartelaId: string) {
        return await prisma.$transaction(async (tx) => {
            const game = await tx.game.findUnique({ 
                where: { id: gameId },
                include: { entries: true } 
            })
            if (!game) throw new Error('Game not found')
            
            if (game.status !== GameStatus.WAITING) {
                throw new Error('Game is already in progress or finished')
            }

            const existingEntry = await tx.gameEntry.findFirst({
                where: {
                    gameId,
                    OR: [{ userId }, { cartelaId }]
                }
            })

            if (existingEntry) {
                 if (existingEntry.userId === userId) throw new Error('You already joined this game')
                 throw new Error('Cartela already taken')
            }

            // Lock the wallet row to prevent concurrent joins depleting balance
            const wallets = await tx.$queryRaw<Array<{ id: string; balance: Decimal }>>`
                SELECT id, balance FROM wallets WHERE "userId" = ${userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet || new Decimal(wallet.balance).lessThan(new Decimal(game.ticketPrice))) {
                throw new Error('Insufficient funds')
            }

            const balanceBefore = new Decimal(wallet.balance)
            const balanceAfter = balanceBefore.minus(new Decimal(game.ticketPrice))

            // Deduct balance
            await tx.wallet.update({
                where: { userId },
                data: { balance: { decrement: game.ticketPrice } }
            })

            // Create Transaction Record with balance snapshot
            await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.GAME_ENTRY,
                    amount: game.ticketPrice,
                    status: PaymentStatus.APPROVED,
                    referenceId: gameId,
                    balanceBefore: balanceBefore,
                    balanceAfter: balanceAfter,
                }
            })

            // Create Entry
            const entry = await tx.gameEntry.create({
                data: {
                    gameId,
                    userId,
                    cartelaId
                },
                include: {
                    cartela: true,
                }
            })
            
            // Notify room
            const io = getIo()
            io.to(`game:${gameId}`).emit('game:updated', { ...game, currentPlayers: (game.entries?.length || 0) + 1 } as any)
            
            return entry
        })
    }

    static async startGame(gameId: string) {
        const game = await prisma.game.update({
            where: { id: gameId },
            data: { 
                status: GameStatus.STARTING,
                startedAt: new Date()
            }
        })
        
        const io = getIo()
        io.to(`game:${gameId}`).emit('game:started', game as any)
        
        // Use a timeout to switch to ACTIVE and start calling balls
        // In production, use BullMQ for robustness
        setTimeout(() => {
             this.runGameLoop(gameId)
        }, 5000) // 5 seconds grace period

        return game
    }

    private static async runGameLoop(gameId: string) {
        await prisma.game.update({
             where: { id: gameId },
             data: { status: GameStatus.IN_PROGRESS }
        })

        const interval = setInterval(async () => {
             const game = await prisma.game.findUnique({
                where: { id: gameId },
                include: { entries: true } 
             })
             if (!game || game.status !== GameStatus.IN_PROGRESS || game.winnerId) {
                 clearInterval(interval)
                 return
             }

             // Logic to pick a ball
             // We need to know which balls remain.
             // Ideally we store available balls in Redis or DB.
             // For simplicity, let's recalculate from calledBalls (inefficient but works for MVP)
             const allBalls = createBallPool()
             const calledSet = new Set(game.calledBalls)
             const remaining = allBalls.filter(b => !calledSet.has(b))
             
             if (remaining.length === 0) {
                 clearInterval(interval) // Game over, no winner?
                 return
             }

             const { ball } = drawBall(remaining)
             
             const updatedGame = await prisma.game.update({
                 where: { id: gameId },
                 data: {
                     calledBalls: { push: ball }
                 }
             })

             const io = getIo()
             io.to(`game:${gameId}`).emit('game:ball-called', {
                 gameId,
                 ball,
                 calledBalls: updatedGame.calledBalls
             })

             // Check for winner? 
             // Usually clients claim bingo, but server can also auto-win if preferred.
             // Bible says "Server-authoritative winner detection".
             // We could check all players here, but that's heavy for every ball.
             // Let's rely on client claiming OR run a background job.
             // "Winner detection" usually means verification.
             // However, "Auto-marked cards" suggests server knows state.
             
        }, 3000) // Call ball every 3 seconds
    }

    static async claimBingo(userId: string, gameId: string, cartelaId: string) {
        return await prisma.$transaction(async (tx) => {
            const game = await tx.game.findUnique({ where: { id: gameId } })
            if (!game || game.status !== GameStatus.IN_PROGRESS) throw new Error('Game not active')

            const entry = await tx.gameEntry.findFirst({
                where: { gameId, userId, cartelaId },
                include: { cartela: true }
            })

            if (!entry) throw new Error('Invalid entry')

            // Validate Pattern
            // @ts-ignore - JSON type issue
            const grid = entry.cartela.grid as number[][]
            const calledSet = new Set(game.calledBalls)
            
            const hasWon = checkPattern(game.pattern as PatternName, grid, calledSet)
            
            if (!hasWon) {
                throw new Error('False Bingo!')
            }

            // Winner found! Calculate prize
            const totalEntries = await tx.gameEntry.count({ where: { gameId } })
            const totalPot = Number(game.ticketPrice) * totalEntries
            const prize = totalPot * (1 - Number(game.houseEdgePct) / 100)

            // Lock winner wallet row before crediting prize
            const wallets = await tx.$queryRaw<Array<{ id: string; balance: Decimal }>>`
                SELECT id, balance FROM wallets WHERE "userId" = ${userId} FOR UPDATE
            `
            const wallet = wallets[0]
            const balanceBefore = wallet ? new Decimal(wallet.balance) : new Decimal(0)
            const balanceAfter = balanceBefore.plus(new Decimal(prize))

            // Update Game
            const endedGame = await tx.game.update({
                where: { id: gameId },
                data: {
                    status: GameStatus.COMPLETED,
                    winnerId: userId,
                    endedAt: new Date()
                }
            })

            // Pay Winner
            await tx.wallet.update({
                where: { userId },
                data: { balance: { increment: prize } }
            })

            // Record Transaction with balance snapshot
            await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.PRIZE_WIN,
                    amount: prize,
                    status: PaymentStatus.APPROVED,
                    referenceId: gameId,
                    balanceBefore: balanceBefore,
                    balanceAfter: balanceAfter,
                }
            })
            
            const user = await tx.user.findUnique({ where: { id: userId } })

            const io = getIo()
            io.to(`game:${gameId}`).emit('game:winner', {
                gameId,
                winner: user as any,
                prizeAmount: prize
            })
            
            return endedGame
        })
    }
}
