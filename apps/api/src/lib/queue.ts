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
    ACCOUNT_STATUS_EXPIRY: 'account-status-expiry',
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
const DEFAULT_ZARECASH_WITHDRAWAL_ATTEMPTS = 8

/**
 * Validated, because a bad value here silently inverts the refund decision.
 *
 * `Number('eight')` is NaN, and `job.attemptsMade < NaN` is false — so the
 * worker's "have we exhausted retries?" gate passes on the FIRST failure and
 * fires the terminal refund immediately, refunding a payout after a single
 * transient blip. Any non-integer or non-positive value falls back to the
 * default and says so.
 */
function readWithdrawalAttempts(): number {
    const raw = (process.env.ZARECASH_WITHDRAWAL_ATTEMPTS ?? '').trim()
    if (!raw) return DEFAULT_ZARECASH_WITHDRAWAL_ATTEMPTS
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1) {
        console.warn(
            `[Queue] ZARECASH_WITHDRAWAL_ATTEMPTS="${raw}" is not a positive integer — ` +
                `falling back to ${DEFAULT_ZARECASH_WITHDRAWAL_ATTEMPTS}`,
        )
        return DEFAULT_ZARECASH_WITHDRAWAL_ATTEMPTS
    }
    return parsed
}

export const ZARECASH_WITHDRAWAL_ATTEMPTS = readWithdrawalAttempts()

/** Test seam — re-reads the env var so a test can exercise the validation. */
export function __readWithdrawalAttemptsForTest(): number {
    return readWithdrawalAttempts()
}

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
