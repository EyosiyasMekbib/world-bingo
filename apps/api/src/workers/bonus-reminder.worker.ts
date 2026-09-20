/**
 * Bonus Reminder Worker
 *
 * Runs every 15 minutes: warns players whose ACTIVE lots are inside a warning
 * window (24 hours out, then 2 hours out) so a bonus is never deleted by the
 * expiry sweep without the player having been told. Idempotency lives in
 * BonusReminderService — this wrapper can tick as often as it likes.
 */

import { Worker, Job, Queue } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { BonusReminderService } from '../services/bonus-reminder.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const SWEEP_INTERVAL_MS = 15 * 60 * 1000

export interface BonusReminderJobData {
    action: 'sweep'
}

const bonusReminderQueue = new Queue<BonusReminderJobData>(QUEUE_NAMES.BONUS_REMINDER, {
    connection: {
        url: REDIS_URL,
        maxRetriesPerRequest: null as any,
        enableReadyCheck: false,
        lazyConnect: true,
    } as any,
})

const worker = new Worker<BonusReminderJobData>(
    QUEUE_NAMES.BONUS_REMINDER,
    async (_job: Job<BonusReminderJobData>) => {
        console.log('[BonusReminderWorker] Sweeping expiring bonus lots...')
        const result = await BonusReminderService.sweepExpiring()
        console.log(
            `[BonusReminderWorker] Done — ${result.notificationsSent} warnings to ${result.usersNotified} players ` +
                `(24h: ${result.byWindow['24h']}, 2h: ${result.byWindow['2h']}, failed: ${result.failures})`,
        )
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
    const repeatableJobs = await bonusReminderQueue.getRepeatableJobs()
    for (const rj of repeatableJobs) {
        await bonusReminderQueue.removeRepeatableByKey(rj.key)
    }

    await bonusReminderQueue.add(
        'sweep-expiring-bonuses',
        { action: 'sweep' },
        {
            repeat: { every: SWEEP_INTERVAL_MS },
            removeOnComplete: { count: 24 },
            removeOnFail: { count: 24 },
        },
    )

    await bonusReminderQueue.add(
        'sweep-expiring-bonuses-now',
        { action: 'sweep' },
        {
            removeOnComplete: { count: 5 },
            removeOnFail: { count: 5 },
        },
    )

    console.log('[BonusReminderWorker] Repeating job set up (every 15 minutes)')
}

setupRepeatingJob().catch((err) => {
    console.error('[BonusReminderWorker] Failed to set up repeating job:', err)
})

worker.on('completed', (job) => {
    console.log(`[BonusReminderWorker] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
    console.error(`[BonusReminderWorker] Job ${job?.id} failed:`, err.message)
    reportError(err, { worker: 'bonus-reminder' })
})

worker.on('error', (err) => {
    console.error('[BonusReminderWorker] Worker error:', err.message)
    reportError(err, { worker: 'bonus-reminder' })
})

export default worker
