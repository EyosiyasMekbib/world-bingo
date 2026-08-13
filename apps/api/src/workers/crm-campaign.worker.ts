/**
 * CRM Campaign Worker
 *
 * Drains a campaign's materialised delivery rows in batches. One job per campaign
 * that loops, rather than one job per recipient: a 40k-recipient campaign would
 * otherwise be 40k Redis jobs, and per-job retry semantics would fight the
 * delivery row's own idempotency.
 *
 * Safety lives in CampaignService.drainBatch — status re-checked each pass (so a
 * stop takes effect within one batch), approval hash re-verified, and each row
 * moved to a terminal state inside the transaction that does its work.
 */

import { Worker, Job, Queue } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { CampaignService } from '../services/player-crm/campaign.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

/** Bounds a single job. A campaign larger than this is picked up by re-enqueue. */
const MAX_BATCHES_PER_JOB = 100

export interface CampaignJobData {
    campaignId: string
}

const campaignQueue = new Queue<CampaignJobData>(QUEUE_NAMES.CRM_CAMPAIGN, {
    connection: {
        url: REDIS_URL,
        maxRetriesPerRequest: null as any,
        enableReadyCheck: false,
        lazyConnect: true,
    } as any,
})

// Without this the process dies on an unhandled 'error' event whenever Redis is
// unreachable — which is how the API currently fails to boot without Redis.
campaignQueue.on('error', (err) => {
    console.error('[CrmCampaignWorker] Queue error:', err.message)
})

export async function enqueueCampaign(campaignId: string): Promise<void> {
    await campaignQueue.add(
        `campaign-${campaignId}`,
        { campaignId },
        { removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
    )
}

const worker = new Worker<CampaignJobData>(
    QUEUE_NAMES.CRM_CAMPAIGN,
    async (job: Job<CampaignJobData>) => {
        const { campaignId } = job.data
        let processed = 0

        for (let i = 0; i < MAX_BATCHES_PER_JOB; i++) {
            const result = await CampaignService.drainBatch(campaignId)
            processed += result.processed
            if (result.done) {
                console.log(`[CrmCampaignWorker] Campaign ${campaignId} finished — ${processed} delivered`)
                return { processed, done: true }
            }
        }

        // Still work left: hand back to the queue rather than holding one job open.
        await enqueueCampaign(campaignId)
        console.log(`[CrmCampaignWorker] Campaign ${campaignId} — ${processed} so far, re-queued`)
        return { processed, done: false }
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        // Serial: concurrent drains of the same campaign would contend on the
        // campaign row lock for no throughput gain.
        concurrency: 1,
    },
)

worker.on('failed', (job, err) => {
    // Rows left QUEUED are retried on the next pass; nothing is lost.
    console.error(`[CrmCampaignWorker] Job ${job?.id} failed:`, err.message)
    reportError(err, { worker: 'crm-campaign', campaignId: job?.data?.campaignId })
})

worker.on('error', (err) => {
    console.error('[CrmCampaignWorker] Worker error:', err.message)
})

export default worker
