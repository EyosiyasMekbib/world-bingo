import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import helmet from '@fastify/helmet'

// Redis in memory: the simulator keeps its tokens, sessions and tickets there.
const store = vi.hoisted(() => new Map<string, string>())
const redisMock = vi.hoisted(() => ({
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
        store.set(k, v)
        return 'OK'
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    set: vi.fn(async (k: string, v: string, mode?: string) => {
        if (mode === 'NX' && store.has(k)) return null
        store.set(k, v)
        return 'OK'
    }),
    incr: vi.fn(async (k: string) => {
        const n = Number(store.get(k) ?? 0) + 1
        store.set(k, String(n))
        return n
    }),
}))
vi.mock('../lib/redis.js', () => ({ default: redisMock }))

const userCreate = vi.hoisted(() => vi.fn())
vi.mock('../lib/prisma.js', () => ({ default: { user: { create: userCreate } } }))

import { signIgcoreBody } from '../gateways/igcore/igcore-signature.js'
import { IgcoreClient } from '../gateways/igcore/igcore.client.js'

const PUBLIC_URL = 'https://staging-api.example.test'
const CALLBACK_URL = 'http://127.0.0.1:9999/v1/igcore'
const SECRET = 'sim-secret'
const PLAYER = 'b'.repeat(32)

type App = Awaited<ReturnType<typeof buildApp>>

async function buildApp(opts: { requireAdmin?: (req: any, reply: any) => Promise<void>; logLines?: string[] } = {}) {
    const lines = opts.logLines
    // With logLines, Fastify's own request logging is on (as in index.ts) and every line is captured.
    const app = lines ? Fastify({ logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } } }) : Fastify()
    // Helmet with its defaults, which is what index.ts gets in production, so
    // the /book override is tested against the headers it really has to beat.
    await app.register(helmet)
    // Ruling R2: the real decorators live in index.ts.
    app.decorate('authenticate', async () => {})
    app.decorate('requireAdmin', opts.requireAdmin ?? (async () => {}))
    const { igcoreSimRoutes } = await import('../routes/igcore-sim/index.js')
    await app.register(igcoreSimRoutes, { prefix: '/v1/igcore-sim' })
    return app
}

function post(app: App, url: string, body: unknown, headers: Record<string, string> = {}) {
    return app.inject({ method: 'POST', url: `/v1/igcore-sim${url}`, headers, payload: body as any })
}

async function token(app: App): Promise<string> {
    const res = await post(app, '/1.0.0/auth', { username: 'sim-user', password: 'sim-pass' })
    return res.json().token
}

async function session(app: App): Promise<string> {
    const t = await token(app)
    const res = await post(app, '/1.0.0/start-session', { user_id: PLAYER, currency: 'ETB', lang: 'en' }, { authorization: `Bearer ${t}` })
    return new URL(res.json().url).searchParams.get('s')!
}

/** Places a bet through the book and returns its ticket id. */
async function placeBet(app: App, s: string, stake: number, odds: number): Promise<number> {
    const res = await post(app, '/book/action', { s, op: 'bet', stake, odds })
    return res.json().sent.info.ticketId
}

/** Every callback the simulator POSTed, as IGCORE would have sent it. */
const callbacks: Array<{ url: string; hash: string; body: any }> = []
let rowSeq = 0

