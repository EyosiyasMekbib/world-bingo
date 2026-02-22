/**
 * T44 — Refund Worker
 *
 * Processes 'refund-game' jobs queued by GameService.cancelGame.
 * Running in a separate process/worker allows retries and prevents
 * blocking the HTTP request that triggered the cancellation.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { RefundService } from '../services/refund.service.js'
import { NotificationService } from '../services/notification.service.js'
import { NotificationType } from '@world-bingo/shared-types'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

export interface RefundJobData {
    gameId: string
    reason?: string
}

const worker = new Worker<RefundJobData>(
    QUEUE_NAMES.REFUND,
    async (job: Job<RefundJobData>) => {
        const { gameId, reason } = job.data
        console.log(`[RefundWorker] Processing refund for game ${gameId}`)

        const refunds = await RefundService.refundGame(gameId)

        // Notify each refunded player
        const notifPromises = refunds
            .filter((r) => !r.alreadyRefunded)
            .map((r) =>
                NotificationService.create(
                    r.userId,
                    NotificationType.GAME_CANCELLED,
                    'Game Cancelled — Refund Processed',
                    `Your game was cancelled${reason ? ` (${reason})` : ''}. ${r.amount} ETB has been returned to your wallet.`,
                    { gameId, refundAmount: r.amount },
                ).catch(() => {}),
            )

        await Promise.all(notifPromises)

        console.log(`[RefundWorker] Refunded ${refunds.length} players for game ${gameId}`)
        return { refundCount: refunds.length }
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
    console.log(`[RefundWorker] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
    console.error(`[RefundWorker] Job ${job?.id} failed:`, err.message)
})

export default worker
