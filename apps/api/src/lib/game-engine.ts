// redlock v4 is CJS-only; import the default export which is the constructor
import Redlock from 'redlock'
import redis from './redis'
import prisma from './prisma'
import { getIo } from './socket'
import {
    initGameState,
    addCalledBall,
    getCalledBalls,
    getGameState,
    updateGameState,
    clearGameState,
} from './game-state'
import {
    setRoomStatus,
    getRoomStatus,
    pushDrawnNumber,
    getDrawnNumbers,
    clearRoomState,
} from './room-state'
import { drawBall, createBallPool, checkPattern, PatternName } from '@world-bingo/game-logic'
import { GameStatus } from '@world-bingo/shared-types'
import { NotificationService } from '../services/notification.service'
import { NotificationType } from '@world-bingo/shared-types'
import { PayoutService } from '../services/payout.service'

/**
 * T24 — Robust Game Engine with Redlock
 *
 * Uses Redlock for distributed leader election so only one server instance
 * drives a game's ball-calling loop. If the lock is lost (server crash),
 * another instance can recover by checking Redis for active game state.
 *
 * Ball interval: 3 seconds per spec.
 * Lock TTL: 10 seconds, auto-renewed every 5 seconds.
 */

const BALL_INTERVAL_MS = 3_000
const LOCK_TTL_MS = 10_000
const LOCK_RENEW_MS = 5_000

// Singleton Redlock instance
const redlock = new Redlock([redis as any], {
    retryCount: 0, // Don't retry — another instance holds the lock
    retryDelay: 200,
    driftFactor: 0.01,
})

redlock.on('error', (err: Error) => {
    // Suppress expected "lock is not acquired" errors
    if (!err.message?.includes('lock')) {
        console.error('[GameEngine] Redlock error:', err)
    }
})

/**
 * Active lock + timer references (keyed by gameId).
 * Used to cancel the engine on this instance when the game ends.
 */
const activeEngines = new Map<string, { abort: AbortController }>()

const lockKey = (gameId: string) => `lock:game_engine:${gameId}`

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('Aborted', 'AbortError'))
        })
    })
}

/**
 * Start the game engine for the given game.
 *
 * Flow:
 *  1. Mark game IN_PROGRESS in Postgres.
 *  2. Initialize Redis state.
 *  3. Acquire Redlock — only one server drives the loop.
 *  4. Call a ball every BALL_INTERVAL_MS.
 *  5. On game end / all balls called, release lock & persist to Postgres.
 */
export async function startGameEngine(gameId: string): Promise<void> {
    // Fetch game to initialize Redis state
    const game = await prisma.game.findUnique({
        where: { id: gameId },
        include: {
            entries: { select: { userId: true }, distinct: ['userId'] },
        },
    })
    if (!game) throw new Error(`Game ${gameId} not found`)

    // Mark IN_PROGRESS in Postgres
    await prisma.game.update({
        where: { id: gameId },
        data: { status: GameStatus.IN_PROGRESS },
    })

    const playerIds = game.entries.map((e) => e.userId)

    // Initialize Redis game state
    await initGameState(gameId, {
        status: GameStatus.IN_PROGRESS,
        pattern: game.pattern,
        ticketPrice: String(game.ticketPrice),
        maxPlayers: game.maxPlayers,
        minPlayers: game.minPlayers,
        houseEdgePct: String(game.houseEdgePct),
        playerIds,
    })

    // Acquire Redlock — if another instance already has it, bail out
    let lock: Awaited<ReturnType<typeof redlock.acquire>>
    try {
        lock = await redlock.acquire([lockKey(gameId)], LOCK_TTL_MS)
    } catch {
        // Another instance acquired the lock — this instance does nothing
        console.log(`[GameEngine] ${gameId}: lock not acquired (another instance running)`)
        return
    }

    const abort = new AbortController()
    activeEngines.set(gameId, { abort })

    let renewTimer: ReturnType<typeof setInterval> | undefined

    try {
        // Auto-renew lock
        renewTimer = setInterval(async () => {
            try {
                lock = await lock.extend(LOCK_TTL_MS)
            } catch (err) {
                // Lock could not be renewed — stop this engine
                abort.abort()
            }
        }, LOCK_RENEW_MS)

        // ── Transition room state: LOCKING → IN_PROGRESS ─────────────────────
        await setRoomStatus(gameId, 'IN_PROGRESS')

        // ── Main ball-calling loop ────────────────────────────────────────────
        const allBalls = createBallPool() // [1..75]
        let stopped = false

        while (!stopped) {
            try {
                await sleep(BALL_INTERVAL_MS, abort.signal)
            } catch {
                break // Aborted — clean exit
            }

            // Check if game still active (could have been cancelled by admin)
            const currentState = await getGameState(gameId)
            if (!currentState || currentState.status !== GameStatus.IN_PROGRESS) {
                stopped = true
                break
            }

            // Also check the room-state layer (guards against external state changes)
            const roomPhase = await getRoomStatus(gameId)
            if (roomPhase && roomPhase !== 'IN_PROGRESS') {
                stopped = true
                break
            }

            // ── Draw a unique ball ─────────────────────────────────────────────
            const calledBalls  = await getCalledBalls(gameId)
            const calledSet    = new Set(calledBalls)
            const remaining    = allBalls.filter((b) => !calledSet.has(b))

            if (remaining.length === 0) {
                // All 75 balls called — end game with no winner
                stopped = true
                await endGameNoWinner(gameId)
                break
            }

            const { ball } = drawBall(remaining)
            const updatedCalledBalls = [...calledBalls, ball]

            // Persist to both Redis keys (game-state compat + room-state spec)
            await addCalledBall(gameId, ball)
            await pushDrawnNumber(gameId, ball)

            // ── Broadcast: new_call (spec) + game:ball-called (legacy) ─────────
            const io = getIo()
            const ballPayload = { gameId, ball, calledBalls: updatedCalledBalls }
            ;(io.to(`game:${gameId}`) as any).emit('new_call', ballPayload)
            io.to(`game:${gameId}`).emit('game:ball-called', ballPayload)

            // ── Win Check — iterate all active tickets ─────────────────────────
            const winnerIds = await checkAllTickets(gameId, new Set(updatedCalledBalls))

            if (winnerIds.length > 0) {
                stopped = true
                console.log(`[GameEngine] ${gameId}: Winner(s) found: ${winnerIds.join(', ')}`)

                // Transition: IN_PROGRESS → PAYOUT
                await setRoomStatus(gameId, 'PAYOUT')
                await updateGameState(gameId, { status: 'PAYOUT' })

                // Persist called balls to Postgres before payout
                await prisma.game.update({
                    where: { id: gameId },
                    data: { calledBalls: updatedCalledBalls },
                })

                // Execute atomic payout
                await PayoutService.executePayout(gameId, winnerIds)

                break
            }
        }
    } finally {
        if (renewTimer) clearInterval(renewTimer)
        activeEngines.delete(gameId)
        try {
            await lock.release()
        } catch {
            // Lock may have expired — fine
        }
    }
}

