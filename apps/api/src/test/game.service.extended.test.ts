/**
 * Comprehensive Game Service Tests
 *
 * Extended unit tests covering edge cases for the full game lifecycle:
 * joining, starting, cancellation, auto-cancel, and bingo claiming.
 *
 * Run with: pnpm --filter @world-bingo/api test
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { GameService } from '../services/game.service'
import { prisma } from './setup'
import { GameStatus, PatternType, NotificationType, PaymentStatus, TransactionType } from '@world-bingo/shared-types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../lib/socket', () => ({
    getIo: () => ({
        to: () => ({ emit: vi.fn() }),
    }),
}))

vi.mock('../lib/game-engine', () => ({
    startGameEngine: vi.fn().mockResolvedValue(undefined),
    stopGameEngine: vi.fn(),
    isEngineActive: vi.fn().mockReturnValue(false),
    stopAllEngines: vi.fn(),
}))

vi.mock('../lib/game-state', () => ({
    initGameState: vi.fn().mockResolvedValue(undefined),
    clearGameState: vi.fn().mockResolvedValue(undefined),
    addCalledBall: vi.fn().mockResolvedValue(undefined),
    getCalledBalls: vi.fn().mockResolvedValue([]),
    getGameState: vi.fn().mockResolvedValue(null),
}))

vi.mock('../lib/redis', () => {
    const mockRedis = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        sadd: vi.fn().mockResolvedValue(1),
        srem: vi.fn().mockResolvedValue(1),
        scard: vi.fn().mockResolvedValue(1),
        smembers: vi.fn().mockResolvedValue([]),
        incrby: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
    }
    return {
        default: mockRedis,
        redis: mockRedis,
        getRedis: () => mockRedis,
    }
})

vi.mock('../services/notification.service', () => ({
    NotificationService: {
        create: vi.fn().mockResolvedValue({ id: 'notif-1' }),
        pushWalletUpdate: vi.fn(),
    },
}))

vi.mock('../services/refund.service', () => ({
    RefundService: {
        refundGame: vi.fn().mockResolvedValue([]),
    },
}))

vi.mock('../services/jackpot.service', () => ({
    JackpotService: {
        contribute: vi.fn().mockResolvedValue(undefined),
        isJackpotEligible: vi.fn().mockReturnValue(false),
        awardJackpot: vi.fn().mockResolvedValue(undefined),
    },
}))

vi.mock('../services/tournament.service', () => ({
    TournamentService: {
        processRoundResult: vi.fn().mockResolvedValue(undefined),
    },
}))

const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' })
vi.mock('../lib/queue', () => ({
    getQueue: vi.fn(() => ({
        add: mockQueueAdd,
    })),
    QUEUE_NAMES: {
        REFUND: 'refund',
        NOTIFICATION: 'notification',
        WITHDRAWAL: 'withdrawal',
        GAME_ENGINE: 'game-engine',
    },
}))

// ── Test Helpers ───────────────────────────────────────────────────────────────

async function createUserWithWallet(username: string, phone: string, balance = 500) {
    return prisma.user.create({
        data: {
            username,
            phone,
            passwordHash: `hashed:pass`,
            wallet: { create: { realBalance: balance } },
        },
    })
}

async function createGame(overrides: Partial<{
    status: string
    minPlayers: number
    maxPlayers: number
    ticketPrice: number
    houseEdgePct: number
    pattern: string
    calledBalls: number[]
}> = {}) {
    return prisma.game.create({
        data: {
            title: 'Test Game',
            status: (overrides.status ?? GameStatus.WAITING) as GameStatus,
            ticketPrice: overrides.ticketPrice ?? 50,
            maxPlayers: overrides.maxPlayers ?? 10,
            minPlayers: overrides.minPlayers ?? 2,
            houseEdgePct: overrides.houseEdgePct ?? 10,
            pattern: (overrides.pattern ?? PatternType.ANY_LINE) as PatternType,
            calledBalls: overrides.calledBalls ?? [],
        },
    })
}

async function createCartela(serial: string, grid?: number[][]) {
    return prisma.cartela.create({
        data: {
            serial,
            grid: grid ?? [
                [1, 16, 31, 46, 61],
                [2, 17, 32, 47, 62],
                [3, 18, 0, 48, 63],
                [4, 19, 34, 49, 64],
                [5, 20, 35, 50, 65],
            ],
        },
    })
}

// ─── JoinGame — Extended Tests ────────────────────────────────────────────────

describe('GameService.joinGame — Extended', () => {
    let userId: string
    let gameId: string

    beforeEach(async () => {
        const user = await createUserWithWallet('ext_join_user', '+251910100001')
        userId = user.id
        const game = await createGame()
        gameId = game.id
    })

    it('should create a transaction record of type GAME_ENTRY', async () => {
        const c = await createCartela('TX-C1')
        await GameService.joinGame(userId, gameId, [c.serial])

        const tx = await prisma.transaction.findFirst({
            where: { userId, type: TransactionType.GAME_ENTRY },
        })
        expect(tx).toBeTruthy()
        expect(Number(tx!.amount)).toBe(50) // ticketPrice
        expect(tx!.status).toBe(PaymentStatus.APPROVED)
        expect(tx!.referenceId).toBe(gameId)
    })

    it('should record correct balanceBefore and balanceAfter', async () => {
        const c = await createCartela('BAL-C1')
        await GameService.joinGame(userId, gameId, [c.serial])

        const tx = await prisma.transaction.findFirst({
            where: { userId, type: TransactionType.GAME_ENTRY },
        })
        expect(Number(tx!.balanceBefore)).toBe(500)
        expect(Number(tx!.balanceAfter)).toBe(450)
    })

    it('should throw if cartela serial does not exist', async () => {
        await expect(
            GameService.joinGame(userId, gameId, ['NONEXISTENT-SERIAL']),
        ).rejects.toThrow('One or more cartela serials are invalid')
    })

    it('should throw with empty cartelaSerials array', async () => {
        await expect(
            GameService.joinGame(userId, gameId, []),
        ).rejects.toThrow('At least one cartela is required')
    })

    it('should throw if game does not exist', async () => {
        const c = await createCartela('GHOST-C1')
        await expect(
            GameService.joinGame(userId, 'non-existent-game-id', [c.serial]),
        ).rejects.toThrow('Game not found')
    })

    it('should not allow the same user to join with the same cartela twice', async () => {
        const c = await createCartela('DOUBLE-C1')
        await GameService.joinGame(userId, gameId, [c.serial])

        await expect(
            GameService.joinGame(userId, gameId, [c.serial]),
        ).rejects.toThrow('One or more selected cartelas are already taken')
    })

    it('should allow the same user to join with different cartelas', async () => {
        const c1 = await createCartela('MULTI-C1')
        const c2 = await createCartela('MULTI-C2')

        const entries1 = await GameService.joinGame(userId, gameId, [c1.serial])
        expect(entries1).toHaveLength(1)

        // Second join with different cartela
        const entries2 = await GameService.joinGame(userId, gameId, [c2.serial])
        expect(entries2).toHaveLength(1)

        // Total entries for this user
        const allEntries = await prisma.gameEntry.findMany({
            where: { gameId, userId },
        })
        expect(allEntries).toHaveLength(2)
    })

    it('should deduct exact multi-cartela cost', async () => {
        const c1 = await createCartela('MCOST-C1')
        const c2 = await createCartela('MCOST-C2')
        const c3 = await createCartela('MCOST-C3')

        await GameService.joinGame(userId, gameId, [c1.serial, c2.serial, c3.serial])

        const wallet = await prisma.wallet.findUnique({ where: { userId } })
        // 500 - (50 * 3) = 350
        expect(Number(wallet!.realBalance)).toBe(350)
    })

    it('should throw if balance is exactly 0', async () => {
        const poorUser = await createUserWithWallet('zero_bal', '+251910100010', 0)
        const c = await createCartela('ZERO-C1')

        await expect(
            GameService.joinGame(poorUser.id, gameId, [c.serial]),
        ).rejects.toThrow('Insufficient funds')
    })

    it('should succeed if balance is exactly equal to the cost', async () => {
        const exactUser = await createUserWithWallet('exact_bal', '+251910100011', 50)
        const c = await createCartela('EXACT-C1')

        const entries = await GameService.joinGame(exactUser.id, gameId, [c.serial])
        expect(entries).toHaveLength(1)

        const wallet = await prisma.wallet.findUnique({ where: { userId: exactUser.id } })
        expect(Number(wallet!.realBalance)).toBe(0)
    })

    it('should throw for COMPLETED game status', async () => {
        const completedGame = await createGame({ status: GameStatus.COMPLETED })
        const c = await createCartela('COMP-C1')

        await expect(
            GameService.joinGame(userId, completedGame.id, [c.serial]),
        ).rejects.toThrow('Game is already in progress or finished')
    })

    it('should throw for CANCELLED game status', async () => {
        const cancelledGame = await createGame({ status: GameStatus.CANCELLED })
        const c = await createCartela('CANC-C1')

        await expect(
            GameService.joinGame(userId, cancelledGame.id, [c.serial]),
        ).rejects.toThrow('Game is already in progress or finished')
    })

    it('should include cartela data in returned entries', async () => {
        const c = await createCartela('INC-C1')
        const entries = await GameService.joinGame(userId, gameId, [c.serial])

        expect(entries[0].cartela).toBeTruthy()
        expect(entries[0].cartela.serial).toBe('INC-C1')
    })
})

// ─── JoinGame — Bonus-First Deduction ────────────────────────────────────────

describe('GameService.joinGame — bonus-first deduction', () => {
    let gameId: string

    beforeEach(async () => {
        const game = await createGame({ ticketPrice: 50 })
        gameId = game.id
    })

    it('should deduct bonus balance before real balance', async () => {
        // User has 100 bonus + 500 real. Cost = 50.
        const user = await prisma.user.create({
            data: {
                username: 'bonus_first_1',
                phone: '+251911100001',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 500, bonusBalance: 100 } },
            },
        })
        const c = await createCartela('BF-C1')
        await GameService.joinGame(user.id, gameId, [c.serial])

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        expect(Number(wallet!.bonusBalance)).toBe(50)  // 100 - 50 (full cost from bonus)
        expect(Number(wallet!.realBalance)).toBe(500)  // untouched
    })

    it('should use real balance when bonus is partially exhausted', async () => {
        // User has 30 bonus + 500 real. Cost = 50.
        const user = await prisma.user.create({
            data: {
                username: 'bonus_first_2',
                phone: '+251911100002',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 500, bonusBalance: 30 } },
            },
        })
        const c = await createCartela('BF-C2')
        await GameService.joinGame(user.id, gameId, [c.serial])

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        expect(Number(wallet!.bonusBalance)).toBe(0)   // 30 - 30 (all bonus consumed)
        expect(Number(wallet!.realBalance)).toBe(480)  // 500 - 20 (remaining cost)
    })

    it('should record correct bonus balance snapshots in GAME_ENTRY transaction', async () => {
        const user = await prisma.user.create({
            data: {
                username: 'bonus_snap',
                phone: '+251911100003',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 500, bonusBalance: 100 } },
            },
        })
        const c = await createCartela('BF-C3')
        await GameService.joinGame(user.id, gameId, [c.serial])

        const tx = await prisma.transaction.findFirst({
            where: { userId: user.id, type: TransactionType.GAME_ENTRY },
        })
        expect(tx).not.toBeNull()
        expect(Number(tx!.bonusBalanceBefore)).toBe(100)
        expect(Number(tx!.bonusBalanceAfter)).toBe(50)  // 100 - 50
        expect(Number(tx!.balanceBefore)).toBe(500)     // real untouched
        expect(Number(tx!.balanceAfter)).toBe(500)
    })

    it('should succeed using only bonus balance when real balance is 0', async () => {
        // User has 0 real + 200 bonus. Cost = 50.
        const user = await prisma.user.create({
            data: {
                username: 'bonus_only',
                phone: '+251911100004',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 0, bonusBalance: 200 } },
            },
        })
        const c = await createCartela('BF-C4')

        const entries = await GameService.joinGame(user.id, gameId, [c.serial])
        expect(entries).toHaveLength(1)

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        expect(Number(wallet!.bonusBalance)).toBe(150)
        expect(Number(wallet!.realBalance)).toBe(0)
    })

    it('should fail when combined real + bonus is less than cost', async () => {
        const user = await prisma.user.create({
            data: {
                username: 'bonus_poor',
                phone: '+251911100005',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 20, bonusBalance: 20 } },
            },
        })
        const c = await createCartela('BF-C5')

        // Total available = 40, cost = 50 → insufficient
        await expect(
            GameService.joinGame(user.id, gameId, [c.serial]),
        ).rejects.toThrow('Insufficient funds')
    })
})

// ─── StartGame — Extended Tests ───────────────────────────────────────────────

describe('GameService.startGame — Extended', () => {
    it('should set startedAt timestamp', async () => {
        const game = await createGame({ minPlayers: 1 })
        const user = await createUserWithWallet('start_ts', '+251910200001')
        const c = await createCartela('START-TS-C1')
        await GameService.joinGame(user.id, game.id, [c.serial])

        const result = await GameService.startGame(game.id)
        expect(result.startedAt).toBeTruthy()
    })

    it('should send GAME_STARTING notifications to all participants', async () => {
        const game = await createGame({ minPlayers: 1 })
        const user = await createUserWithWallet('start_notif', '+251910200002')
        const c = await createCartela('START-NOTIF-C1')
        await GameService.joinGame(user.id, game.id, [c.serial])

        const { NotificationService } = await import('../services/notification.service')

        await GameService.startGame(game.id)

        expect(NotificationService.create).toHaveBeenCalledWith(
            user.id,
            NotificationType.GAME_STARTING,
            'Game Starting!',
            expect.stringContaining('starting'),
            expect.objectContaining({ gameId: game.id }),
        )
    })

    it('should enqueue game engine job with 5-second delay', async () => {
        mockQueueAdd.mockClear()

        const game = await createGame({ minPlayers: 1 })
        const user = await createUserWithWallet('start_queue', '+251910200003')
        const c = await createCartela('START-Q-C1')
        await GameService.joinGame(user.id, game.id, [c.serial])

        await GameService.startGame(game.id)

        expect(mockQueueAdd).toHaveBeenCalledWith(
            `start-game-${game.id}`,
            { gameId: game.id, action: 'start' },
            expect.objectContaining({
                delay: 5_000,
                attempts: 2,
            }),
        )
    })

    it('should not start an already STARTING game from COMPLETED state', async () => {
        const game = await createGame({ status: GameStatus.COMPLETED })
        await expect(GameService.startGame(game.id)).rejects.toThrow('not in a startable state')
    })

    it('should not start a CANCELLED game', async () => {
        const game = await createGame({ status: GameStatus.CANCELLED })
        await expect(GameService.startGame(game.id)).rejects.toThrow('not in a startable state')
    })

    it('should throw for non-existent game', async () => {
        await expect(GameService.startGame('nonexistent-game')).rejects.toThrow('Game not found')
    })
})

// ─── CancelGame — Extended Tests ──────────────────────────────────────────────

describe('GameService.cancelGame — Extended', () => {
    it('should set endedAt timestamp', async () => {
        const game = await createGame()
        await GameService.cancelGame(game.id)

        const updated = await prisma.game.findUnique({ where: { id: game.id } })
        expect(updated!.endedAt).toBeTruthy()
    })

    it('should call stopGameEngine with the game ID', async () => {
        const game = await createGame()
        const { stopGameEngine } = await import('../lib/game-engine')

        await GameService.cancelGame(game.id)
        expect(stopGameEngine).toHaveBeenCalledWith(game.id)
    })

    it('should call clearGameState with the game ID', async () => {
        const game = await createGame()
        const { clearGameState } = await import('../lib/game-state')

        await GameService.cancelGame(game.id)
        expect(clearGameState).toHaveBeenCalledWith(game.id)
    })

    it('should handle cancellation of IN_PROGRESS game', async () => {
        const game = await createGame({ status: GameStatus.IN_PROGRESS })
        await GameService.cancelGame(game.id)

        const updated = await prisma.game.findUnique({ where: { id: game.id } })
        expect(updated!.status).toBe(GameStatus.CANCELLED)
    })

    it('should handle cancellation of STARTING game', async () => {
        const game = await createGame({ status: GameStatus.STARTING })
        await GameService.cancelGame(game.id)

        const updated = await prisma.game.findUnique({ where: { id: game.id } })
        expect(updated!.status).toBe(GameStatus.CANCELLED)
    })

    it('should not refund players who were not refunded', async () => {
        const { RefundService } = await import('../services/refund.service')
        const { NotificationService } = await import('../services/notification.service')

        vi.mocked(RefundService.refundGame).mockResolvedValueOnce([
            { userId: 'u1', amount: 50, alreadyRefunded: true },
        ])

        const game = await createGame()
        vi.mocked(NotificationService.create).mockClear()

        await GameService.cancelGame(game.id)

        // Should NOT send notification for already-refunded users
        expect(NotificationService.create).not.toHaveBeenCalledWith(
            'u1',
            NotificationType.GAME_CANCELLED,
            expect.anything(),
            expect.anything(),
            expect.anything(),
        )
    })
})

// ─── AutoCancel — Extended Tests ──────────────────────────────────────────────

describe('GameService.autoCancelIfUnderFilled — Extended', () => {
    it('should cancel when 0 players joined', async () => {
        const game = await createGame({ minPlayers: 2 })
        await GameService.autoCancelIfUnderFilled(game.id)

        const updated = await prisma.game.findUnique({ where: { id: game.id } })
        expect(updated!.status).toBe(GameStatus.CANCELLED)
    })

    it('should cancel when exactly minPlayers - 1 joined', async () => {
        const game = await createGame({ minPlayers: 3 })
        const u1 = await createUserWithWallet('ac_u1', '+251910300001')
        const u2 = await createUserWithWallet('ac_u2', '+251910300002')
        const c1 = await createCartela('AC-C1')
        const c2 = await createCartela('AC-C2')

        await GameService.joinGame(u1.id, game.id, [c1.serial])
        await GameService.joinGame(u2.id, game.id, [c2.serial])

        // 2 players, minPlayers = 3
        await GameService.autoCancelIfUnderFilled(game.id)

        const updated = await prisma.game.findUnique({ where: { id: game.id } })
        expect(updated!.status).toBe(GameStatus.CANCELLED)
    })

    it('should NOT cancel when exactly minPlayers joined', async () => {
        const game = await createGame({ minPlayers: 2 })
        const u1 = await createUserWithWallet('ac_ok_u1', '+251910300010')
        const u2 = await createUserWithWallet('ac_ok_u2', '+251910300011')
        const c1 = await createCartela('AC-OK-C1')
        const c2 = await createCartela('AC-OK-C2')

        await GameService.joinGame(u1.id, game.id, [c1.serial])
        await GameService.joinGame(u2.id, game.id, [c2.serial])

        await GameService.autoCancelIfUnderFilled(game.id)

        const updated = await prisma.game.findUnique({ where: { id: game.id } })
        expect(updated!.status).toBe(GameStatus.WAITING)
    })

    it('should NOT cancel when more than minPlayers joined', async () => {
        const game = await createGame({ minPlayers: 2 })
        const u1 = await createUserWithWallet('ac_more_u1', '+251910300020')
        const u2 = await createUserWithWallet('ac_more_u2', '+251910300021')
        const u3 = await createUserWithWallet('ac_more_u3', '+251910300022')
        const c1 = await createCartela('AC-MORE-C1')
        const c2 = await createCartela('AC-MORE-C2')
        const c3 = await createCartela('AC-MORE-C3')

        await GameService.joinGame(u1.id, game.id, [c1.serial])
        await GameService.joinGame(u2.id, game.id, [c2.serial])
        await GameService.joinGame(u3.id, game.id, [c3.serial])

        await GameService.autoCancelIfUnderFilled(game.id)

        const updated = await prisma.game.findUnique({ where: { id: game.id } })
        expect(updated!.status).toBe(GameStatus.WAITING)
    })
})

// ─── ClaimBingo — Edge Cases ──────────────────────────────────────────────────

describe('GameService.claimBingo — Edge Cases', () => {
    it('should throw if game is not IN_PROGRESS', async () => {
        const game = await createGame({ status: GameStatus.WAITING })
        const user = await createUserWithWallet('claim_wait', '+251910400001')
        const c = await createCartela('CLAIM-WAIT-C1')
        await GameService.joinGame(user.id, game.id, [c.serial])

        await expect(
            GameService.claimBingo(user.id, game.id, c.id),
        ).rejects.toThrow('Game not active')
    })

    it('should throw if user does not have entry for this cartela', async () => {
        const game = await createGame({ status: GameStatus.IN_PROGRESS })
        const user = await createUserWithWallet('claim_noentry', '+251910400002')
        const c = await createCartela('CLAIM-NOENTRY-C1')

        // User has not joined — no entry
        await expect(
            GameService.claimBingo(user.id, game.id, c.id),
        ).rejects.toThrow('Invalid entry')
    })

    it('should throw "False Bingo!" when pattern is not complete', async () => {
        // Create a game in progress with no balls called
        const game = await createGame({
            status: GameStatus.IN_PROGRESS,
            calledBalls: [], // No balls called
        })
        const user = await createUserWithWallet('claim_false', '+251910400003')
        const c = await createCartela('CLAIM-FALSE-C1')

        // Manually create game entry (game is already IN_PROGRESS so joinGame won't work)
        await prisma.gameEntry.create({
            data: { gameId: game.id, userId: user.id, cartelaId: c.id },
        })

        await expect(
            GameService.claimBingo(user.id, game.id, c.id),
        ).rejects.toThrow('False Bingo!')
    })

    it('should succeed and mark winner when pattern is complete (ANY_LINE row 1)', async () => {
        // Row 1 of our default cartela: [1, 16, 31, 46, 61]
        const calledBalls = [1, 16, 31, 46, 61]
        const game = await createGame({
            status: GameStatus.IN_PROGRESS,
            pattern: PatternType.ANY_LINE,
            calledBalls,
        })
        const user = await createUserWithWallet('claim_win', '+251910400004', 1000)
        const c = await createCartela('CLAIM-WIN-C1')

        // Create entry manually since game is IN_PROGRESS
        await prisma.gameEntry.create({
            data: { gameId: game.id, userId: user.id, cartelaId: c.id },
        })

        const result = await GameService.claimBingo(user.id, game.id, c.id)
        expect(result.status).toBe(GameStatus.COMPLETED)
        expect(result.winnerId).toBe(user.id)
    })

    it('should credit prize to winner wallet', async () => {
        const calledBalls = [1, 16, 31, 46, 61]
        const game = await createGame({
            status: GameStatus.IN_PROGRESS,
            pattern: PatternType.ANY_LINE,
            calledBalls,
            ticketPrice: 100,
            houseEdgePct: 10,
        })
        const user = await createUserWithWallet('claim_prize', '+251910400005', 1000)
        const c = await createCartela('CLAIM-PRIZE-C1')

        await prisma.gameEntry.create({
            data: { gameId: game.id, userId: user.id, cartelaId: c.id },
        })

        await GameService.claimBingo(user.id, game.id, c.id)

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        // Prize = 100 * 1 entry * (1 - 0.10) = 90
        expect(Number(wallet!.realBalance)).toBe(1000 + 90)
    })

    it('should create a PRIZE_WIN transaction', async () => {
        const calledBalls = [1, 16, 31, 46, 61]
        const game = await createGame({
            status: GameStatus.IN_PROGRESS,
            pattern: PatternType.ANY_LINE,
            calledBalls,
        })
        const user = await createUserWithWallet('claim_tx', '+251910400006', 500)
        const c = await createCartela('CLAIM-TX-C1')

        await prisma.gameEntry.create({
            data: { gameId: game.id, userId: user.id, cartelaId: c.id },
        })

        await GameService.claimBingo(user.id, game.id, c.id)

        const tx = await prisma.transaction.findFirst({
            where: { userId: user.id, type: TransactionType.PRIZE_WIN },
        })
        expect(tx).toBeTruthy()
        expect(tx!.referenceId).toBe(game.id)
    })

    it('should send GAME_WON notification to winner', async () => {
        const calledBalls = [1, 16, 31, 46, 61]
        const game = await createGame({
            status: GameStatus.IN_PROGRESS,
            pattern: PatternType.ANY_LINE,
            calledBalls,
        })
        const user = await createUserWithWallet('claim_notif', '+251910400007', 500)
        const c = await createCartela('CLAIM-NOTIF-C1')

        await prisma.gameEntry.create({
            data: { gameId: game.id, userId: user.id, cartelaId: c.id },
        })

        const { NotificationService } = await import('../services/notification.service')
        vi.mocked(NotificationService.create).mockClear()

        await GameService.claimBingo(user.id, game.id, c.id)

        // Wait for post-transaction promises
        await new Promise((r) => setTimeout(r, 100))

        expect(NotificationService.create).toHaveBeenCalledWith(
            user.id,
            NotificationType.GAME_WON,
            '🎉 You Won!',
            expect.stringContaining('Congratulations'),
            expect.objectContaining({ gameId: game.id }),
        )
    })

    it('should stop the game engine on bingo claim', async () => {
        const calledBalls = [1, 16, 31, 46, 61]
        const game = await createGame({
            status: GameStatus.IN_PROGRESS,
            pattern: PatternType.ANY_LINE,
            calledBalls,
        })
        const user = await createUserWithWallet('claim_stop', '+251910400008', 500)
        const c = await createCartela('CLAIM-STOP-C1')

        await prisma.gameEntry.create({
            data: { gameId: game.id, userId: user.id, cartelaId: c.id },
        })

        const { stopGameEngine } = await import('../lib/game-engine')
        await GameService.claimBingo(user.id, game.id, c.id)

        expect(stopGameEngine).toHaveBeenCalledWith(game.id)
    })

    it('should clear game state in Redis after claim', async () => {
        const calledBalls = [1, 16, 31, 46, 61]
        const game = await createGame({
            status: GameStatus.IN_PROGRESS,
            pattern: PatternType.ANY_LINE,
            calledBalls,
        })
        const user = await createUserWithWallet('claim_redis', '+251910400009', 500)
        const c = await createCartela('CLAIM-REDIS-C1')

        await prisma.gameEntry.create({
            data: { gameId: game.id, userId: user.id, cartelaId: c.id },
        })

        const { clearGameState } = await import('../lib/game-state')
        await GameService.claimBingo(user.id, game.id, c.id)

        // Wait for post-transaction promises
        await new Promise((r) => setTimeout(r, 100))

        expect(clearGameState).toHaveBeenCalledWith(game.id)
    })
})

// ─── Concurrency Tests ────────────────────────────────────────────────────────

describe('GameService — Concurrency', () => {
    it('two users joining same cartela — only one succeeds', async () => {
        const game = await createGame()
        const u1 = await createUserWithWallet('conc_u1', '+251910500001')
        const u2 = await createUserWithWallet('conc_u2', '+251910500002')
        const c = await createCartela('CONC-C1')

        const results = await Promise.allSettled([
            GameService.joinGame(u1.id, game.id, [c.serial]),
            GameService.joinGame(u2.id, game.id, [c.serial]),
        ])

        const successes = results.filter((r) => r.status === 'fulfilled')
        const failures = results.filter((r) => r.status === 'rejected')

        expect(successes).toHaveLength(1)
        expect(failures).toHaveLength(1)
    })

    it('rapid multiple joins from same user — wallet balance stays consistent', async () => {
        const game = await createGame({ ticketPrice: 100 })
        const user = await createUserWithWallet('rapid_user', '+251910500010', 500)
        const c1 = await createCartela('RAPID-C1')
        const c2 = await createCartela('RAPID-C2')
        const c3 = await createCartela('RAPID-C3')
        const c4 = await createCartela('RAPID-C4')
        const c5 = await createCartela('RAPID-C5')
        const c6 = await createCartela('RAPID-C6')

        // 6 * 100 = 600 but user only has 500
        const results = await Promise.allSettled([
            GameService.joinGame(user.id, game.id, [c1.serial]),
            GameService.joinGame(user.id, game.id, [c2.serial]),
            GameService.joinGame(user.id, game.id, [c3.serial]),
            GameService.joinGame(user.id, game.id, [c4.serial]),
            GameService.joinGame(user.id, game.id, [c5.serial]),
            GameService.joinGame(user.id, game.id, [c6.serial]),
        ])

        const successes = results.filter((r) => r.status === 'fulfilled')

        // At most 5 should succeed (500 / 100 = 5)
        expect(successes.length).toBeLessThanOrEqual(5)

        // Wallet should never go negative
        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        expect(Number(wallet!.realBalance)).toBeGreaterThanOrEqual(0)
    })
})
