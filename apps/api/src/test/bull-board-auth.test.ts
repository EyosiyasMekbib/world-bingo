import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { registerBullBoard } from '../routes/bull-board'

/**
 * The Bull-Board dashboard exposes job payloads for the REFUND, WITHDRAWAL and
 * DEPOSIT_VERIFICATION queues — user ids and payment details — plus retry,
 * promote and remove controls.
 *
 * It is mounted on the ROOT server instance (index.ts), not inside the
 * `adminRoutes` plugin, so Fastify's encapsulation means the admin auth hooks
 * registered in that plugin never apply to it. The guard has to be attached by
 * `registerBullBoard` itself.
 *
 * These tests exercise the real wiring: a bare Fastify instance is decorated
 * with a stand-in `requireAdmin`, and we assert the mount actually consults it.
 */
describe('registerBullBoard — authentication', () => {
    /** Build an app whose `requireAdmin` either rejects or passes. */
    async function buildApp(opts: { authorised: boolean }) {
        const app = Fastify()
        const calls: string[] = []

        app.decorate('requireAdmin', async function (req: any, reply: any) {
            calls.push(req.url)
            if (!opts.authorised) {
                return reply.status(401).send({ error: 'Unauthorized' })
            }
        } as any)

        await registerBullBoard(app as any)
        await app.ready()
        return { app, calls }
    }

    it('rejects an unauthenticated request to the dashboard entry point', async () => {
        const { app } = await buildApp({ authorised: false })

        const res = await app.inject({ method: 'GET', url: '/admin/queues' })

        expect(res.statusCode).toBe(401)
        await app.close()
    })

    it('rejects an unauthenticated request to the dashboard API sub-path', async () => {
        // The UI fetches its data from sub-paths under the same prefix. Guarding
        // only the HTML entry point would still leak every job payload.
        const { app } = await buildApp({ authorised: false })

        const res = await app.inject({ method: 'GET', url: '/admin/queues/api/queues' })

        expect(res.statusCode).toBe(401)
        await app.close()
    })

    it('consults requireAdmin on dashboard requests', async () => {
        const { app, calls } = await buildApp({ authorised: false })

        await app.inject({ method: 'GET', url: '/admin/queues' })

        expect(calls.length).toBeGreaterThan(0)
        await app.close()
    })

    it('does not block an authorised admin', async () => {
        // Guards that 401 everyone are not a fix — the dashboard must still work.
        const { app } = await buildApp({ authorised: true })

        const res = await app.inject({ method: 'GET', url: '/admin/queues' })

        expect(res.statusCode).not.toBe(401)
        await app.close()
    })
})
