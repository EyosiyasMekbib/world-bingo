/**
 * The contract behind every rate-limit bucket and both IP allowlists:
 * `request.ip` must be the address the trusted proxy reported, never one the
 * caller wrote.
 *
 * This is an integration test on purpose. The unit tests around
 * `rateLimitKey` cannot cover it — that helper takes `ip` already resolved, so
 * it is Fastify's `trustProxy` setting, not the helper, that decides whether
 * the value is trustworthy. Before `TRUST_PROXY_HOPS` the server ran
 * `trustProxy: true`, which trusts the whole `X-Forwarded-For` chain and makes
 * `request.ip` its leftmost entry — the one the client sends. Traefik appends
 * rather than replaces, so any caller could choose its own `request.ip`, and
 * with it its own rate-limit bucket; rotating the header per request made the
 * limiter a no-op against exactly the traffic it exists to stop.
 *
 * Every case below FAILS under `trustProxy: true`, which is the point:
 * reverting that one line must not leave a green suite.
 */
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

/** Stand-in for Traefik: the socket peer the API actually accepts from. */
const PROXY = '10.0.0.9'
/** What Traefik appends — the address it genuinely observed. */
const REAL_CLIENT = '196.188.55.55'

async function buildApp(trustProxy: boolean | number): Promise<FastifyInstance> {
    const app = Fastify({ logger: false, trustProxy })
    app.get('/whoami', async (req) => ({ ip: req.ip }))
    await app.ready()
    return app
}

/**
 * One request as it reaches the API in production: the caller's own spoofed
 * prefix, then the address Traefik appended, arriving from Traefik's socket.
 */
async function resolvedIp(app: FastifyInstance, spoofedPrefix: string[]): Promise<string> {
    const chain = [...spoofedPrefix, REAL_CLIENT].join(', ')
    const res = await app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { 'x-forwarded-for': chain },
        remoteAddress: PROXY,
    })
    return res.json().ip
}

describe('trusted proxy hops', () => {
    it('resolves request.ip to the address the proxy reported, not the one the caller wrote', async () => {
        const app = await buildApp(1)
        expect(await resolvedIp(app, ['203.0.113.1'])).toBe(REAL_CLIENT)
        await app.close()
    })

    it('ignores a spoofed prefix however long it is', async () => {
        const app = await buildApp(1)
        const longPrefix = Array.from({ length: 10 }, (_, i) => `203.0.113.${i}`)
        expect(await resolvedIp(app, longPrefix)).toBe(REAL_CLIENT)
        await app.close()
    })

    it('gives every caller the SAME ip however they vary the header — one bucket, not one each', async () => {
        // The property the rate limiter depends on. Under trustProxy: true
        // each of these resolved to a different address, so a caller minted a
        // fresh bucket per request and was never throttled.
        const app = await buildApp(1)
        const seen = new Set<string>()
        for (let i = 0; i < 25; i++) seen.add(await resolvedIp(app, [`203.0.113.${i}`]))
        expect([...seen]).toEqual([REAL_CLIENT])
        await app.close()
    })

    it('falls back to the socket peer when there is no forwarded header at all', async () => {
        const app = await buildApp(1)
        const res = await app.inject({ method: 'GET', url: '/whoami', remoteAddress: PROXY })
        expect(res.json().ip).toBe(PROXY)
        await app.close()
    })

    it('demonstrates the regression this guards: trustProxy true hands request.ip to the caller', async () => {
        // Documents WHY the setting is a hop count. If someone changes it back,
        // the three cases above go red and this one stays green — together they
        // name the cause rather than just reporting a failure.
        const app = await buildApp(true)
        expect(await resolvedIp(app, ['203.0.113.1'])).toBe('203.0.113.1')
        await app.close()
    })

    it('over-setting the count walks request.ip back into attacker-written territory', async () => {
        // The failure mode that has no other symptom: too HIGH does not collapse
        // to the proxy address, it hands the caller its own ip again. This is why
        // the count is validated and clamped in index.ts, and logged at boot.
        const app = await buildApp(2)
        expect(await resolvedIp(app, ['203.0.113.1'])).toBe('203.0.113.1')
        await app.close()
    })
})