function answerCallbacks(json: (body: any) => unknown = () => ({ error: null, transaction_id: `row-${++rowSeq}` })) {
    const fetchMock = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
        const body = JSON.parse(init.body)
        callbacks.push({ url: String(url), hash: init.headers['X-Security-Hash'], body })
        return { status: 200, text: async () => JSON.stringify(json(body)) }
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

describe('IGCORE simulator', () => {
    beforeEach(() => {
        store.clear()
        callbacks.length = 0
        rowSeq = 0
        vi.clearAllMocks()
        vi.stubEnv('IGCORE_USERNAME', 'sim-user')
        vi.stubEnv('IGCORE_PASSWORD', 'sim-pass')
        vi.stubEnv('IGCORE_SECURITY_HASH', SECRET)
        vi.stubEnv('IGCORE_CURRENCY', 'ETB')
        vi.stubEnv('IGCORE_DEFAULT_LANG', 'en')
        vi.stubEnv('IGCORE_SIM_PUBLIC_URL', PUBLIC_URL)
        vi.stubEnv('IGCORE_SIM_CALLBACK_URL', CALLBACK_URL)
    })

    afterEach(() => {
        vi.unstubAllEnvs()
        vi.unstubAllGlobals()
    })

    describe('auth and start-session', () => {
        it('refuses a wrong password', async () => {
            const app = await buildApp()

            const res = await post(app, '/1.0.0/auth', { username: 'sim-user', password: 'nope' })

            expect(res.statusCode).toBe(200)
            expect(res.json()).toEqual({ error: 'invalid credentials' })
        })

        it('issues a token for the configured credentials and keeps it in Redis', async () => {
            const app = await buildApp()

            const res = await post(app, '/1.0.0/auth', { username: 'sim-user', password: 'sim-pass' })

            const { token: t, expires_in } = res.json()
            expect(typeof t).toBe('string')
            expect(expires_in).toBe(21600)
            expect(redisMock.setex).toHaveBeenCalledWith(`igcore-sim:token:${t}`, 21600, expect.any(String))
        })

        it('refuses credentials when none are configured', async () => {
            vi.stubEnv('IGCORE_USERNAME', '')
            vi.stubEnv('IGCORE_PASSWORD', '')
            const app = await buildApp()

            const res = await post(app, '/1.0.0/auth', { username: '', password: '' })

            expect(res.json()).toEqual({ error: 'invalid credentials' })
        })

        it('compares both credentials in constant time and refuses near misses', async () => {
            const timingSafeEqual = vi.spyOn(crypto, 'timingSafeEqual')
            const app = await buildApp()

            const sameLength = await post(app, '/1.0.0/auth', { username: 'sim-user', password: 'sim-pasS' })
            const shorter = await post(app, '/1.0.0/auth', { username: 'sim-user', password: 'sim' })
            const notAString = await post(app, '/1.0.0/auth', { username: ['sim-user'], password: 'sim-pass' })

            expect(sameLength.json()).toEqual({ error: 'invalid credentials' })
            expect(shorter.json()).toEqual({ error: 'invalid credentials' })
            expect(notAString.json()).toEqual({ error: 'invalid credentials' })
            // Both credentials are compared on every attempt; only a length
            // mismatch or a non-string skips timingSafeEqual (which would throw):
            // 2 (same length) + 1 (username of the short one) + 1 (password of the array one).
            expect(timingSafeEqual).toHaveBeenCalledTimes(4)
            timingSafeEqual.mockRestore()
        })

        it('answers Unauthorized without a token', async () => {
            const app = await buildApp()

            const res = await post(app, '/1.0.0/start-session', { user_id: PLAYER, currency: 'ETB' })

            expect(res.statusCode).toBe(200)
            expect(res.json()).toEqual({ error: 'Unauthorized' })
        })

        it('answers Unauthorized for a token it never issued', async () => {
            const app = await buildApp()

            const res = await post(app, '/1.0.0/start-session', { user_id: PLAYER, currency: 'ETB' }, { authorization: 'Bearer forged' })

            expect(res.json()).toEqual({ error: 'Unauthorized' })
        })

        it('refuses a currency other than the configured one', async () => {
            const app = await buildApp()
            const t = await token(app)

            const res = await post(app, '/1.0.0/start-session', { user_id: PLAYER, currency: 'USD' }, { authorization: `Bearer ${t}` })

            expect(res.json()).toEqual({ error: 'currency is not allowed' })
        })

        it('opens a session on the public URL and stores it in Redis', async () => {
            const app = await buildApp()
            const t = await token(app)

            const res = await post(app, '/1.0.0/start-session', { user_id: PLAYER, currency: 'ETB', lang: 'am' }, { authorization: `Bearer ${t}` })

            const { url } = res.json()
            expect(url.startsWith(`${PUBLIC_URL}/v1/igcore-sim/book?s=`)).toBe(true)
            const parsed = new URL(url)
            expect(parsed.searchParams.get('lang')).toBe('am')
            const s = parsed.searchParams.get('s')!
            expect(JSON.parse(store.get(`igcore-sim:session:${s}`)!)).toEqual({ user_id: PLAYER, currency: 'ETB' })
            expect(redisMock.setex).toHaveBeenCalledWith(`igcore-sim:session:${s}`, 21600, expect.any(String))
        })

        it('is what the real IgcoreClient talks to when IGCORE_API_URL points at it', async () => {
            const app = await buildApp()
            vi.stubEnv('IGCORE_API_URL', `${PUBLIC_URL}/v1/igcore-sim`)
            vi.stubEnv('IGCORE_API_VERSION', '1.0.0')
            vi.stubGlobal('fetch', async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
                const u = new URL(url)
                const res = await app.inject({ method: init.method as 'POST', url: u.pathname + u.search, headers: init.headers, payload: init.body })
                return { ok: res.statusCode < 300, status: res.statusCode, json: async () => res.json(), text: async () => res.body }
            })

            const { url } = await new IgcoreClient().startSession({ userId: PLAYER, currency: 'ETB', lang: 'en' })

            expect(url.startsWith(`${PUBLIC_URL}/v1/igcore-sim/book?s=`)).toBe(true)
        })
    })

    describe('book page', () => {
        it('can be framed by another origin despite Helmet', async () => {
            const app = await buildApp()
            const s = await session(app)

            const res = await app.inject({ method: 'GET', url: `/v1/igcore-sim/book?s=${s}&lang=en` })

            expect(res.statusCode).toBe(200)
            expect(res.headers['content-type']).toMatch(/^text\/html/)
            expect(res.headers['x-frame-options']).toBeUndefined()
            const csp = String(res.headers['content-security-policy'])
            expect(csp).toContain('frame-ancestors *')
            expect(csp).toBe("default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors *")
        })

        it('is self-contained: no external scripts, styles or images', async () => {
            const app = await buildApp()
            const s = await session(app)

            const res = await app.inject({ method: 'GET', url: `/v1/igcore-sim/book?s=${s}&lang=en` })

            expect(res.body).toContain('<script>')
            expect(res.body).not.toMatch(/\b(src|href)\s*=/i)
            expect(res.body).toContain('book/action')
        })

        it('never writes the session id to the request log', async () => {
            const lines: string[] = []
            answerCallbacks()
            const app = await buildApp({ logLines: lines })
            const s = await session(app)

            await app.inject({ method: 'GET', url: `/v1/igcore-sim/book?s=${s}&lang=en` })
            await app.inject({ method: 'GET', url: `/v1/igcore-sim/book?s=${s}-expired&lang=en` }) // the 404 path
            await post(app, '/book/action', { s, op: 'bet', stake: 10, odds: 2 })
            await post(app, '/book/action', { s, op: 'explode' }) // the 400 path

            // Request logging is on: the start-session request was logged...
            expect(lines.some((l) => l.includes('/v1/igcore-sim/1.0.0/start-session'))).toBe(true)
            // ...but nothing from the book routes, which carry the session id.
            expect(lines.some((l) => l.includes('/v1/igcore-sim/book'))).toBe(false)
            expect(lines.join('\n')).not.toContain(s)
        })

        it('answers 404 for an unknown session and never echoes it', async () => {
            const app = await buildApp()

            const res = await app.inject({ method: 'GET', url: '/v1/igcore-sim/book?s=%3Cscript%3Ex&lang=en' })

            expect(res.statusCode).toBe(404)
            expect(res.headers['x-frame-options']).toBeUndefined()
            expect(res.body).not.toContain('<script>x')
        })
    })

    describe('book actions', () => {
        it('signs a bet and POSTs it to the callback URL, recording the ticket', async () => {
            const fetchMock = answerCallbacks()
            const app = await buildApp()
            const s = await session(app)

            const res = await post(app, '/book/action', { s, op: 'bet', stake: 10, odds: 1.85 })

            expect(res.statusCode).toBe(200)
            expect(fetchMock).toHaveBeenCalledTimes(1)
            const [cb] = callbacks
            expect(cb.url).toBe(`${CALLBACK_URL}/transaction`)
            const raw = (fetchMock.mock.calls[0][1] as { body: string }).body
            expect(cb.hash).toBe(signIgcoreBody(raw, SECRET))
            const id = cb.body.info.ticketId
            expect(cb.body).toMatchObject({ action: 'bet', user_id: PLAYER, currency: 'ETB', amount: 10, info: { ticketId: id } })
            expect(typeof cb.body.transaction_id).toBe('string')
            expect(res.json()).toEqual({ sent: cb.body, response: { status: 200, json: { error: null, transaction_id: 'row-1' } } })
            expect(JSON.parse(store.get(`igcore-sim:ticket:${id}`)!)).toMatchObject({ id, stake: 10, odds: 1.85, status: 'open' })
        })

        it('starts ticket ids from the clock, so an empty or flushed Redis never reissues old ids', async () => {
            answerCallbacks()
            const app = await buildApp()
            const s = await session(app)
            const startedAt = Date.now()

            const first = await placeBet(app, s, 10, 2)
            const second = await placeBet(app, s, 10, 2)
            store.clear() // a Redis flush: sessions, tickets and the sequence are gone
            const s2 = await session(app)
            const afterFlush = await placeBet(app, s2, 10, 2)

            expect(first).toBeGreaterThan(startedAt)
            expect(second).toBe(first + 1)
            expect(afterFlush).toBeGreaterThan(startedAt)
            expect(redisMock.set).toHaveBeenCalledWith('igcore-sim:ticket-seq', expect.any(String), 'NX')
        })

        it('does not record a ticket whose bet was refused', async () => {
            answerCallbacks(() => ({ error: 'INSUFFICIENT_FUNDS' }))
            const app = await buildApp()
            const s = await session(app)

            const res = await post(app, '/book/action', { s, op: 'bet', stake: 10, odds: 2 })

            expect(res.json().response).toEqual({ status: 200, json: { error: 'INSUFFICIENT_FUNDS' } })
            expect(store.has(`igcore-sim:ticket:${res.json().sent.info.ticketId}`)).toBe(false)
        })

        it('settles a win for stake × odds and a loss for 0', async () => {
            answerCallbacks()
            const app = await buildApp()
            const s = await session(app)
            const won = await placeBet(app, s, 10, 1.85)
            const lost = await placeBet(app, s, 5, 3)

            await post(app, '/book/action', { s, op: 'settle-win', ticketId: won })
            await post(app, '/book/action', { s, op: 'settle-lose', ticketId: lost })

            expect(callbacks[2].url).toBe(`${CALLBACK_URL}/transaction`)
            expect(callbacks[2].body).toMatchObject({ action: 'result', amount: 18.5, info: { ticketId: won } })
            expect(callbacks[3].body).toMatchObject({ action: 'result', amount: 0, info: { ticketId: lost } })
            expect(JSON.parse(store.get(`igcore-sim:ticket:${won}`)!)).toMatchObject({ status: 'settled', payout: 18.5 })
        })

        it('refuses to settle a ticket twice', async () => {
            answerCallbacks()
            const app = await buildApp()
            const s = await session(app)
            const id = await placeBet(app, s, 10, 2)
            await post(app, '/book/action', { s, op: 'settle-win', ticketId: id })

            const res = await post(app, '/book/action', { s, op: 'settle-win', ticketId: id })

            expect(res.statusCode).toBe(409)
            expect(callbacks).toHaveLength(2)
        })

        it('cashes out part of a ticket and records the remainder ticket', async () => {
            answerCallbacks()
            const app = await buildApp()
            const s = await session(app)
            const id = await placeBet(app, s, 10, 2)

            await post(app, '/book/action', { s, op: 'cashout', ticketId: id, portion: 0.4 })

            const rest = callbacks[1].body.info.newTicket.id
            expect(rest).toBe(id + 1)
            expect(callbacks[1].body).toMatchObject({ action: 'result', amount: 8, info: { ticketId: id, newTicket: { id: rest, fromId: id } } })
            expect(JSON.parse(store.get(`igcore-sim:ticket:${id}`)!)).toMatchObject({ status: 'cashed' })
            expect(JSON.parse(store.get(`igcore-sim:ticket:${rest}`)!)).toMatchObject({ id: rest, stake: 6, odds: 2, fromId: id, status: 'open' })

            await post(app, '/book/action', { s, op: 'settle-win', ticketId: rest })

            expect(callbacks[2].body).toMatchObject({ action: 'result', amount: 12, info: { ticketId: rest, ticket: { id: rest, fromId: id } } })
        })

        it('rolls back a settlement with its payout and lets the ticket be settled again', async () => {
            answerCallbacks()
            const app = await buildApp()
            const s = await session(app)
            const id = await placeBet(app, s, 10, 2)
            await post(app, '/book/action', { s, op: 'settle-win', ticketId: id })

            await post(app, '/book/action', { s, op: 'rollback-settlement', ticketId: id })

            expect(callbacks[2].url).toBe(`${CALLBACK_URL}/transaction-rollback`)
            expect(callbacks[2].body).toMatchObject({
                action: 'rollback', user_id: PLAYER, amount: 20, rollback_transaction_id: callbacks[1].body.transaction_id,
                rollback_transaction_action: 'result', info: { ticketId: id },
            })
            const reopened = JSON.parse(store.get(`igcore-sim:ticket:${id}`)!)
            expect(reopened).toMatchObject({ status: 'open' })
            expect(reopened.payout).toBeUndefined()
            expect(reopened.resultTxId).toBeUndefined()
        })

        it('simulates a late bet: the bet, then its rollback', async () => {
            answerCallbacks()
            const app = await buildApp()
            const s = await session(app)

            const res = await post(app, '/book/action', { s, op: 'late-bet', stake: 10, odds: 2 })

            expect(callbacks).toHaveLength(2)
            expect(callbacks[0]).toMatchObject({ url: `${CALLBACK_URL}/transaction`, body: { action: 'bet', amount: 10 } })
            expect(callbacks[1].url).toBe(`${CALLBACK_URL}/transaction-rollback`)
            expect(callbacks[1].body).toMatchObject({
                action: 'rollback', rollback_transaction_id: callbacks[0].body.transaction_id, rollback_transaction_action: 'bet',
            })
            expect(res.json().sent).toEqual([callbacks[0].body, callbacks[1].body])
            expect(res.json().response).toHaveLength(2)
        })

        it('answers 404 for an unknown session and sends nothing', async () => {
            const fetchMock = answerCallbacks()
            const app = await buildApp()

            const res = await post(app, '/book/action', { s: 'nope', op: 'bet', stake: 10, odds: 2 })

            expect(res.statusCode).toBe(404)
            expect(fetchMock).not.toHaveBeenCalled()
        })

        it('refuses a ticket that belongs to another session player', async () => {
            answerCallbacks()
            const app = await buildApp()
            const s = await session(app)
            const id = await placeBet(app, s, 10, 2)
            const key = `igcore-sim:ticket:${id}`
            store.set(key, JSON.stringify({ ...JSON.parse(store.get(key)!), user_id: 'c'.repeat(32) }))

            const res = await post(app, '/book/action', { s, op: 'settle-win', ticketId: id })

            expect(res.statusCode).toBe(404)
            expect(callbacks).toHaveLength(1)
        })

        it('rejects an unknown op and a bad stake', async () => {
            answerCallbacks()
            const app = await buildApp()
            const s = await session(app)

            expect((await post(app, '/book/action', { s, op: 'explode' })).statusCode).toBe(400)
            expect((await post(app, '/book/action', { s, op: 'bet', stake: -1, odds: 2 })).statusCode).toBe(400)
            expect(callbacks).toHaveLength(0)
        })
    })

    describe('checklist', () => {
        it('sits behind requireAdmin', async () => {
            const app = await buildApp({
                requireAdmin: async (_req, reply) => reply.status(403).send({ error: 'Forbidden: Admin access only' }),
            })

            const res = await post(app, '/checklist', {})

            expect(res.statusCode).toBe(403)
            expect(userCreate).not.toHaveBeenCalled()
        })
    })
})
