import { Worker, Queue } from 'bullmq'
import prisma from '../lib/prisma.js'
import { reportError } from '../lib/sentry.js'

const QUEUE_NAME = 'prune-analytics-events'
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

const redisConnection = {
    url: REDIS_URL,
    maxRetriesPerRequest: null as any,
    enableReadyCheck: false,
    lazyConnect: true,
} as any

const queue = new Queue(QUEUE_NAME, { connection: redisConnection })

const worker = new Worker(
    QUEUE_NAME,
    async () => {
        const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
        const result = await prisma.analyticsEvent.deleteMany({
            where: { createdAt: { lt: cutoff } },
        })
        console.log(`[prune-events] Deleted ${result.count} events older than 90 days`)
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
    console.error(`[prune-events] Job ${job?.id} failed:`, err)
    reportError(err, { worker: 'prune-events' })
})

async function setupRepeatingJob() {
    const repeatableJobs = await queue.getRepeatableJobs()
    for (const rj of repeatableJobs) {
        await queue.removeRepeatableByKey(rj.key)
    }
    await queue.add('prune', {}, {
        repeat: { pattern: '0 3 * * *' },
        removeOnComplete: { count: 7 },
        removeOnFail: { count: 7 },
    })
    console.log('[prune-events] Daily prune job scheduled (03:00 UTC)')
}

setupRepeatingJob().catch(err => {
    console.error('[prune-events] Failed to set up prune job:', err)
})
