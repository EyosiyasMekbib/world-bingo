import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/room-timer.service', () => ({
    startRoomCountdown: vi.fn(),
    stopRoomCountdown: vi.fn(),
    isCountdownActive: vi.fn().mockReturnValue(false),
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
        decrby: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
    }
    return { default: mockRedis, redis: mockRedis, getRedis: () => mockRedis }
})
vi.mock('../lib/socket', () => ({ getIo: () => ({ to: () => ({ emit: vi.fn() }) }) }))
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
    getCalledBalls: vi.fn().mockResolvedValue([1, 16, 31, 46, 61]),
    getGameState: vi.fn().mockResolvedValue(null),
}))
vi.mock('../services/notification.service', () => ({
    NotificationService: {
        create: vi.fn().mockResolvedValue({ id: 'notif-1' }),
        pushWalletUpdate: vi.fn(),
    },
}))
const { refundGame } = vi.hoisted(() => ({ refundGame: vi.fn().mockResolvedValue([]) }))
vi.mock('../services/refund.service', () => ({ RefundService: { refundGame } }))
vi.mock('../lib/queue', () => ({
    getQueue: vi.fn(() => ({ add: vi.fn().mockResolvedValue({ id: 'job-1' }) })),
    QUEUE_NAMES: { REFUND: 'refund', NOTIFICATION: 'notification', WITHDRAWAL: 'withdrawal', GAME_ENGINE: 'game-engine' },
}))
vi.mock('../services/game-scheduler.service', () => ({
    GameSchedulerService: {
        checkAndStartCountdown: vi.fn().mockResolvedValue(undefined),
        onGameEnded: vi.fn().mockResolvedValue(undefined),
    },
}))

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))
const emitters = vi.hoisted(() => ({
    emitGameFinished: vi.fn().mockResolvedValue(undefined),
    emitGameRefunded: vi.fn(),
}))
vi.mock('../lib/posthog-events', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/posthog-events')>()
    return { ...actual, ...emitters }
})

import { GameService } from '../services/game.service'
import { prisma } from './setup'
import { GameStatus, PatternType } from '@world-bingo/shared-types'

async function createUserWithWallet(username: string, phone: string) {
    return prisma.user.create({
        data: { username, phone, passwordHash: 'hashed:pass', wallet: { create: { realBalance: 500 } } },
    })
}

async function createGame(status: GameStatus = GameStatus.WAITING) {
    return prisma.game.create({
        data: {
            title: 'PH Game',
            status,
            ticketPrice: 50,
            maxPlayers: 10,
            minPlayers: 2,
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

let userId: string
let gameId: string

beforeEach(async () => {
    vi.clearAllMocks()
    userId = (await createUserWithWallet('ph_game', '+251977000020')).id
    gameId = (await createGame()).id
})

describe('GameService PostHog hooks', () => {
    it('joinGame emits game_joined with stake and cartela count', async () => {
        await createCartela('PH-C1')
        await createCartela('PH-C2')
        await GameService.joinGame(userId, gameId, ['PH-C1', 'PH-C2'])
        expect(captureEvent).toHaveBeenCalledWith(userId, 'game_joined', {
            game_id: gameId,
            template_id: null,
            ticket_price: 50,
            cartelas: 2,
            stake: 100,
            spend_account: 'REAL',
        })
    })

    it('leaveGame emits game_left with the refund', async () => {
        await createCartela('PH-C3')
        await GameService.joinGame(userId, gameId, ['PH-C3'])
        captureEvent.mockClear()
        await GameService.leaveGame(userId, gameId)
        expect(captureEvent).toHaveBeenCalledWith(userId, 'game_left', {
            game_id: gameId,
            template_id: null,
            refund: 50,
        })
    })

    it('cancelGame hands the refund list to emitGameRefunded', async () => {
        await createCartela('PH-C4')
        await GameService.joinGame(userId, gameId, ['PH-C4'])
        refundGame.mockResolvedValue([{ userId, amount: 50, alreadyRefunded: false }])
        await GameService.cancelGame(gameId, 'under_filled')
        expect(emitters.emitGameRefunded).toHaveBeenCalledWith(
            gameId,
            null,
            [{ userId, amount: 50, alreadyRefunded: false }],
            'under_filled',
        )
    })

    it('claimBingo emits game_finished once the payout commits', async () => {
        await createCartela('PH-C5')
        await GameService.joinGame(userId, gameId, ['PH-C5'])
        await prisma.game.update({ where: { id: gameId }, data: { status: GameStatus.IN_PROGRESS, startedAt: new Date() } })
        const cartela = await prisma.cartela.findUniqueOrThrow({ where: { serial: 'PH-C5' } })
        await GameService.claimBingo(userId, gameId, cartela.id)
        expect(emitters.emitGameFinished).toHaveBeenCalledWith(gameId)
    })
})
