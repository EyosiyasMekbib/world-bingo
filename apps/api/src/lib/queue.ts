/**
 * T44 — BullMQ Queue Infrastructure
 *
 * Centralised queue factory. Each queue gets its own Redis connection
 * (BullMQ requirement: Queue and Worker must NOT share a connection).
 *
 * Usage:
 *   import { getQueue } from './lib/queue'
 *   const refundQueue = getQueue('refund')
 *   await refundQueue.add('refund-game', { gameId: '...' })
 */

import { Queue, QueueOptions } from 'bullmq'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

// BullMQ accepts a URL string — it will create its own ioredis instance
function bullConnection() {
    return {
        url: REDIS_URL,
        maxRetriesPerRequest: null as any,
        enableReadyCheck: false,
        lazyConnect: true,
    } as const
}

export const QUEUE_NAMES = {
    REFUND: 'refund',
    NOTIFICATION: 'notification',
    WITHDRAWAL: 'withdrawal',
    GAME_ENGINE: 'game-engine',
    GAME_SCHEDULER: 'game-scheduler',
    GAME_COUNTDOWN: 'game-countdown',
    GAME_CATALOG_SYNC: 'game-catalog-sync',
    CASHBACK_CHECKER: 'cashback-checker',
    DEPOSIT_VERIFICATION: 'deposit-verification',
    PLAYER_METRICS: 'player-metrics',
    CRM_CAMPAIGN: 'crm-campaign',
    PREDICTION: 'prediction',
    BONUS_EXPIRY: 'bonus-expiry',
    ZARECASH_DEPOSIT: 'zarecash-deposit',
    ZARECASH_EVENT: 'zarecash-event',
    ZARECASH_WITHDRAWAL: 'zarecash-withdrawal',
    ZARECASH_SWEEP: 'zarecash-sweep',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

/**
 * Retry budget for ZareCash withdrawal submission, before the worker's terminal
 * refund fires. Exported so the producer (wallet.service.ts, which enqueues the
 * job) and the consumer (zarecash-withdrawal.worker.ts, which compares
 * attemptsMade against it) read the exact same number — the queue's
 * `defaultJobOptions.attempts` below (3) is too short for an irreversible refund
 * decision, so this job overrides `attempts` explicitly on `.add()` rather than
 * relying on the queue default.
 */
export const ZARECASH_WITHDRAWAL_ATTEMPTS = Number(process.env.ZARECASH_WITHDRAWAL_ATTEMPTS || '8')

// Singleton map of Queue instances
const queues = new Map<string, Queue>()

const defaultJobOptions: QueueOptions['defaultJobOptions'] = {
    attempts: 3,
    backoff: {
        type: 'exponential',
        delay: 1000,
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
}

/**
 * Get or create a named BullMQ queue.
 * Reuses the same Queue instance across calls.
 */
export function getQueue(name: QueueName): Queue {
    if (queues.has(name)) return queues.get(name)!

    const queue = new Queue(name, {
        connection: bullConnection() as any,
        defaultJobOptions,
    })

    queue.on('error', (err) => {
        console.error(`[Queue:${name}] Error:`, err.message)
    })

    queues.set(name, queue)
    return queue
}

/**
 * Gracefully close all queue connections.
 * Call this during server shutdown.
 */
export async function closeAllQueues(): Promise<void> {
    await Promise.all([...queues.values()].map((q) => q.close()))
    queues.clear()
}
