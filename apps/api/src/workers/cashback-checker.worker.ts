/**
 * Cashback Checker Worker
 *
 * Runs a repeating job every hour to check all active cashback promotions
 * and automatically disburse cashback to players who have hit the loss threshold
 * within one frequency window (DAILY/WEEKLY/MONTHLY).
 *
 * The hourly cadence is unchanged by payoutTiming: a PERIOD_CLOSE promotion
 * settles the window that closed most recently, so the runs after the first one
 * find every qualifier already paid and do nothing. The service, not the worker,
 * decides which window is due.
 */

import { Worker, Job, Queue } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { CashbackService } from '../services/cashback.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

const CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export interface CashbackCheckerJobData {
    action: 'check'
}

const cashbackCheckerQueue = new Queue<CashbackCheckerJobData>(QUEUE_NAMES.CASHBACK_CHECKER, {
    connection: {
        url: REDIS_URL,
        maxRetriesPerRequest: null as any,
        enableReadyCheck: false,
        lazyConnect: true,
    } as any,
})

const worker = new Worker<CashbackCheckerJobData>(
    QUEUE_NAMES.CASHBACK_CHECKER,
    async (_job: Job<CashbackCheckerJobData>) => {
        console.log('[CashbackCheckerWorker] Running cashback threshold checks...')
        const result = await CashbackService.runChecks()
        console.log(
            `[CashbackCheckerWorker] Done — ${result.promotionsChecked} promotions checked, ` +
            `${result.totalDisbursed} players paid, total: ${result.totalAmount.toFixed(2)} ETB`,
        )
        // Which window each promotion actually settled: a PERIOD_CLOSE promotion
        // pays for a window that has already ended, so "0 players paid" at 14:00
        // is only readable if the log says whether it was settling today or
        // yesterday. Promotions whose window was not due are absent entirely.
        for (const s of result.settlements) {
            console.log(
                `[CashbackCheckerWorker] "${s.name}" (${s.payoutTiming}) settled ` +
                `${s.periodStart.toISOString()} → ${s.periodEnd.toISOString()}: ` +
                `${s.disbursed} paid, ${s.skipped} already paid, ${s.budgetSkipped} over budget, ` +
                `${s.total.toFixed(2)} ETB`,
            )
        }
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
    // Remove any existing repeating jobs to avoid duplicates on restart
    const repeatableJobs = await cashbackCheckerQueue.getRepeatableJobs()
    for (const rj of repeatableJobs) {
        await cashbackCheckerQueue.removeRepeatableByKey(rj.key)
    }

    // Add hourly repeating job
    await cashbackCheckerQueue.add(
        'check-cashback',
        { action: 'check' },
        {
            repeat: { every: CHECK_INTERVAL_MS },
            removeOnComplete: { count: 24 },
            removeOnFail: { count: 24 },
        },
    )

    // Run once immediately on startup
    await cashbackCheckerQueue.add(
        'check-cashback-now',
        { action: 'check' },
        {
            removeOnComplete: { count: 5 },
            removeOnFail: { count: 5 },
        },
    )

    console.log('[CashbackCheckerWorker] Repeating job set up (every 1 hour)')
}

setupRepeatingJob().catch((err) => {
    console.error('[CashbackCheckerWorker] Failed to set up repeating job:', err)
})

worker.on('completed', (job) => {
    console.log(`[CashbackCheckerWorker] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
    console.error(`[CashbackCheckerWorker] Job ${job?.id} failed:`, err.message)
    reportError(err, { worker: 'cashback-checker' })
})

worker.on('error', (err) => {
    console.error('[CashbackCheckerWorker] Worker error:', err.message)
    reportError(err, { worker: 'cashback-checker' })
})

export default worker
