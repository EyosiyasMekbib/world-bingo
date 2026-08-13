/**
 * Player Metrics Worker
 *
 * Keeps the PlayerMetrics rollup that every CRM segment reads up to date:
 *  - incremental every 5 minutes (only players touched since the watermark)
 *  - full rebuild nightly, which self-heals any drift
 *
 * Safe to run more than once: refreshes are absolute recomputes, so a retry or an
 * overlapping run converges on the same values rather than double-counting.
 */

import { Worker, Job, Queue } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { PlayerMetricsService } from '../services/player-crm/player-metrics.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

const INCREMENTAL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const FULL_REBUILD_INTERVAL_MS = 24 * 60 * 60 * 1000 // nightly

export interface PlayerMetricsJobData {
    action: 'incremental' | 'full'
}

const playerMetricsQueue = new Queue<PlayerMetricsJobData>(QUEUE_NAMES.PLAYER_METRICS, {
    connection: {
        url: REDIS_URL,
        maxRetriesPerRequest: null as any,
        enableReadyCheck: false,
        lazyConnect: true,
    } as any,
})

const worker = new Worker<PlayerMetricsJobData>(
    QUEUE_NAMES.PLAYER_METRICS,
    async (job: Job<PlayerMetricsJobData>) => {
        if (job.data.action === 'full') {
            const result = await PlayerMetricsService.refreshAll()
            console.log(
                `[PlayerMetricsWorker] Full rebuild — ${result.rows} rows in ${result.ms}ms`,
            )
            return result
        }

        const result = await PlayerMetricsService.refreshIncremental()
        if (result.candidates > 0) {
            console.log(
                `[PlayerMetricsWorker] Incremental — ${result.candidates} players touched, ` +
                `${result.rows} rows in ${result.ms}ms`,
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
        // Serial: two concurrent rollups would fight over the same rows for no gain.
        concurrency: 1,
    },
)

async function setupRepeatingJobs() {
    // Clear existing repeatables so a restart doesn't stack duplicates.
    const repeatableJobs = await playerMetricsQueue.getRepeatableJobs()
    for (const rj of repeatableJobs) {
        await playerMetricsQueue.removeRepeatableByKey(rj.key)
    }

    await playerMetricsQueue.add(
        'metrics-incremental',
        { action: 'incremental' },
        {
            repeat: { every: INCREMENTAL_INTERVAL_MS },
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
        },
    )

    await playerMetricsQueue.add(
        'metrics-full',
        { action: 'full' },
        {
            repeat: { every: FULL_REBUILD_INTERVAL_MS },
            removeOnComplete: { count: 7 },
            removeOnFail: { count: 7 },
        },
    )

    // Seed the table on first boot — until it is populated every segment reads zero.
    await playerMetricsQueue.add(
        'metrics-full-now',
        { action: 'full' },
        { removeOnComplete: { count: 5 }, removeOnFail: { count: 5 } },
    )

    console.log('[PlayerMetricsWorker] Repeating jobs set up (incremental 5m, full 24h)')
}

setupRepeatingJobs().catch((err) => {
    console.error('[PlayerMetricsWorker] Failed to set up repeating jobs:', err)
    reportError(err, { worker: 'player-metrics', phase: 'setup' })
})

worker.on('failed', (job, err) => {
    // The watermark only advances on success, so a failed incremental simply
    // re-does its window next tick.
    console.error(`[PlayerMetricsWorker] Job ${job?.id} failed:`, err.message)
    reportError(err, { worker: 'player-metrics', action: job?.data?.action })
})

worker.on('error', (err) => {
    console.error('[PlayerMetricsWorker] Worker error:', err.message)
    reportError(err, { worker: 'player-metrics' })
})

export default worker
