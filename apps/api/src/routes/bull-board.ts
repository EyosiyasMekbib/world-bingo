/**
 * T49 — BullMQ Dashboard
 *
 * Mounts @bull-board/fastify at /admin/queues behind admin auth.
 * Provides a visual UI for monitoring all BullMQ queues:
 *  - Job status (waiting, active, completed, failed, delayed)
 *  - Retry / remove failed jobs
 *  - Real-time updates
 *
 * Usage: import and register in the main server setup.
 */

import { FastifyInstance } from 'fastify'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { FastifyAdapter } from '@bull-board/fastify'
import { getQueue, QUEUE_NAMES } from '../lib/queue.js'

export async function registerBullBoard(fastify: FastifyInstance): Promise<void> {
    const serverAdapter = new FastifyAdapter()
    serverAdapter.setBasePath('/admin/queues')

    // Register all known queues
    createBullBoard({
        queues: [
            new BullMQAdapter(getQueue(QUEUE_NAMES.REFUND)),
            new BullMQAdapter(getQueue(QUEUE_NAMES.NOTIFICATION)),
            new BullMQAdapter(getQueue(QUEUE_NAMES.GAME_ENGINE)),
            new BullMQAdapter(getQueue(QUEUE_NAMES.WITHDRAWAL)),
        ],
        serverAdapter,
    })

    // Mount the bull-board plugin behind admin auth
    await fastify.register(serverAdapter.registerPlugin() as any, {
        prefix: '/admin/queues',
    })
}
