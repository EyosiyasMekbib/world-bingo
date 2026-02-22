/**
 * T60 — Tournament Mode Service
 *
 * Tournament lifecycle:
 *  REGISTRATION  ─► IN_PROGRESS (admin starts it)
 *  IN_PROGRESS   ─► each round: create a bingo game, eliminated players excluded
 *  IN_PROGRESS   ─► COMPLETED  when one player remains (or last round winner wins)
 *
 * Each round:
 *  - A new bingo game (ticketPrice = 0, maxPlayers = surviving entrants) is created.
 *  - All surviving entrants are auto-joined.
 *  - When the game ends, the loser (everyone who didn't win) is eliminated.
 *  - Repeat until one player remains — that player wins the prize pool.
 */

import prisma from '../lib/prisma'
import { Prisma } from '@prisma/client'
import { getIo } from '../lib/socket'
import {
    TournamentStatus,
    NotificationType,
    PatternType,
    GameStatus,
    TransactionType,
    PaymentStatus,
} from '@world-bingo/shared-types'
import type { CreateTournamentDto, TournamentDto, TournamentEntryDto, TournamentLeaderboardEntry } from '@world-bingo/shared-types'
import { NotificationService } from './notification.service'
import { Decimal } from '@prisma/client/runtime/library'

export class TournamentService {
    // ─── Helpers ──────────────────────────────────────────────────────────────

    static toDto(t: any): TournamentDto {
        return {
            id: t.id,
            title: t.title,
            status: t.status as TournamentStatus,
            entryFee: Number(t.entryFee),
            maxPlayers: t.maxPlayers,
            currentPlayers: t.currentPlayers,
            prizePool: Number(t.prizePool),
            houseEdgePct: Number(t.houseEdgePct),
            winnerId: t.winnerId ?? null,
            rounds: t.rounds,
            scheduledAt: t.scheduledAt?.toISOString() ?? null,
            startedAt: t.startedAt?.toISOString() ?? null,
            endedAt: t.endedAt?.toISOString() ?? null,
            createdAt: t.createdAt.toISOString(),
        }
    }

    static entryToDto(e: any): TournamentEntryDto {
        return {
            id: e.id,
            tournamentId: e.tournamentId,
            userId: e.userId,
            username: e.user?.username ?? '',
            round: e.round,
            eliminated: e.eliminated,
            score: e.score,
            joinedAt: e.joinedAt.toISOString(),
        }
    }

    // ─── CRUD ─────────────────────────────────────────────────────────────────

    static async create(data: CreateTournamentDto): Promise<TournamentDto> {
        const tournament = await prisma.tournament.create({
            data: {
                title: data.title,
                entryFee: new Decimal(data.entryFee),
                maxPlayers: data.maxPlayers,
                houseEdgePct: new Decimal(data.houseEdgePct),
                scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
            },
        })
        return TournamentService.toDto(tournament)
    }

    static async list(status?: TournamentStatus): Promise<TournamentDto[]> {
        const tournaments = await prisma.tournament.findMany({
            where: status ? { status } : undefined,
            orderBy: { createdAt: 'desc' },
        })
        return tournaments.map(TournamentService.toDto)
    }

    static async getById(id: string): Promise<TournamentDto> {
        const tournament = await prisma.tournament.findUnique({ where: { id } })
        if (!tournament) throw new Error('Tournament not found')
        return TournamentService.toDto(tournament)
    }

    static async getLeaderboard(tournamentId: string): Promise<TournamentLeaderboardEntry[]> {
        const entries = await prisma.tournamentEntry.findMany({
            where: { tournamentId },
            include: { user: { select: { username: true } } },
            orderBy: [{ eliminated: 'asc' }, { score: 'desc' }],
        })
        return entries.map((e: any, idx: number) => ({
            rank: idx + 1,
            userId: e.userId,
            username: e.user.username,
            score: e.score,
            eliminated: e.eliminated,
        }))
    }

    // ─── Registration ─────────────────────────────────────────────────────────

