import prisma from '../lib/prisma'
import { getIo } from '../lib/socket'
import { GameStatus, TransactionType, PaymentStatus } from '@world-bingo/shared-types'
import { drawBall, createBallPool, checkPattern, PatternName } from '@world-bingo/game-logic'
import { Decimal } from '@prisma/client/runtime/library'

export class GameService {
    /**
     * Join a game with one or more cartelas.
     * T8: Multi-cartela support — accepts cartelaSerials array.
     */
    static async joinGame(userId: string, gameId: string, cartelaSerials: string[]) {
        if (!cartelaSerials.length) throw new Error('At least one cartela is required')

        return await prisma.$transaction(async (tx) => {
            const game = await tx.game.findUnique({ 
                where: { id: gameId },
                include: { _count: { select: { entries: true } } }
            })
            if (!game) throw new Error('Game not found')
            
            if (game.status !== GameStatus.WAITING) {
                throw new Error('Game is already in progress or finished')
            }

            // Resolve cartela IDs from serials
            const cartelas = await tx.cartela.findMany({
                where: { serial: { in: cartelaSerials } },
            })

            if (cartelas.length !== cartelaSerials.length) {
                throw new Error('One or more cartela serials are invalid')
            }

            const cartelaIds = cartelas.map((c) => c.id)

            // Check none of these cartelas are already taken in this game
            const takenEntries = await tx.gameEntry.findMany({
                where: { gameId, cartelaId: { in: cartelaIds } },
            })

            if (takenEntries.length > 0) {
                throw new Error('One or more selected cartelas are already taken')
            }

            const totalCost = new Decimal(game.ticketPrice).times(cartelaSerials.length)

            // Lock the wallet row to prevent concurrent joins depleting balance
            const wallets = await tx.$queryRaw<Array<{ id: string; balance: Decimal }>>`
                SELECT id, balance FROM wallets WHERE "userId" = ${userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet || new Decimal(wallet.balance).lessThan(totalCost)) {
                throw new Error('Insufficient funds')
            }

            const balanceBefore = new Decimal(wallet.balance)
            const balanceAfter = balanceBefore.minus(totalCost)

            // Deduct balance
            await tx.wallet.update({
                where: { userId },
                data: { balance: { decrement: totalCost } }
            })

            // Create a single transaction record for the total entry cost
            await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.GAME_ENTRY,
                    amount: totalCost,
                    status: PaymentStatus.APPROVED,
                    referenceId: gameId,
                    balanceBefore: balanceBefore,
                    balanceAfter: balanceAfter,
                }
            })

            // Create one GameEntry per cartela
            const entries = await Promise.all(
                cartelaIds.map((cartelaId) =>
                    tx.gameEntry.create({
                        data: { gameId, userId, cartelaId },
                        include: { cartela: true },
                    })
                )
            )
            
            // Notify room of updated player count
            const io = getIo()
            io.to(`game:${gameId}`).emit('game:updated', { ...game, currentPlayers: game._count.entries + 1 } as any)
            
            return entries
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
        // In production, use BullMQ for robustness (T48)
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
                include: { _count: { select: { entries: true } } }
             })
             if (!game || game.status !== GameStatus.IN_PROGRESS || game.winnerId) {
                 clearInterval(interval)
                 return
             }

             const allBalls = createBallPool()
             const calledSet = new Set(game.calledBalls)
             const remaining = allBalls.filter(b => !calledSet.has(b))
             
             if (remaining.length === 0) {
                 clearInterval(interval)
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
        }, 3000)
    }

    static async claimBingo(userId: string, gameId: string, cartelaId: string) {
        return await prisma.$transaction(async (tx) => {
            const game = await tx.game.findUnique({ where: { id: gameId } })
            if (!game || game.status !== GameStatus.IN_PROGRESS) throw new Error('Game not active')

            // Verify the user actually has this cartela in this game
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

            // Winner found! Calculate prize based on all entries in the game
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

