/**
 * Game Catalog Sync Worker
 *
 * Runs every 6 hours to sync game vendors and game lists from all active
 * providers into the local database and refresh Redis cache.
 */

import { Worker, Queue } from 'bullmq'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const QUEUE_NAME = 'game-catalog-sync'
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

const syncQueue = new Queue<{ action: 'sync-all' }>(QUEUE_NAME, {
    connection: {
        url: REDIS_URL,
        maxRetriesPerRequest: null as any,
        enableReadyCheck: false,
    } as any,
})

const worker = new Worker<{ action: 'sync-all' }>(
    QUEUE_NAME,
    async () => {
        const { GameCatalogService } = await import('../services/game-catalog.service.js')
        const prisma = (await import('../lib/prisma.js')).default

        const providers = await prisma.gameProvider.findMany({
            where: { status: 'ACTIVE' },
            select: { code: true },
        })

        for (const provider of providers) {
            await GameCatalogService.syncAll(provider.code).catch((err: Error) => {
                console.error(`[CatalogSyncWorker] Failed to sync ${provider.code}:`, err.message)
            })
        }

        return { synced: providers.map((p) => p.code) }
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
    const existing = await syncQueue.getRepeatableJobs()
    for (const rj of existing) {
        await syncQueue.removeRepeatableByKey(rj.key)
    }

    await syncQueue.add(
        'sync-all-providers',
        { action: 'sync-all' },
        {
            repeat: { every: SYNC_INTERVAL_MS },
            jobId: 'game-catalog-sync-repeating',
        },
    )

    console.log('[CatalogSyncWorker] Repeating sync job registered (every 6 hours)')
}

setupRepeatingJob().catch((err) => {
    console.error('[CatalogSyncWorker] Failed to set up repeating job:', err)
})

worker.on('completed', (job) => {
    console.log('[CatalogSyncWorker] Job completed:', job.id)
})

worker.on('failed', (job, err) => {
    console.error('[CatalogSyncWorker] Job failed:', job?.id, err.message)
})

export { worker as gameCatalogSyncWorker }
