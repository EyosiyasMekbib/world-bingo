/**
 * PayoutService — Phase-4 Resolution
 *
 * Implements the PAYOUT state-machine phase described in the spec:
 *
 *   1. Read room pot from Redis.
 *   2. Calculate house fee (10 %).
 *   3. Calculate net win per winner (split equally among co-winners).
 *   4. Single Postgres transaction:
 *        BEGIN
 *          UPDATE wallets SET balance += net_win   (for each winner, SELECT FOR UPDATE)
 *          UPDATE admin_wallet SET balance += house_fee  (SELECT FOR UPDATE)
 *          INSERT transactions (PRIZE_WIN per winner)
 *          INSERT transactions (HOUSE_FEE for admin)
 *          UPDATE games SET status = 'COMPLETED', winner_id = ...
 *        COMMIT
 *   5. Emit `game_over` socket event.
 *   6. Clear Redis room state.
 *
 * The service is idempotent: if the game is already COMPLETED or PAYOUT,
 * it returns the existing result without double-paying.
 */

import prisma from '../lib/prisma'
import { Decimal } from '@prisma/client/runtime/library'
import { Prisma } from '@prisma/client'
import { GameStatus, TransactionType, PaymentStatus, NotificationType } from '@world-bingo/shared-types'
import { getPot, setRoomStatus, clearRoomState } from '../lib/room-state'
import { getIo } from '../lib/socket'
import { NotificationService } from './notification.service'
import { clearGameState } from '../lib/game-state'

const HOUSE_EDGE_PCT = 10

export interface PayoutResult {
    gameId: string
    totalPot: number
    houseFee: number
    netWinPerPlayer: number
    winners: Array<{ userId: string; username: string; netWin: number }>
    alreadyPaid: boolean
}

