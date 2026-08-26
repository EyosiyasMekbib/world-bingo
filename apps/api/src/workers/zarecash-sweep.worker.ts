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

/** Job name for the frequent stranded-event pass. */
export const STRANDED_REQUEUE_JOB = 'requeue-stranded'

/** Exported for unit tests — dispatching on job name without a live Worker. */
export async function processSweepJob(job: Job): Promise<unknown> {
    if (job.name === STRANDED_REQUEUE_JOB) {
        const result = await ZareCashService.requeueStrandedEvents()
        console.log('[ZareCashSweep] stranded found=%d requeued=%d', result.found, result.requeued)
        return result
    }

    const result = await ZareCashService.sweepEvents()
    console.log(
        '[ZareCashSweep] scanned=%d replayed=%d pages=%d truncated=%s',
        result.scanned,
        result.replayed,
        result.pages,
        result.truncated,
    )
    return result
}

const worker = new Worker(
    QUEUE_NAMES.ZARECASH_SWEEP,
    processSweepJob,
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

/**
 * Schedule both recurring passes. Idempotent — BullMQ dedupes on the repeat key.
 *
 * Two different jobs with two different jobs to do:
 *  - the nightly reconciliation sweep, which pulls events ZareCash has that we
 *    never received;
 *  - a frequent stranded-event pass, which re-enqueues events we DID receive and
 *    recorded but never finished processing. Nothing else revisits those: the
 *    webhook route answers 200 before processing so ZareCash never redelivers,
 *    and once the event job exhausts its BullMQ attempts it is simply gone. A
 *    `withdrawal.rejected` lost that way leaves a player debited for a payout
 *    that was refused, so waiting until 3am for it is far too slow.
 */
export async function scheduleZareCashSweep(): Promise<void> {
    if (!isZareCashEnabled()) return
    const queue = getQueue(QUEUE_NAMES.ZARECASH_SWEEP)
    await queue.add('sweep', {}, { repeat: { pattern: '0 3 * * *' }, jobId: 'zarecash-nightly-sweep' })
    await queue.add(
        STRANDED_REQUEUE_JOB,
        {},
        { repeat: { pattern: '*/15 * * * *' }, jobId: 'zarecash-stranded-requeue' },
    )
}

export default worker
