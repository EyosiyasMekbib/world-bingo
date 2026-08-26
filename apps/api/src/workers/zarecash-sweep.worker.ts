/**
 * Nightly reconciliation sweep. A webhook outage is only survivable because of
 * this — see contract checklist item 7.
 */

import { Worker, Job } from 'bullmq'
import { getQueue, QUEUE_NAMES } from '../lib/queue.js'
import { ZareCashService } from '../services/zarecash.service.js'
import { isZareCashEnabled } from '../gateways/payment/zarecash/config.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

const worker = new Worker(
    QUEUE_NAMES.ZARECASH_SWEEP,
    async (_job: Job) => {
        const result = await ZareCashService.sweepEvents()
        console.log('[ZareCashSweep] scanned=%d replayed=%d', result.scanned, result.replayed)
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

worker.on('failed', (job, err) => {
    console.error(`[ZareCashSweep] Job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'zarecash-sweep' })
})

/** Schedule the nightly run. Idempotent — BullMQ dedupes on the repeat key. */
export async function scheduleZareCashSweep(): Promise<void> {
    if (!isZareCashEnabled()) return
    await getQueue(QUEUE_NAMES.ZARECASH_SWEEP).add(
        'sweep',
        {},
        { repeat: { pattern: '0 3 * * *' }, jobId: 'zarecash-nightly-sweep' },
    )
}

export default worker