export class PayoutService {
    /**
     * Execute the full PAYOUT phase for a completed game.
     *
     * @param gameId    - The game that has a winner.
     * @param winnerIds - One or more user IDs who have a valid bingo.
     */
    static async executePayout(gameId: string, winnerIds: string[]): Promise<PayoutResult> {
        if (winnerIds.length === 0) throw new Error('Cannot execute payout with no winners')

        // ── Idempotency guard ────────────────────────────────────────────────
        const existingGame = await prisma.game.findUnique({ where: { id: gameId } })
        if (!existingGame) throw new Error(`Game ${gameId} not found`)

        if (
            existingGame.status === GameStatus.COMPLETED ||
            (existingGame.status as string) === 'PAYOUT'
        ) {
            // Already paid — reconstruct result from DB
            const winners = await prisma.user.findMany({
                where: { id: { in: winnerIds } },
                select: { id: true, username: true },
            })
            return {
                gameId,
                totalPot: 0,
                houseFee: 0,
                netWinPerPlayer: 0,
                winners: winners.map((w) => ({ userId: w.id, username: w.username, netWin: 0 })),
                alreadyPaid: true,
            }
        }

        // ── Mark PAYOUT phase (optimistic lock) ──────────────────────────────
        await setRoomStatus(gameId, 'PAYOUT')

        // ── Read pot from Redis (source of truth during active game) ─────────
        let totalPot = await getPot(gameId)

        // Fallback: if Redis pot is 0 (e.g. server restart), re-derive from DB
        if (totalPot === 0) {
            const entryCount = await prisma.gameEntry.count({ where: { gameId } })
            const game = await prisma.game.findUnique({ where: { id: gameId } })
            totalPot = Number(game?.ticketPrice ?? 0) * entryCount
        }

        // ── Financial calculations ────────────────────────────────────────────
        const grossDecimal    = new Decimal(totalPot)
        const houseFeeDecimal = grossDecimal.mul(HOUSE_EDGE_PCT).div(100)
        const netPoolDecimal  = grossDecimal.minus(houseFeeDecimal)
        const netWinDecimal   = netPoolDecimal.div(winnerIds.length)

        const houseFee       = houseFeeDecimal.toNumber()
        const netWinPerPlayer = netWinDecimal.toNumber()

        // Fetch winner usernames for the socket broadcast
        const winnerUsers = await prisma.user.findMany({
            where: { id: { in: winnerIds } },
            select: { id: true, username: true },
        })

        // ── Atomic Postgres transaction ───────────────────────────────────────
        await prisma.$transaction(
            async (tx: Prisma.TransactionClient) => {
                // 1. Credit each winner's wallet (SELECT FOR UPDATE prevents double-spend)
                for (const userId of winnerIds) {
                    const wallets = await tx.$queryRaw<Array<{ balance: Decimal }>>`
                        SELECT balance FROM wallets WHERE "userId" = ${userId} FOR UPDATE
                    `
                    const wallet = wallets[0]
                    if (!wallet) throw new Error(`Wallet not found for winner ${userId}`)

                    const balanceBefore = new Decimal(wallet.balance)
                    const balanceAfter  = balanceBefore.plus(netWinDecimal)

                    await tx.wallet.update({
                        where: { userId },
                        data: { balance: { increment: netWinDecimal } },
                    })

                    await tx.transaction.create({
                        data: {
                            userId,
                            type: TransactionType.PRIZE_WIN,
                            amount: netWinDecimal,
                            status: PaymentStatus.APPROVED,
                            referenceId: gameId,
                            note: `Prize win — ${winnerIds.length} winner(s). House: ${HOUSE_EDGE_PCT}%.`,
                            balanceBefore,
                            balanceAfter,
                        },
                    })
                }

                // 2. Credit the admin / house wallet (SELECT FOR UPDATE)
                const adminRows = await tx.$queryRaw<Array<{ id: string; balance: Decimal }>>`
                    SELECT id, balance FROM admin_wallet LIMIT 1 FOR UPDATE
                `
                if (adminRows.length > 0) {
                    const adminWallet = adminRows[0]
                    await tx.$executeRaw`
                        UPDATE admin_wallet
                        SET balance = balance + ${houseFeeDecimal},
                            "updatedAt" = NOW()
                        WHERE id = ${adminWallet.id}
                    `
                } else {
                    // Bootstrap the singleton admin wallet if it was never seeded
                    await tx.$executeRaw`
                        INSERT INTO admin_wallet (id, balance, currency, "updatedAt")
                        VALUES (gen_random_uuid(), ${houseFeeDecimal}, 'ETB', NOW())
                    `
                }

                // 3. Mark game COMPLETED with winner
                const primaryWinnerId = winnerIds[0]
                await tx.game.update({
                    where: { id: gameId },
                    data: {
                        status: GameStatus.COMPLETED,
                        winnerId: primaryWinnerId,
                        endedAt: new Date(),
                    },
                })
            },
            {
                // Serializable isolation prevents any concurrent payout race
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            },
        )

        // ── Broadcast game_over ───────────────────────────────────────────────
        const io = getIo()
        const winnersPayload = winnerUsers.map((w) => ({
            userId: w.id,
            username: w.username,
            netWin: netWinPerPlayer,
        }))

        ;(io.to(`game:${gameId}`) as any).emit('game_over', {
            gameId,
            winners: winnersPayload,
            houseFee,
            totalPot,
        })

        // Legacy alias for existing clients
        io.to(`game:${gameId}`).emit('game:winner', {
            gameId,
            winner: winnerUsers[0] as any,
            prizeAmount: netWinPerPlayer,
        })

        io.to('lobby').emit('lobby:game-removed', gameId)

        // ── Notifications (non-critical) ─────────────────────────────────────
        await Promise.all(
            winnerUsers.map(async (w) => {
                // Get the latest transaction for this user to find the balanceAfter
                const lastTx = await prisma.transaction.findFirst({
                    where: { userId: w.id, referenceId: gameId, type: TransactionType.PRIZE_WIN },
                    orderBy: { createdAt: 'desc' }
                })
                if (lastTx) {
                    NotificationService.pushWalletUpdate(w.id, Number(lastTx.balanceAfter ?? 0))
                }

                return NotificationService.create(
                    w.id,
                    NotificationType.GAME_WON,
                    '🎉 You Won!',
                    `Congratulations! You won ${netWinPerPlayer.toFixed(2)} ETB!`,
                    { gameId, prize: netWinPerPlayer },
                ).catch(() => {})
            }),
        )

        // ── Clean up Redis ────────────────────────────────────────────────────
        await Promise.allSettled([
            clearRoomState(gameId),
            clearGameState(gameId),
        ])

        return {
            gameId,
            totalPot,
            houseFee,
            netWinPerPlayer,
            winners: winnersPayload,
            alreadyPaid: false,
        }
    }
}
