import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
    startRoomCountdown: vi.fn(),
    stopRoomCountdown: vi.fn(),
    isCountdownActive: vi.fn().mockReturnValue(false),
}))

// Move mocks to the absolute top to ensure they are applied before any service imports
vi.mock('../services/room-timer.service', () => ({
    startRoomCountdown: mocks.startRoomCountdown,
    stopRoomCountdown: mocks.stopRoomCountdown,
    isCountdownActive: mocks.isCountdownActive,
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

import { startRoomCountdown } from '../services/room-timer.service'
import { GameService } from '../services/game.service'
import { prisma } from './setup'
import { GameStatus, PatternType, NotificationType } from '@world-bingo/shared-types'

vi.mock('../lib/game-state', () => ({
    initGameState: vi.fn().mockResolvedValue(undefined),
    clearGameState: vi.fn().mockResolvedValue(undefined),
    addCalledBall: vi.fn().mockResolvedValue(undefined),
    getCalledBalls: vi.fn().mockResolvedValue([]),
    getGameState: vi.fn().mockResolvedValue(null),
}))

vi.mock('../services/notification.service', () => ({
    NotificationService: {
        create: vi.fn().mockResolvedValue({ id: 'notif-1' }),
    },
}))

vi.mock('../services/refund.service', () => ({
    RefundService: {
        refundGame: vi.fn().mockResolvedValue([]),
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
            wallet: { create: { balance } },
        },
    })
}

async function createGame(overrides: Partial<{
    status: string
    minPlayers: number
    maxPlayers: number
    ticketPrice: number
}> = {}) {
    return prisma.game.create({
        data: {
            title: 'Test Game',
            status: (overrides.status ?? GameStatus.WAITING) as GameStatus,
            ticketPrice: overrides.ticketPrice ?? 50,
            maxPlayers: overrides.maxPlayers ?? 10,
            minPlayers: overrides.minPlayers ?? 2,
            houseEdgePct: 10,
            pattern: PatternType.ANY_LINE,
            calledBalls: [],
        },
    })
}

async function createCartela(serial: string) {
    return prisma.cartela.create({
        data: {
            serial,
            grid: [
                [1, 16, 31, 46, 61],
                [2, 17, 32, 47, 62],
                [3, 18, 0, 48, 63],
                [4, 19, 34, 49, 64],
                [5, 20, 35, 50, 65],
            ],
        },
    })
}

// ── Test Suites ────────────────────────────────────────────────────────────────

describe('GameService.joinGame (T8)', () => {
    let userId: string
    let gameId: string

    beforeEach(async () => {
        const user = await createUserWithWallet('join_user', '+251900400001')
        userId = user.id
        const game = await createGame()
        gameId = game.id
    })

    it('should deduct balance and create entries for each cartela', async () => {
        const c1 = await createCartela('JOIN-C1')
        const c2 = await createCartela('JOIN-C2')

        const entries = await GameService.joinGame(userId, gameId, [c1.serial, c2.serial])

        expect(entries).toHaveLength(2)

        const wallet = await prisma.wallet.findUnique({ where: { userId } })
        // 500 - (50 * 2) = 400
        expect(Number(wallet!.balance)).toBe(400)
    })

    it('should throw if cartela is already taken', async () => {
        const c1 = await createCartela('TAKEN-C1')
        await GameService.joinGame(userId, gameId, [c1.serial])

        const user2 = await createUserWithWallet('join_user2', '+251900400002')
        await expect(GameService.joinGame(user2.id, gameId, [c1.serial])).rejects.toThrow(
            'One or more selected cartelas are already taken',
        )
    })

    it('should throw if insufficient funds', async () => {
        const poorUser = await createUserWithWallet('poor_user', '+251900400003', 10)
        const c = await createCartela('POOR-C1')

        await expect(GameService.joinGame(poorUser.id, gameId, [c.serial])).rejects.toThrow(
            'Insufficient funds',
        )
    })

    it('should throw if game is not WAITING', async () => {
        const activeGame = await createGame({ status: GameStatus.IN_PROGRESS })
        const c = await createCartela('ACTIVE-C1')

        await expect(GameService.joinGame(userId, activeGame.id, [c.serial])).rejects.toThrow(
            'Game is already in progress or finished',
        )
    })
})

describe('GameService.startGame (T24/T25)', () => {
    let gameId: string

    it('should mark game STARTING and enqueue game engine job when minPlayers is met', async () => {
        mockQueueAdd.mockClear()

        const game = await createGame({ minPlayers: 1 })
        gameId = game.id
        const user = await createUserWithWallet('start_user', '+251900500001')
        const c = await createCartela('START-C1')
        await GameService.joinGame(user.id, gameId, [c.serial])

        const result = await GameService.startGame(gameId)
        expect(result.status).toBe(GameStatus.STARTING)

        // T48: Engine is now enqueued via BullMQ instead of setTimeout
        expect(mockQueueAdd).toHaveBeenCalledWith(
            `start-game-${gameId}`,
            { gameId, action: 'start' },
            expect.objectContaining({ delay: 5_000 }),
        )
    })

    it('should throw if not enough players joined', async () => {
        const game = await createGame({ minPlayers: 3 })
        const user = await createUserWithWallet('notenough_user', '+251900500002')
        const c = await createCartela('NE-C1')
        await GameService.joinGame(user.id, game.id, [c.serial])

        await expect(GameService.startGame(game.id)).rejects.toThrow('Not enough players to start')
    })

    it('should throw if game is already completed', async () => {
        const game = await createGame({ status: GameStatus.COMPLETED })
        await expect(GameService.startGame(game.id)).rejects.toThrow('not in a startable state')
    })
})

describe('GameService.cancelGame (T25)', () => {
    let gameId: string
    let userId: string

    beforeEach(async () => {
        const game = await createGame()
        gameId = game.id
        const user = await createUserWithWallet('cancel_user', '+251900600001')
        userId = user.id
    })

    it('should mark game as CANCELLED', async () => {
        await GameService.cancelGame(gameId)

        const game = await prisma.game.findUnique({ where: { id: gameId } })
        expect(game!.status).toBe(GameStatus.CANCELLED)
        expect(game!.endedAt).not.toBeNull()
    })

    it('should call RefundService.refundGame', async () => {
        const { RefundService } = await import('../services/refund.service')
        await GameService.cancelGame(gameId)
        expect(RefundService.refundGame).toHaveBeenCalledWith(gameId)
    })

    it('should call stopGameEngine', async () => {
        const { stopGameEngine } = await import('../lib/game-engine')
        await GameService.cancelGame(gameId)
        expect(stopGameEngine).toHaveBeenCalledWith(gameId)
    })

    it('should call clearGameState', async () => {
        const { clearGameState } = await import('../lib/game-state')
        await GameService.cancelGame(gameId)
        expect(clearGameState).toHaveBeenCalledWith(gameId)
    })

    it('should send GAME_CANCELLED notifications to refunded players', async () => {
        const { RefundService } = await import('../services/refund.service')
        const { NotificationService } = await import('../services/notification.service')

        vi.mocked(RefundService.refundGame).mockResolvedValueOnce([
            { userId, amount: 50, alreadyRefunded: false },
        ])

        await GameService.cancelGame(gameId)

        expect(NotificationService.create).toHaveBeenCalledWith(
            userId,
            NotificationType.GAME_CANCELLED,
            'Game Cancelled',
            expect.stringContaining('refunded'),
            expect.objectContaining({ gameId }),
        )
    })

    it('should be idempotent — throw on already cancelled game', async () => {
        await GameService.cancelGame(gameId)
        await expect(GameService.cancelGame(gameId)).rejects.toThrow('already finished or cancelled')
    })

    it('should throw on non-existent game', async () => {
        await expect(GameService.cancelGame('nonexistent-id')).rejects.toThrow('Game not found')
    })
})

describe('GameService.autoCancelIfUnderFilled (T26)', () => {
    it('should cancel game when player count is below minPlayers', async () => {
        const game = await createGame({ minPlayers: 3 })
        // Only 1 player joins
        const user = await createUserWithWallet('auto_user', '+251900700001')
        const c = await createCartela('AUTO-C1')
        await GameService.joinGame(user.id, game.id, [c.serial])

        await GameService.autoCancelIfUnderFilled(game.id)

        const updated = await prisma.game.findUnique({ where: { id: game.id } })
        expect(updated!.status).toBe(GameStatus.CANCELLED)
    })

    it('should NOT cancel when player count meets minPlayers', async () => {
        const game = await createGame({ minPlayers: 1 })
        const user = await createUserWithWallet('enough_user', '+251900700002')
        const c = await createCartela('ENOUGH-C1')
        await GameService.joinGame(user.id, game.id, [c.serial])

        await GameService.autoCancelIfUnderFilled(game.id)

        const updated = await prisma.game.findUnique({ where: { id: game.id } })
        expect(updated!.status).toBe(GameStatus.WAITING) // untouched
    })

    it('should silently do nothing for non-WAITING games', async () => {
        const game = await createGame({ status: GameStatus.IN_PROGRESS })
        // Should not throw or cancel
        await expect(GameService.autoCancelIfUnderFilled(game.id)).resolves.toBeUndefined()

        const updated = await prisma.game.findUnique({ where: { id: game.id } })
        expect(updated!.status).toBe(GameStatus.IN_PROGRESS)
    })

    it('should silently do nothing for non-existent game', async () => {
        await expect(GameService.autoCancelIfUnderFilled('ghost-id')).resolves.toBeUndefined()
    })
})

describe('GameSchedulerService.checkAndStartCountdown (T27)', () => {
    it('should start countdown when first player joins (even if < minPlayers)', async () => {
        mocks.startRoomCountdown.mockClear()

        const game = await createGame({ minPlayers: 3 })
        const user = await createUserWithWallet('first_user', '+251900800001')
        const c = await createCartela('COUNT-C1')

        // Joining should trigger the countdown check (fire-and-forget)
        await GameService.joinGame(user.id, game.id, [c.serial])

        // the countdown check is async and not awaited in joinGame, wait a bit
        await new Promise(resolve => setTimeout(resolve, 100))

        expect(mocks.startRoomCountdown).toHaveBeenCalledWith(game.id, expect.any(Number))
    })
})
