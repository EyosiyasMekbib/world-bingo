/**
 * Game Countdown Worker
 *
 * When minPlayers join a game, a delayed job is enqueued.
 * After the countdown expires (default 60s), this worker auto-starts the game.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

export interface CountdownJobData {
    gameId: string
}

const worker = new Worker<CountdownJobData>(
    QUEUE_NAMES.GAME_COUNTDOWN,
    async (job: Job<CountdownJobData>) => {
        const { gameId } = job.data
        console.log(`[CountdownWorker] Countdown expired for game ${gameId}, auto-starting...`)

        // Dynamic import to avoid circular deps
        const { GameSchedulerService } = await import('../services/game-scheduler.service.js')
        await GameSchedulerService.handleCountdownExpired(gameId)

        return { started: true, gameId }
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 5,
    },
)

worker.on('completed', (job) => {
    console.log(`[CountdownWorker] Job ${job.id} completed for game ${job.data.gameId}`)
})

worker.on('failed', (job, err) => {
    console.error(
        `[CountdownWorker] Job ${job?.id} failed for game ${job?.data.gameId}:`,
        err.message,
    )
})

worker.on('error', (err) => {
    console.error('[CountdownWorker] Worker error:', err.message)
})

export default worker
