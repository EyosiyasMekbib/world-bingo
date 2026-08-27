/**
 * ZareCash event worker — processes webhook deliveries recorded by the route.
 * Keyed on the event id, so a redelivery or a sweep replay is a no-op.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { ZareCashService } from '../services/zarecash.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

interface ZareCashEventJobData {
    eventId: string
}

const worker = new Worker<ZareCashEventJobData>(
    QUEUE_NAMES.ZARECASH_EVENT,
    async (job: Job<ZareCashEventJobData>) => {
        await ZareCashService.processEvent(job.data.eventId)
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
    console.error(`[ZareCashEventWorker] Job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'zarecash-event' })
})

worker.on('error', (err) => {
    console.error('[ZareCashEventWorker] Worker error:', err.message)
    reportError(err, { worker: 'zarecash-event' })
})

export default worker
