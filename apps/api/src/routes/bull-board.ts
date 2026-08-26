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
            new BullMQAdapter(getQueue(QUEUE_NAMES.DEPOSIT_VERIFICATION)),
            new BullMQAdapter(getQueue(QUEUE_NAMES.ZARECASH_DEPOSIT)),
            new BullMQAdapter(getQueue(QUEUE_NAMES.ZARECASH_WITHDRAWAL)),
            new BullMQAdapter(getQueue(QUEUE_NAMES.ZARECASH_EVENT)),
            new BullMQAdapter(getQueue(QUEUE_NAMES.ZARECASH_SWEEP)),
        ],
        serverAdapter,
    })

    // Mount the bull-board plugin behind admin auth.
    //
    // This MUST attach its own guard. registerBullBoard() is called on the ROOT
    // server instance, not inside the `adminRoutes` plugin, so Fastify's
    // encapsulation means the admin auth hooks registered there never reach these
    // routes. Before this scope existed, /admin/queues was fully public — job
    // payloads for the REFUND, WITHDRAWAL and DEPOSIT_VERIFICATION queues (user
    // ids, payment details) plus retry/promote/remove controls.
    //
    // The hook goes on an encapsulated child scope so it covers every route the
    // dashboard registers under the prefix — the UI fetches its data from
    // sub-paths, so guarding only the HTML entry point would still leak everything.
    await fastify.register(async (scoped) => {
        scoped.addHook('onRequest', scoped.requireAdmin)

        await scoped.register(serverAdapter.registerPlugin() as any, {
            prefix: '/admin/queues',
        })
    })
}
