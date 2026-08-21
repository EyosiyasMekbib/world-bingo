/**
 * Bonus Expiry Worker
 *
 * Runs every 15 minutes: finds every ACTIVE lot past its expiresAt, expires it
 * per-user inside one transaction (BonusService.expireForUser), and writes a
 * BONUS_EXPIRED transaction so a balance dropping overnight has an audit row.
 */

import { Worker, Job, Queue } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { BonusService } from '../services/bonus.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const SWEEP_INTERVAL_MS = 15 * 60 * 1000

export interface BonusExpiryJobData {
    action: 'sweep'
}

const bonusExpiryQueue = new Queue<BonusExpiryJobData>(QUEUE_NAMES.BONUS_EXPIRY, {
    connection: {
        url: REDIS_URL,
        maxRetriesPerRequest: null as any,
        enableReadyCheck: false,
        lazyConnect: true,
    } as any,
})

const worker = new Worker<BonusExpiryJobData>(
    QUEUE_NAMES.BONUS_EXPIRY,
    async (_job: Job<BonusExpiryJobData>) => {
        console.log('[BonusExpiryWorker] Sweeping expired bonus lots...')
        const result = await BonusService.sweepExpired()
        console.log(`[BonusExpiryWorker] Done — ${result.usersProcessed} players affected, ${result.totalExpired} ETB expired`)
        return result
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 1,
    },
)

async function setupRepeatingJob() {
    const repeatableJobs = await bonusExpiryQueue.getRepeatableJobs()
    for (const rj of repeatableJobs) {
        await bonusExpiryQueue.removeRepeatableByKey(rj.key)
    }

    await bonusExpiryQueue.add(
        'sweep-expired-bonuses',
        { action: 'sweep' },
        {
            repeat: { every: SWEEP_INTERVAL_MS },
            removeOnComplete: { count: 24 },
            removeOnFail: { count: 24 },
        },
    )

    await bonusExpiryQueue.add(
        'sweep-expired-bonuses-now',
        { action: 'sweep' },
        {
            removeOnComplete: { count: 5 },
            removeOnFail: { count: 5 },
        },
    )

    console.log('[BonusExpiryWorker] Repeating job set up (every 15 minutes)')
}

setupRepeatingJob().catch((err) => {
    console.error('[BonusExpiryWorker] Failed to set up repeating job:', err)
})

worker.on('completed', (job) => {
    console.log(`[BonusExpiryWorker] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
    console.error(`[BonusExpiryWorker] Job ${job?.id} failed:`, err.message)
    reportError(err, { worker: 'bonus-expiry' })
})

worker.on('error', (err) => {
    console.error('[BonusExpiryWorker] Worker error:', err.message)
    reportError(err, { worker: 'bonus-expiry' })
})

export default worker
