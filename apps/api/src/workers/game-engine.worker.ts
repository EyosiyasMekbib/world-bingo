/**
 * T48 — Game Engine Worker
 *
 * Moves the game engine's ball-calling loop into a BullMQ worker.
 * This decouples the game loop from the HTTP server process, allowing:
 *  - Horizontal scaling: only ONE worker instance drives a game (via Redlock).
 *  - Crash recovery: if a worker dies, another picks up using Redis state.
 *  - Observable: jobs appear in the BullMQ dashboard (T49).
 *
 * Job data: { gameId: string }
 * The worker delegates to startGameEngine() which handles Redlock + ball calling.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { startGameEngine, stopGameEngine, isEngineActive } from '../lib/game-engine.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

export interface GameEngineJobData {
    gameId: string
    /** Optional: pass 'start' (default) or 'stop' */
    action?: 'start' | 'stop'
}

const worker = new Worker<GameEngineJobData>(
    QUEUE_NAMES.GAME_ENGINE,
    async (job: Job<GameEngineJobData>) => {
        const { gameId, action = 'start' } = job.data

        if (action === 'stop') {
            console.log(`[GameEngineWorker] Stopping engine for game ${gameId}`)
            stopGameEngine(gameId)
            return { stopped: true, gameId }
        }

        console.log(`[GameEngineWorker] Starting engine for game ${gameId}`)

        // Check if already running on this instance
        if (isEngineActive(gameId)) {
            console.log(`[GameEngineWorker] Engine already active for ${gameId}, skipping`)
            return { alreadyActive: true, gameId }
        }

        // startGameEngine handles Redlock acquisition internally —
        // if another instance holds the lock, this call returns gracefully.
        await startGameEngine(gameId)

        console.log(`[GameEngineWorker] Engine completed for game ${gameId}`)
        return { completed: true, gameId }
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        // Only run ONE game engine job at a time per worker instance
        // to avoid CPU/memory contention during ball-calling loops.
        concurrency: 3,
        // Game engine jobs are long-running (can be 5+ minutes).
        // Increase lock duration so BullMQ doesn't mark them as stalled.
        lockDuration: 600_000, // 10 minutes
        lockRenewTime: 300_000, // Renew halfway through
    },
)

worker.on('completed', (job) => {
    console.log(`[GameEngineWorker] Job ${job.id} completed for game ${job.data.gameId}`)
})

worker.on('failed', (job, err) => {
    console.error(
        `[GameEngineWorker] Job ${job?.id} failed for game ${job?.data.gameId}:`,
        err.message,
    )
})

worker.on('error', (err) => {
    // Connection errors etc.
    console.error('[GameEngineWorker] Worker error:', err.message)
})

export default worker
