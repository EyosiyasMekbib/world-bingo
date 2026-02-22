import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TournamentService } from '../services/tournament.service'
import { prisma } from './setup'
import { TournamentStatus, PatternType, NotificationType } from '@world-bingo/shared-types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../lib/socket', () => ({
    getIo: () => ({
        to: () => ({ emit: vi.fn() }),
        emit: vi.fn(),
    }),
}))

vi.mock('../services/notification.service', () => ({
    NotificationService: {
        create: vi.fn().mockResolvedValue({ id: 'notif-1' }),
    },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createUser(username: string, phone: string, balance = 1000) {
    return prisma.user.create({
        data: {
            username,
            phone,
            passwordHash: `hashed:pass`,
            wallet: { create: { balance } },
        },
    })
}

async function createTournament(overrides: {
    maxPlayers?: number
    entryFee?: number
    status?: TournamentStatus
} = {}) {
    return prisma.tournament.create({
        data: {
            title: 'Test Tournament',
            entryFee: overrides.entryFee ?? 100,
            maxPlayers: overrides.maxPlayers ?? 4,
            status: overrides.status ?? TournamentStatus.REGISTRATION,
            houseEdgePct: 10,
        },
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TournamentService', () => {
    describe('create', () => {
        it('creates a tournament with REGISTRATION status', async () => {
            const dto = await TournamentService.create({
                title: 'Summer Bingo Cup',
                entryFee: 200,
                maxPlayers: 16,
                houseEdgePct: 10,
            })
            expect(dto.title).toBe('Summer Bingo Cup')
            expect(dto.status).toBe(TournamentStatus.REGISTRATION)
            expect(dto.entryFee).toBe(200)
            expect(dto.prizePool).toBe(0)
            expect(dto.currentPlayers).toBe(0)
        })
    })

    describe('list', () => {
        it('returns all tournaments', async () => {
            await createTournament()
            await createTournament()
            const list = await TournamentService.list()
            expect(list.length).toBe(2)
        })

        it('filters by status', async () => {
            await createTournament({ status: TournamentStatus.REGISTRATION })
            await createTournament({ status: TournamentStatus.COMPLETED })
            const open = await TournamentService.list(TournamentStatus.REGISTRATION)
            expect(open.length).toBe(1)
            expect(open[0].status).toBe(TournamentStatus.REGISTRATION)
        })
    })

    describe('getById', () => {
        it('returns tournament by id', async () => {
            const t = await createTournament()
            const dto = await TournamentService.getById(t.id)
            expect(dto.id).toBe(t.id)
        })

        it('throws if not found', async () => {
            await expect(TournamentService.getById('00000000-0000-0000-0000-000000000000'))
                .rejects.toThrow('Tournament not found')
        })
    })

    describe('register', () => {
        it('registers a player and deducts entry fee', async () => {
            const user = await createUser('alice', '+251900000001')
            const tournament = await createTournament({ entryFee: 100 })

            const entry = await TournamentService.register(tournament.id, user.id)

            expect(entry.userId).toBe(user.id)
            expect(entry.eliminated).toBe(false)

            // Verify balance deducted
            const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
            expect(Number(wallet!.balance)).toBe(900)

            // Verify prize pool grew (10% house edge → 90 ETB from 100)
            const updated = await prisma.tournament.findUnique({ where: { id: tournament.id } })
            expect(Number(updated!.prizePool)).toBeCloseTo(90, 1)
            expect(updated!.currentPlayers).toBe(1)
        })

        it('rejects if tournament is full', async () => {
            const user1 = await createUser('p1', '+251900000011')
            const user2 = await createUser('p2', '+251900000012')
            const user3 = await createUser('p3', '+251900000013')
            const tournament = await createTournament({ maxPlayers: 2, entryFee: 0 })

            await TournamentService.register(tournament.id, user1.id)
            await TournamentService.register(tournament.id, user2.id)

            await expect(TournamentService.register(tournament.id, user3.id))
                .rejects.toThrow('Tournament is full')
        })

        it('rejects duplicate registration', async () => {
            const user = await createUser('bob', '+251900000021')
            const tournament = await createTournament({ entryFee: 0 })

            await TournamentService.register(tournament.id, user.id)
            await expect(TournamentService.register(tournament.id, user.id))
                .rejects.toThrow('Already registered')
        })

        it('rejects if insufficient funds', async () => {
            const poorUser = await createUser('poor', '+251900000031', 50)
            const tournament = await createTournament({ entryFee: 100 })

            await expect(TournamentService.register(tournament.id, poorUser.id))
                .rejects.toThrow('Insufficient funds')
        })

        it('rejects registration for closed tournament', async () => {
            const user = await createUser('carol', '+251900000041')
            const tournament = await createTournament({ status: TournamentStatus.IN_PROGRESS, entryFee: 0 })

            await expect(TournamentService.register(tournament.id, user.id))
                .rejects.toThrow('Tournament registration is closed')
        })
    })

    describe('start', () => {
        it('starts a tournament and transitions to IN_PROGRESS', async () => {
            const user1 = await createUser('s1', '+251900000051', 500)
            const user2 = await createUser('s2', '+251900000052', 500)
            const tournament = await createTournament({ entryFee: 0 })

            await TournamentService.register(tournament.id, user1.id)
            await TournamentService.register(tournament.id, user2.id)

            const started = await TournamentService.start(tournament.id)
            expect(started.status).toBe(TournamentStatus.IN_PROGRESS)
            expect(started.startedAt).toBeTruthy()
        })

        it('throws if fewer than 2 players', async () => {
            const tournament = await createTournament({ entryFee: 0 })
            const user = await createUser('lonely', '+251900000061')
            await TournamentService.register(tournament.id, user.id)

            await expect(TournamentService.start(tournament.id))
                .rejects.toThrow('Need at least 2 players')
        })

        it('throws if not in REGISTRATION status', async () => {
            const tournament = await createTournament({ status: TournamentStatus.IN_PROGRESS, entryFee: 0 })
            await expect(TournamentService.start(tournament.id))
                .rejects.toThrow('not in registration state')
        })
    })

    describe('startNextRound', () => {
        it('creates a round game for all survivors', async () => {
            const user1 = await createUser('r1', '+251900000071', 500)
            const user2 = await createUser('r2', '+251900000072', 500)
            const user3 = await createUser('r3', '+251900000073', 500)
            const tournament = await createTournament({ entryFee: 0 })

            await TournamentService.register(tournament.id, user1.id)
            await TournamentService.register(tournament.id, user2.id)
            await TournamentService.register(tournament.id, user3.id)

            // Manually set to IN_PROGRESS for this test
            await prisma.tournament.update({
                where: { id: tournament.id },
                data: { status: TournamentStatus.IN_PROGRESS },
            })

            const gameId = await TournamentService.startNextRound(tournament.id)
            expect(gameId).toBeTruthy()

            const game = await prisma.game.findUnique({ where: { id: gameId } })
            expect(game).toBeTruthy()
            expect(game!.title).toContain('Round 1')
            expect(Number(game!.ticketPrice)).toBe(0) // free round game

            // Tournament round link created
            const link = await prisma.tournamentGame.findFirst({ where: { tournamentId: tournament.id } })
            expect(link!.gameId).toBe(gameId)
            expect(link!.round).toBe(1)
        })
    })

    describe('processRoundResult', () => {
        it('eliminates losers and completes tournament when one player remains', async () => {
            const user1 = await createUser('w1', '+251900000081', 500)
            const user2 = await createUser('w2', '+251900000082', 500)
            const tournament = await createTournament({ entryFee: 100 })

            await TournamentService.register(tournament.id, user1.id)
            await TournamentService.register(tournament.id, user2.id)

            await prisma.tournament.update({
                where: { id: tournament.id },
                data: { status: TournamentStatus.IN_PROGRESS },
            })

            // Create a round game manually
            const game = await prisma.game.create({
                data: {
                    title: 'Round 1',
                    status: 'WAITING' as any,
                    ticketPrice: 0,
                    maxPlayers: 2,
                    minPlayers: 2,
                    houseEdgePct: 0,
                    pattern: PatternType.ANY_LINE,
                    calledBalls: [],
                },
            })
            await prisma.tournamentGame.create({
                data: { tournamentId: tournament.id, gameId: game.id, round: 1 },
            })

            // user1 wins the round
            await TournamentService.processRoundResult(tournament.id, game.id, user1.id)

            // user2 should be eliminated
            const loserEntry = await prisma.tournamentEntry.findUnique({
                where: { tournamentId_userId: { tournamentId: tournament.id, userId: user2.id } },
            })
            expect(loserEntry!.eliminated).toBe(true)

            // Tournament should be COMPLETED with user1 as winner
            const completed = await prisma.tournament.findUnique({ where: { id: tournament.id } })
            expect(completed!.status).toBe(TournamentStatus.COMPLETED)
            expect(completed!.winnerId).toBe(user1.id)

            // user1 wallet should have prize
            const wallet = await prisma.wallet.findUnique({ where: { userId: user1.id } })
            // Started with 500, paid 100 entry fee → 400. Prize pool ~180 (90*2). Balance ~580
            expect(Number(wallet!.balance)).toBeGreaterThan(400)
        })
    })

    describe('cancel', () => {
        it('cancels tournament and refunds entry fees', async () => {
            const user1 = await createUser('c1', '+251900000091', 500)
            const user2 = await createUser('c2', '+251900000092', 500)
            const tournament = await createTournament({ entryFee: 100 })

            await TournamentService.register(tournament.id, user1.id)
            await TournamentService.register(tournament.id, user2.id)

            await TournamentService.cancel(tournament.id)

            const t = await prisma.tournament.findUnique({ where: { id: tournament.id } })
            expect(t!.status).toBe(TournamentStatus.CANCELLED)

            // Refunds should restore balance
            const w1 = await prisma.wallet.findUnique({ where: { userId: user1.id } })
            const w2 = await prisma.wallet.findUnique({ where: { userId: user2.id } })
            expect(Number(w1!.balance)).toBe(500) // 500 - 100 + 100 = 500
            expect(Number(w2!.balance)).toBe(500)
        })

        it('throws when trying to cancel a COMPLETED tournament', async () => {
            const tournament = await createTournament({ status: TournamentStatus.COMPLETED, entryFee: 0 })
            await expect(TournamentService.cancel(tournament.id))
                .rejects.toThrow('Cannot cancel a completed tournament')
        })
    })

    describe('getLeaderboard', () => {
        it('returns sorted leaderboard with ranks', async () => {
            const user1 = await createUser('lb1', '+251900000101', 500)
            const user2 = await createUser('lb2', '+251900000102', 500)
            const tournament = await createTournament({ entryFee: 0 })

            await TournamentService.register(tournament.id, user1.id)
            await TournamentService.register(tournament.id, user2.id)

            const board = await TournamentService.getLeaderboard(tournament.id)
            expect(board.length).toBe(2)
            expect(board[0].rank).toBe(1)
            expect(board[1].rank).toBe(2)
            expect(board.every((e) => typeof e.username === 'string')).toBe(true)
        })
    })
})