/**
 * End a game that ran out of balls with no winner.
 */
async function endGameNoWinner(gameId: string): Promise<void> {
    const calledBalls = await getCalledBalls(gameId)

    await prisma.game.update({
        where: { id: gameId },
        data: {
            status: GameStatus.COMPLETED,
            endedAt: new Date(),
            calledBalls,
        },
    })

    await updateGameState(gameId, { status: GameStatus.COMPLETED })
    await setRoomStatus(gameId, 'COMPLETED')

    const io = getIo()
    io.to(`game:${gameId}`).emit('game:ended', { id: gameId } as any)

    // Notify all participants
    try {
        const entries = await prisma.gameEntry.findMany({
            where: { gameId },
            distinct: ['userId'],
            select: { userId: true },
        })
        await Promise.all(
            entries.map((e) =>
                NotificationService.create(
                    e.userId,
                    NotificationType.GAME_WON,
                    'Game Ended',
                    'The game ended with no winner. All balls were called.',
                    { gameId },
                ).catch(() => {}),
            ),
        )
    } catch {
        // Non-critical
    }

    await Promise.allSettled([clearGameState(gameId), clearRoomState(gameId)])

    // Auto-replenish: if this was a templated game, create a new one
    try {
        const { GameSchedulerService } = await import('../services/game-scheduler.service.js')
        GameSchedulerService.onGameEnded(gameId).catch(() => {})
    } catch {
        // Non-critical
    }
}

/**
 * Iterate through every active ticket (GameEntry + Cartela) for this game
 * and return the list of user IDs whose cartela satisfies the winning pattern.
 *
 * This is the server-authoritative win check — the client's claim-bingo is
 * still validated separately, but the engine auto-detects winners so the game
 * can resolve even if a client never emits claim-bingo.
 */
async function checkAllTickets(gameId: string, calledSet: Set<number>): Promise<string[]> {
    const game = await prisma.game.findUnique({
        where: { id: gameId },
        select: { pattern: true },
    })
    if (!game) return []

    const entries = await prisma.gameEntry.findMany({
        where: { gameId },
        include: { cartela: { select: { grid: true } } },
    })

    const winners: string[] = []

    for (const entry of entries) {
        const grid = entry.cartela.grid as number[][]
        try {
            if (checkPattern(game.pattern as PatternName, grid, calledSet)) {
                winners.push(entry.userId)
            }
        } catch {
            // Malformed cartela — skip
        }
    }

    return winners
}

/**
 * Stop the game engine on this instance (e.g., on SIGTERM or admin cancel).
 */
export function stopGameEngine(gameId: string): void {
    const engine = activeEngines.get(gameId)
    if (engine) {
        engine.abort.abort()
        activeEngines.delete(gameId)
    }
}

/**
 * Stop all active engines on this instance (called during graceful shutdown).
 */
export function stopAllEngines(): void {
    for (const [gameId, engine] of activeEngines) {
        engine.abort.abort()
        activeEngines.delete(gameId)
    }
}

/**
 * Check if this instance is running the engine for a given game.
 */
export function isEngineActive(gameId: string): boolean {
    return activeEngines.has(gameId)
}
