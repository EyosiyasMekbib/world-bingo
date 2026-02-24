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
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

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