    static async register(tournamentId: string, userId: string): Promise<TournamentEntryDto> {
        return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            const tournament = await tx.tournament.findUnique({ where: { id: tournamentId } })
            if (!tournament) throw new Error('Tournament not found')
            if (tournament.status !== TournamentStatus.REGISTRATION) {
                throw new Error('Tournament registration is closed')
            }
            if (tournament.currentPlayers >= tournament.maxPlayers) {
                throw new Error('Tournament is full')
            }

            // Check not already registered
            const existing = await tx.tournamentEntry.findUnique({
                where: { tournamentId_userId: { tournamentId, userId } },
            })
            if (existing) throw new Error('Already registered for this tournament')

            const entryFee = new Decimal(tournament.entryFee)

            // Deduct entry fee from wallet
            if (entryFee.gt(0)) {
                const wallets = await tx.$queryRaw<Array<{ id: string; balance: Decimal }>>`
                    SELECT id, balance FROM wallets WHERE "userId" = ${userId} FOR UPDATE
                `
                const wallet = wallets[0]
                if (!wallet || new Decimal(wallet.balance).lessThan(entryFee)) {
                    throw new Error('Insufficient funds')
                }
                await tx.wallet.update({
                    where: { userId },
                    data: { balance: { decrement: entryFee } },
                })
                await tx.transaction.create({
                    data: {
                        userId,
                        type: TransactionType.GAME_ENTRY,
                        amount: entryFee,
                        status: PaymentStatus.APPROVED,
                        referenceId: tournamentId,
                        balanceBefore: new Decimal(wallet.balance),
                        balanceAfter: new Decimal(wallet.balance).minus(entryFee),
                    },
                })
            }

            // Add entry + grow prize pool + increment player count
            const houseEdge = Number(tournament.houseEdgePct) / 100
            const contribution = entryFee.times(1 - houseEdge)
            const entry = await tx.tournamentEntry.create({
                data: { tournamentId, userId },
                include: { user: { select: { username: true } } },
            })
            await tx.tournament.update({
                where: { id: tournamentId },
                data: {
                    currentPlayers: { increment: 1 },
                    prizePool: { increment: contribution },
                },
            })

            return TournamentService.entryToDto(entry)
        })
    }

    // ─── Admin: Start Tournament ───────────────────────────────────────────────

    static async start(tournamentId: string): Promise<TournamentDto> {
        const tournament = await prisma.tournament.findUnique({
            where: { id: tournamentId },
            include: { entries: { include: { user: { select: { id: true, username: true } } } } },
        })
        if (!tournament) throw new Error('Tournament not found')
        if (tournament.status !== TournamentStatus.REGISTRATION) {
            throw new Error('Tournament is not in registration state')
        }
        if (tournament.entries.length < 2) {
            throw new Error('Need at least 2 players to start a tournament')
        }

        const updated = await prisma.tournament.update({
            where: { id: tournamentId },
            data: { status: TournamentStatus.IN_PROGRESS, startedAt: new Date() },
        })

        // Notify all registered players
        await Promise.all(
            tournament.entries.map((e: any) =>
                NotificationService.create(
                    e.userId,
                    NotificationType.TOURNAMENT_STARTING,
                    '🏆 Tournament Starting!',
                    `${tournament.title} has started! Check the tournament lobby.`,
                    { tournamentId },
                ).catch(() => {}),
            ),
        )

        const io = getIo()
        io.to('lobby').emit('tournament:updated', {
            tournamentId,
            status: TournamentStatus.IN_PROGRESS,
            currentPlayers: tournament.currentPlayers,
            prizePool: Number(tournament.prizePool),
        })

        // Kick off Round 1 automatically
        await TournamentService.startNextRound(tournamentId).catch((err) => {
            console.error('[TournamentService] Failed to start round 1:', err)
        })

        return TournamentService.toDto(updated)
    }

    // ─── Round Management ─────────────────────────────────────────────────────

    /**
     * Creates the next round game and auto-joins all surviving players.
     * Returns the created game id.
     */
    static async startNextRound(tournamentId: string): Promise<string> {
        const tournament = await prisma.tournament.findUnique({
            where: { id: tournamentId },
            include: {
                entries: {
                    where: { eliminated: false },
                    include: { user: { select: { id: true, username: true } } },
                },
                tournamentGames: { orderBy: { round: 'desc' }, take: 1 },
            },
        })
        if (!tournament) throw new Error('Tournament not found')
        if (tournament.status !== TournamentStatus.IN_PROGRESS) {
            throw new Error('Tournament is not in progress')
        }

        const survivors = tournament.entries
        if (survivors.length === 0) throw new Error('No surviving players')
        if (survivors.length === 1) {
            // Only one player left — they are the winner
            await TournamentService.complete(tournamentId, survivors[0].userId)
            return ''
        }

        const nextRound = (tournament.tournamentGames[0]?.round ?? 0) + 1

        // Create a free internal game for this tournament round
        const game = await prisma.game.create({
            data: {
                title: `${tournament.title} — Round ${nextRound}`,
                status: GameStatus.WAITING,
                ticketPrice: new Decimal(0),
                maxPlayers: survivors.length,
                minPlayers: 2,
                houseEdgePct: new Decimal(0),
                pattern: PatternType.ANY_LINE,
                calledBalls: [],
            },
        })

        // Link game to tournament
        await prisma.tournamentGame.create({
            data: { tournamentId, gameId: game.id, round: nextRound },
        })

        await prisma.tournament.update({
            where: { id: tournamentId },
            data: { rounds: nextRound },
        })

        const io = getIo()
        io.to(`tournament:${tournamentId}`).emit('tournament:round-started', {
            tournamentId,
            round: nextRound,
            gameId: game.id,
        })

        // Notify survivors
        await Promise.all(
            survivors.map((e: any) =>
                NotificationService.create(
                    e.userId,
                    NotificationType.TOURNAMENT_STARTING,
                    `🏆 Round ${nextRound} Starting!`,
                    `Your tournament round ${nextRound} game is ready. Join now!`,
                    { tournamentId, gameId: game.id, round: nextRound },
                ).catch(() => {}),
            ),
        )

        return game.id
    }

    /**
     * Called after a tournament round game completes (the game's winner is known).
     * Eliminates all players who were in this round's game except the winner,
     * then checks if the tournament is over.
     */
    static async processRoundResult(tournamentId: string, gameId: string, winnerId: string): Promise<void> {
        const tournament = await prisma.tournament.findUnique({
            where: { id: tournamentId },
            include: {
                entries: {
                    where: { eliminated: false },
                    include: { user: { select: { id: true, username: true } } },
                },
            },
        })
        if (!tournament || tournament.status !== TournamentStatus.IN_PROGRESS) return

        const survivors = tournament.entries
        const losers = survivors.filter((e: any) => e.userId !== winnerId)

        if (losers.length === 0) {
            // Only one player remained — shouldn't normally happen, handle gracefully
            await TournamentService.complete(tournamentId, winnerId)
            return
        }

        // Eliminate losers
        await prisma.tournamentEntry.updateMany({
            where: { tournamentId, userId: { in: losers.map((l: any) => l.userId) } },
            data: { eliminated: true, eliminatedAt: new Date() },
        })

        // Update winner score
        await prisma.tournamentEntry.updateMany({
            where: { tournamentId, userId: winnerId },
            data: { score: { increment: 1 } },
        })

        // Notify losers
        const io = getIo()
        await Promise.all(
            losers.map(async (loser: any) => {
                io.to(`user:${loser.userId}`).emit('tournament:eliminated', {
                    tournamentId,
                    userId: loser.userId,
                })
                await NotificationService.create(
                    loser.userId,
                    NotificationType.TOURNAMENT_ELIMINATED,
                    '🏳️ Eliminated',
                    `You were eliminated from ${tournament.title}.`,
                    { tournamentId },
                ).catch(() => {})
            }),
        )

        // Check remaining survivors
        const remainingCount = survivors.length - losers.length
        if (remainingCount <= 1) {
            // Tournament over!
            await TournamentService.complete(tournamentId, winnerId)
        } else {
            // Start next round
            await TournamentService.startNextRound(tournamentId).catch((err) => {
                console.error('[TournamentService] Failed to advance round:', err)
            })
        }
    }

    // ─── Completion ───────────────────────────────────────────────────────────

    static async complete(tournamentId: string, winnerId: string): Promise<void> {
        const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId } })
        if (!tournament) return

        const prizePool = Number(tournament.prizePool)

        // Credit winner wallet
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            const wallets = await tx.$queryRaw<Array<{ id: string; balance: Decimal }>>`
                SELECT id, balance FROM wallets WHERE "userId" = ${winnerId} FOR UPDATE
            `
            const wallet = wallets[0]
            const balanceBefore = wallet ? new Decimal(wallet.balance) : new Decimal(0)
            const balanceAfter = balanceBefore.plus(prizePool)

            await tx.wallet.update({
                where: { userId: winnerId },
                data: { balance: { increment: prizePool } },
            })
            await tx.transaction.create({
                data: {
                    userId: winnerId,
                    type: TransactionType.PRIZE_WIN,
                    amount: new Decimal(prizePool),
                    status: PaymentStatus.APPROVED,
                    referenceId: tournamentId,
                    balanceBefore,
                    balanceAfter,
                },
            })
            await tx.tournament.update({
                where: { id: tournamentId },
                data: {
                    status: TournamentStatus.COMPLETED,
                    winnerId,
                    endedAt: new Date(),
                },
            })
        })

        const winner = await prisma.user.findUnique({ where: { id: winnerId } })
        const io = getIo()
        io.to('lobby').emit('tournament:winner', {
            tournamentId,
            winnerId,
            username: winner?.username ?? '',
            prizeAmount: prizePool,
        })
        io.to(`tournament:${tournamentId}`).emit('tournament:winner', {
            tournamentId,
            winnerId,
            username: winner?.username ?? '',
            prizeAmount: prizePool,
        })

        await NotificationService.create(
            winnerId,
            NotificationType.TOURNAMENT_WON,
            '🏆 You Won the Tournament!',
            `Congratulations! You won ${prizePool.toFixed(2)} ETB in ${tournament.title}!`,
            { tournamentId, prizePool },
        ).catch(() => {})
    }

    // ─── Cancel ───────────────────────────────────────────────────────────────

    static async cancel(tournamentId: string): Promise<void> {
        const tournament = await prisma.tournament.findUnique({
            where: { id: tournamentId },
            include: { entries: true },
        })
        if (!tournament) throw new Error('Tournament not found')
        if (tournament.status === TournamentStatus.COMPLETED) {
            throw new Error('Cannot cancel a completed tournament')
        }

        await prisma.tournament.update({
            where: { id: tournamentId },
            data: { status: TournamentStatus.CANCELLED, endedAt: new Date() },
        })

        // Refund all entry fees
        if (Number(tournament.entryFee) > 0) {
            await Promise.all(
                tournament.entries.map((entry: any) =>
                    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
                        await tx.wallet.update({
                            where: { userId: entry.userId },
                            data: { balance: { increment: tournament.entryFee } },
                        })
                        await tx.transaction.create({
                            data: {
                                userId: entry.userId,
                                type: TransactionType.REFUND,
                                amount: tournament.entryFee,
                                status: PaymentStatus.APPROVED,
                                referenceId: tournamentId,
                            },
                        })
                    }).catch(() => {}),
                ),
            )
        }

        const io = getIo()
        io.to('lobby').emit('tournament:updated', {
            tournamentId,
            status: TournamentStatus.CANCELLED,
            currentPlayers: tournament.currentPlayers,
            prizePool: Number(tournament.prizePool),
        })
    }
}
