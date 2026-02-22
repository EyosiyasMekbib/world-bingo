import prisma from '../lib/prisma'
import { getIo } from '../lib/socket'
import { GameStatus, TransactionType, PaymentStatus, NotificationType } from '@world-bingo/shared-types'
import { checkPattern, PatternName } from '@world-bingo/game-logic'
import { Decimal } from '@prisma/client/runtime/library'
import { startGameEngine, stopGameEngine } from '../lib/game-engine'
import { RefundService } from './refund.service'
import { NotificationService } from './notification.service'
import { clearGameState } from '../lib/game-state'

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
        const game = await prisma.game.findUnique({
            where: { id: gameId },
            include: { entries: { distinct: ['userId'], select: { userId: true } } },
        })
        if (!game) throw new Error('Game not found')
        if (game.status !== GameStatus.WAITING && game.status !== GameStatus.STARTING) {
            throw new Error('Game is not in a startable state')
        }

        // Check minimum player requirement
        const playerCount = game.entries.length
        if (playerCount < game.minPlayers) {
            throw new Error(`Not enough players to start. Need at least ${game.minPlayers}, have ${playerCount}.`)
        }

        const updatedGame = await prisma.game.update({
            where: { id: gameId },
            data: {
                status: GameStatus.STARTING,
                startedAt: new Date(),
            },
        })

        const io = getIo()
        io.to(`game:${gameId}`).emit('game:started', updatedGame as any)

        // Notify all participants that the game is starting
        const participantIds = game.entries.map((e) => e.userId)
        await Promise.all(
            participantIds.map((userId) =>
                NotificationService.create(
                    userId,
                    NotificationType.GAME_STARTING,
                    'Game Starting!',
                    `Your bingo game is starting in 5 seconds. Get ready!`,
                    { gameId },
                ).catch(() => {}),
            ),
        )

        // 5-second grace period, then start the engine (T24 — Redlock-backed)
        setTimeout(() => {
            startGameEngine(gameId).catch((err) => {
                console.error(`[GameService] startGameEngine failed for ${gameId}:`, err)
            })
        }, 5_000)

        return updatedGame
    }

    /**
     * T25 — Cancel a game. Stops the engine, refunds all players, notifies them.
     */
    static async cancelGame(gameId: string): Promise<void> {
        const game = await prisma.game.findUnique({ where: { id: gameId } })
        if (!game) throw new Error('Game not found')
        if (game.status === GameStatus.COMPLETED || game.status === GameStatus.CANCELLED) {
            throw new Error('Game is already finished or cancelled')
        }

        // Stop the game engine on this instance if running
        stopGameEngine(gameId)

        // Mark cancelled in Postgres
        await prisma.game.update({
            where: { id: gameId },
            data: { status: GameStatus.CANCELLED, endedAt: new Date() },
        })

        // Clear Redis state
        await clearGameState(gameId).catch(() => {})

        // Refund all players (idempotent)
        const refunds = await RefundService.refundGame(gameId)

        // Notify each refunded player
        await Promise.all(
            refunds
                .filter((r) => !r.alreadyRefunded)
                .map((r) =>
                    NotificationService.create(
                        r.userId,
                        NotificationType.GAME_CANCELLED,
                        'Game Cancelled',
                        `Your game was cancelled. ${r.amount} ETB has been refunded to your wallet.`,
                        { gameId, refundAmount: r.amount },
                    ).catch(() => {}),
                ),
        )

        // Broadcast cancellation via WebSocket
        const io = getIo()
        io.to(`game:${gameId}`).emit('game:cancelled', { gameId, reason: 'admin_cancelled' })
        io.to('lobby').emit('lobby:game-removed', gameId)
    }

    /**
     * T26 — Auto-cancel: called when a game's countdown expires but not enough players joined.
     */
    static async autoCancelIfUnderFilled(gameId: string): Promise<void> {
        const game = await prisma.game.findUnique({
            where: { id: gameId },
            include: { entries: { distinct: ['userId'], select: { userId: true } } },
        })
        if (!game || game.status !== GameStatus.WAITING) return

        const playerCount = game.entries.length
        if (playerCount < game.minPlayers) {
            console.log(
                `[GameService] Auto-cancelling game ${gameId}: only ${playerCount}/${game.minPlayers} players.`,
            )
            await GameService.cancelGame(gameId)
        }
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

            // Validate Pattern using Redis called balls (more up-to-date than Postgres)
            const { getCalledBalls: getRedisCalledBalls } = await import('../lib/game-state.js')
            const calledBallsFromRedis = await getRedisCalledBalls(gameId)
            const calledBalls = calledBallsFromRedis.length > 0 ? calledBallsFromRedis : game.calledBalls

            // @ts-ignore - JSON type issue
            const grid = entry.cartela.grid as number[][]
            const calledSet = new Set(calledBalls)
            
            const hasWon = checkPattern(game.pattern as PatternName, grid, calledSet)
            
            if (!hasWon) {
                throw new Error('False Bingo!')
            }

            // Stop the engine on this instance
            stopGameEngine(gameId)

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

            // Update Game — persist called balls from Redis
            const endedGame = await tx.game.update({
                where: { id: gameId },
                data: {
                    status: GameStatus.COMPLETED,
                    winnerId: userId,
                    endedAt: new Date(),
                    calledBalls: calledBalls,
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
            io.to(`game:${gameId}`).emit('game:ended', endedGame as any)
            io.to('lobby').emit('lobby:game-removed', gameId)
            
            return endedGame
        }).then(async (endedGame) => {
            // Post-transaction: notify winner and clear Redis (non-critical)
            await NotificationService.create(
                userId,
                NotificationType.GAME_WON,
                '🎉 You Won!',
                `Congratulations! You won ${((Number(endedGame.ticketPrice) * await prisma.gameEntry.count({ where: { gameId } })) * (1 - Number(endedGame.houseEdgePct) / 100)).toFixed(2)} ETB!`,
                { gameId },
            ).catch(() => {})
            await clearGameState(gameId).catch(() => {})
            return endedGame
        })
    }
}