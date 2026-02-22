/**
 * T44 — Notification Worker
 *
 * Processes 'send-notification' jobs for any out-of-band notifications
 * (e.g. scheduled reminders, bulk broadcasts). In-request notifications
 * still use NotificationService.create() directly for low latency.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { NotificationService } from '../services/notification.service.js'
import { NotificationType } from '@world-bingo/shared-types'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

export interface NotificationJobData {
    userId: string
    type: NotificationType
    title: string
    body: string
    metadata?: Record<string, unknown>
}

const worker = new Worker<NotificationJobData>(
    QUEUE_NAMES.NOTIFICATION,
    async (job: Job<NotificationJobData>) => {
        const { userId, type, title, body, metadata } = job.data
        console.log(`[NotificationWorker] Sending ${type} to user ${userId}`)

        await NotificationService.create(userId, type, title, body, metadata)
        return { sent: true }
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 20,
    },
)

worker.on('completed', (job) => {
    console.log(`[NotificationWorker] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
    console.error(`[NotificationWorker] Job ${job?.id} failed:`, err.message)
})

export default worker
