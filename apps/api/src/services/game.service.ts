import prisma from '../lib/prisma'
import { getIo } from '../lib/socket'
import { GameStatus, TransactionType, PaymentStatus } from '@world-bingo/shared-types'
import { drawBall, createBallPool, checkPattern, PatternName } from '@world-bingo/game-logic'

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
                 // This check should ideally be handled by UI not showing taken cards, but good for safety
                 throw new Error('Cartela already taken')
            }

            const wallet = await tx.wallet.findUnique({ where: { userId } })
            if (!wallet || wallet.balance.lessThan(game.ticketPrice)) {
                throw new Error('Insufficient funds')
            }

            // Deduct balance
            await tx.wallet.update({
                where: { userId },
                data: { balance: { decrement: game.ticketPrice } }
            })

            // Create Transaction Record
            await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.GAME_ENTRY,
                    amount: game.ticketPrice, // negative? or just type implies it
                    status: PaymentStatus.APPROVED,
                    referenceId: gameId
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
                    // Fix: Prisma relation to User is not defined in GameEntry model in previous schema edit?
                    // Let's check schema.
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

            const entry = await tx.gameEntry.findUnique({
                where: {
                    gameId_userId: { gameId, userId },
                    cartelaId: cartelaId // Ensure user owns this cartela in this game
                },
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

            // Winner found!
            // Calculate prize
            const totalPot = Number(game.ticketPrice) * (await tx.gameEntry.count({ where: { gameId } }))
            const houseData = { entries: 1, ticketPrice: Number(game.ticketPrice), houseEdgePct: Number(game.houseEdgePct) } // simplifies
            
             // We should store total entries to calculate correctly
            const totalEntries = await tx.gameEntry.count({ where: { gameId } })
            const prize = totalPot * (1 - Number(game.houseEdgePct) / 100)

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

            // Record Transaction
            await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.PRIZE_WIN,
                    amount: prize,
                    status: PaymentStatus.APPROVED,
                    referenceId: gameId
                }
            })
            
            const user = await tx.user.findUnique({ where: { id: userId } })

            const io = getIo()
            io.to(`game:${gameId}`).emit('game:winner', {
                gameId,
                winner: user as any, // Sanitized user ideally
                prizeAmount: prize
            })
            
            return endedGame
        })
    }
}
