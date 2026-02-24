/**
 * Game Scheduler Worker
 *
 * Runs a repeating job every 30 seconds to ensure all active GameTemplates
 * have at least one WAITING game in the lobby. Also runs once on startup.
 */

import { Worker, Job, Queue } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

const REPLENISH_INTERVAL_MS = 30_000 // 30 seconds

export interface SchedulerJobData {
    action: 'replenish'
}

// Create a dedicated queue to add the repeating job
const schedulerQueue = new Queue<SchedulerJobData>(QUEUE_NAMES.GAME_SCHEDULER, {
    connection: {
        url: REDIS_URL,
        maxRetriesPerRequest: null as any,
        enableReadyCheck: false,
    } as any,
})

const worker = new Worker<SchedulerJobData>(
    QUEUE_NAMES.GAME_SCHEDULER,
    async (job: Job<SchedulerJobData>) => {
        console.log('[GameSchedulerWorker] Running template replenishment check...')

        const { GameSchedulerService } = await import('../services/game-scheduler.service.js')
        await GameSchedulerService.replenishAll()

        return { replenished: true }
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

// Set up the repeating job
async function setupRepeatingJob() {
    // Remove any existing repeating jobs to avoid duplicates
    const repeatableJobs = await schedulerQueue.getRepeatableJobs()
    for (const rj of repeatableJobs) {
        await schedulerQueue.removeRepeatableByKey(rj.key)
    }

    // Add a new repeating job
    await schedulerQueue.add(
        'replenish-templates',
        { action: 'replenish' },
        {
            repeat: {
                every: REPLENISH_INTERVAL_MS,
            },
            removeOnComplete: { count: 10 },
            removeOnFail: { count: 10 },
        },
    )

    // Also run once immediately
    await schedulerQueue.add(
        'replenish-templates-now',
        { action: 'replenish' },
        {
            removeOnComplete: { count: 5 },
            removeOnFail: { count: 5 },
        },
    )

    console.log(`[GameSchedulerWorker] Repeating job set up (every ${REPLENISH_INTERVAL_MS / 1000}s)`)
}

setupRepeatingJob().catch((err) => {
    console.error('[GameSchedulerWorker] Failed to set up repeating job:', err)
})

worker.on('completed', (job) => {
    console.log(`[GameSchedulerWorker] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
    console.error(`[GameSchedulerWorker] Job ${job?.id} failed:`, err.message)
})

worker.on('error', (err) => {
    console.error('[GameSchedulerWorker] Worker error:', err.message)
})

export default worker
