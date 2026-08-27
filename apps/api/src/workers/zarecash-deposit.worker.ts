/**
 * ZareCash deposit worker.
 *
 * No money has moved when this runs — the player's deposit is PENDING_REVIEW and
 * uncredited — so exhausting retries is a safe (if slow) failure. Contrast the
 * withdrawal worker, where the player is already debited.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { ZareCashService } from '../services/zarecash.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

interface ZareCashDepositJobData {
    transactionId: string
}

const worker = new Worker<ZareCashDepositJobData>(
    QUEUE_NAMES.ZARECASH_DEPOSIT,
    async (job: Job<ZareCashDepositJobData>) => {
        await ZareCashService.submitDeposit(job.data.transactionId)
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 4,
    },
)

worker.on('failed', (job, err) => {
    console.error(`[ZareCashDepositWorker] Job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'zarecash-deposit' })
})

worker.on('error', (err) => {
    console.error('[ZareCashDepositWorker] Worker error:', err.message)
    reportError(err, { worker: 'zarecash-deposit' })
})

export default worker
