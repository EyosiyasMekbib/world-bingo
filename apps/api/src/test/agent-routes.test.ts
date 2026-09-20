/**
 * HTTP coverage for the cash-agent deposit network.
 *
 * The services are mocked wholesale: this file is about the route layer's own
 * job — who is allowed in, which service error becomes which status and body,
 * which paths resolve, and that the two endpoints taking a six-digit code are
 * actually throttled. The error classes are declared here and handed to both
 * mocked modules, so the `instanceof` checks in the routes and the assertions
 * below are talking about the same classes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'

vi.mock('../lib/redis', () => ({
    default: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        setex: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        keys: vi.fn().mockResolvedValue([]),
    },
}))

const h = vi.hoisted(() => {
    class AgentNotFoundError extends Error {}
    class UsernameTakenError extends Error {
        constructor() {
            super('Username already taken')
        }
    }
    class InsufficientFloatError extends Error {
        constructor(public float: string, public required: string) {
            super('Insufficient float')
        }
    }
    class RequestNotFoundError extends Error {}
    class RequestAlreadyFulfilledError extends Error {
        constructor(public fulfilledAt: string) {
            super('Already fulfilled')
        }
    }
    class RequestExpiredError extends Error {
        constructor(public expiredAt: string) {
            super('Expired')
        }
    }
    class AmountOutOfRangeError extends Error {
        constructor(public min: string, public max: string) {
            super('Amount out of range')
        }
    }
    class AgentSuspendedError extends Error {}

    return {
        AgentNotFoundError,
        UsernameTakenError,
        InsufficientFloatError,
        RequestNotFoundError,
        RequestAlreadyFulfilledError,
        RequestExpiredError,
        AmountOutOfRangeError,
        AgentSuspendedError,
        AgentService: {
            listAgents: vi.fn(),
            createAgent: vi.fn(),
            getAgent: vi.fn(),
            updateAgent: vi.fn(),
            adjustFloat: vi.fn(),
            getLedger: vi.fn(),
            getSettings: vi.fn(),
            updateSettings: vi.fn(),
            getAgentByUserId: vi.fn(),
            getDashboard: vi.fn(),
        },
        AgentDepositService: {
            createRequest: vi.fn(),
            getActiveRequest: vi.fn(),
            cancelActiveRequest: vi.fn(),
            lookupByCode: vi.fn(),
            fulfill: vi.fn(),
        },
        AccountStatusService: {
            current: vi.fn().mockResolvedValue('ACTIVE'),
            suspend: vi.fn(),
            reinstate: vi.fn(),
        },
    }
})

// The factories are written out at each call site because `vi.mock` is hoisted
// above every const in this file.
vi.mock('../services/agent.service', () => ({
    AgentService: h.AgentService,
    AgentNotFoundError: h.AgentNotFoundError,
    InsufficientFloatError: h.InsufficientFloatError,
    UsernameTakenError: h.UsernameTakenError,
}))

vi.mock('../services/agent-deposit.service', () => ({
    AgentDepositService: h.AgentDepositService,
    RequestNotFoundError: h.RequestNotFoundError,
    RequestAlreadyFulfilledError: h.RequestAlreadyFulfilledError,
    RequestExpiredError: h.RequestExpiredError,
    AmountOutOfRangeError: h.AmountOutOfRangeError,
    AgentSuspendedError: h.AgentSuspendedError,
}))

// The admin route imports this one with an explicit `.js`, which resolves to
// the same module; mocking the extensionless path covers both.
vi.mock('../services/account-status.service', () => ({
    AccountStatusService: h.AccountStatusService,
    STATUS_CATEGORIES: ['RECEIPT_FRAUD', 'CHARGEBACK', 'BONUS_ABUSE', 'MULTI_ACCOUNT', 'OTHER'],
}))

import agentRoutes from '../routes/agent/index'
import agentAdminRoutes from '../routes/admin/agents'
import walletRoutes from '../routes/wallet/index'

const AGENT = { id: 'agent-user-1', role: 'AGENT' }
const ADMIN = { id: 'admin-1', role: 'ADMIN' }
const PLAYER = { id: 'player-1', role: 'PLAYER' }

async function buildApp(user: Record<string, string> = AGENT, opts: { limiter?: boolean } = {}) {
    const app = Fastify({ logger: false })
    const setUser = async (request: any) => {
        request.user = user
    }
    app.decorate('authenticate', setUser)
    app.decorate('requireActiveAccount', async () => {})
    app.decorate('requireAdmin', setUser)
    app.decorate('requireAdminOrClerk', setUser)
    app.decorate('requireSuperAdmin', setUser)
    if (opts.limiter) await app.register(rateLimit, { global: false })
    await app.register(agentRoutes, { prefix: '/agent' })
    // Mirrors ./routes/admin/index.ts: the agent admin routes carry no auth of
    // their own and inherit the admin plugin's requireAdmin scope.
    await app.register(
        async (f) => {
            f.addHook('preValidation', f.requireAdmin)
            await f.register(agentAdminRoutes, { prefix: '/agents' })
        },
        { prefix: '/admin' },
    )
    await app.register(walletRoutes, { prefix: '/wallet' })
    await app.ready()
    return app
}

beforeEach(() => {
    vi.clearAllMocks()
    h.AccountStatusService.current.mockResolvedValue('ACTIVE')
})

// ── The agent guard ───────────────────────────────────────────────────────────

describe('the /agent prefix is AGENT-only', () => {
    it.each(['PLAYER', 'CLERK', 'ADMIN'])('refuses a %s token with 403', async (role) => {
        const app = await buildApp({ id: 'u1', role })

        const res = await app.inject({ method: 'GET', url: '/agent/me' })

        expect(res.statusCode).toBe(403)
        expect(res.json().error).toMatch(/agent/i)
        expect(h.AgentService.getDashboard).not.toHaveBeenCalled()
        await app.close()
    })

    it('lets an AGENT through to the dashboard', async () => {
        h.AgentService.getDashboard.mockResolvedValue({ id: 'a1', shopName: 'Bole Shop', float: '1000.00' })
        const app = await buildApp()

        const res = await app.inject({ method: 'GET', url: '/agent/me' })

        expect(res.statusCode).toBe(200)
        expect(res.json().shopName).toBe('Bole Shop')
        expect(h.AgentService.getDashboard).toHaveBeenCalledWith(AGENT.id)
        await app.close()
    })

    it('refuses a SUSPENDED or RESTRICTED account before the role is even considered', async () => {
        // requireActiveAccount is the real decorator in production; here it
        // stands in for it, to prove the agent routes run it at all.
        const app = Fastify({ logger: false })
        app.decorate('authenticate', async (request: any) => {
            request.user = AGENT
        })
        app.decorate('requireActiveAccount', async (_req: any, reply: any) =>
            reply.status(403).send({ error: 'account_restricted' }),
        )
        await app.register(agentRoutes, { prefix: '/agent' })
        await app.ready()

        const res = await app.inject({ method: 'GET', url: '/agent/me' })

        expect(res.statusCode).toBe(403)
        expect(res.json().error).toBe('account_restricted')
        await app.close()
    })
})

// ── Error mapping, identical on lookup and fulfil ─────────────────────────────

const CODE = '123456'

const cases: Array<{
    name: string
    error: () => Error
    status: number
    body: Record<string, unknown>
}> = [
    { name: 'RequestNotFoundError', error: () => new h.RequestNotFoundError(), status: 404, body: { error: 'NOT_FOUND' } },
    {
        name: 'RequestAlreadyFulfilledError',
        error: () => new h.RequestAlreadyFulfilledError('2026-09-18T10:00:00.000Z'),
        status: 409,
        body: { error: 'ALREADY_FULFILLED', fulfilledAt: '2026-09-18T10:00:00.000Z' },
    },
    {
        name: 'RequestExpiredError',
        error: () => new h.RequestExpiredError('2026-09-18T09:00:00.000Z'),
        status: 410,
        body: { error: 'EXPIRED', expiredAt: '2026-09-18T09:00:00.000Z' },
    },
    {
        name: 'InsufficientFloatError',
        error: () => new h.InsufficientFloatError('40.00', '250.00'),
        status: 422,
        body: { error: 'INSUFFICIENT_FLOAT', float: '40.00', required: '250.00' },
    },
    { name: 'AgentSuspendedError', error: () => new h.AgentSuspendedError(), status: 403, body: { error: 'SUSPENDED' } },
]

describe('GET /agent/requests/:code', () => {
    it('returns what the service hands back, masked fields and all', async () => {
        h.AgentDepositService.lookupByCode.mockResolvedValue({
            code: CODE,
            amount: '250.00',
            expiresAt: '2026-09-18T10:05:00.000Z',
            player: { name: 'Almaz Tesfaye', phoneTail: '•••• 4321', since: '2026-01-02', depositCount: 4 },
        })
        const app = await buildApp()

        const res = await app.inject({ method: 'GET', url: `/agent/requests/${CODE}` })

        expect(res.statusCode).toBe(200)
        expect(res.json().player.phoneTail).toBe('•••• 4321')
        expect(h.AgentDepositService.lookupByCode).toHaveBeenCalledWith(CODE)
        await app.close()
    })

    it.each(cases)('maps $name to $status', async ({ error, status, body }) => {
        h.AgentDepositService.lookupByCode.mockRejectedValue(error())
        const app = await buildApp()

        const res = await app.inject({ method: 'GET', url: `/agent/requests/${CODE}` })

        expect(res.statusCode).toBe(status)
        expect(res.json()).toMatchObject(body)
        await app.close()
    })

    // A 400 would confirm which strings are worth trying at all, which is one
    // bit more than a bearer token for cash should ever give away.
    it.each(['12345', '1234567', 'abcdef', '12 456', '', '12345a'])(
        'answers a malformed code %j with the same 404 an unknown code gets',
        async (code) => {
            const app = await buildApp()

            const res = await app.inject({ method: 'GET', url: `/agent/requests/${encodeURIComponent(code)}` })

            expect(res.statusCode).toBe(404)
            if (code !== '') expect(res.json()).toEqual({ error: 'NOT_FOUND' })
            expect(h.AgentDepositService.lookupByCode).not.toHaveBeenCalled()
            await app.close()
        },
    )
})

describe('POST /agent/requests/:code/fulfill', () => {
    it('hands the code and the agent user id to the service', async () => {
        h.AgentDepositService.fulfill.mockResolvedValue({
            reference: 'tx-1',
            amount: '250.00',
            code: CODE,
            fulfilledAt: '2026-09-18T10:01:00.000Z',
            floatAfter: '750.00',
            player: { name: 'Almaz Tesfaye' },
        })
        const app = await buildApp()

        const res = await app.inject({ method: 'POST', url: `/agent/requests/${CODE}/fulfill` })

        expect(res.statusCode).toBe(200)
        expect(res.json().floatAfter).toBe('750.00')
        expect(h.AgentDepositService.fulfill).toHaveBeenCalledWith(CODE, AGENT.id)
        await app.close()
    })

    it.each(cases)('maps $name to $status', async ({ error, status, body }) => {
        h.AgentDepositService.fulfill.mockRejectedValue(error())
        const app = await buildApp()

        const res = await app.inject({ method: 'POST', url: `/agent/requests/${CODE}/fulfill` })

        expect(res.statusCode).toBe(status)
        expect(res.json()).toMatchObject(body)
        await app.close()
    })

    it('refuses a malformed code without touching the service', async () => {
        const app = await buildApp()

        const res = await app.inject({ method: 'POST', url: '/agent/requests/12345/fulfill' })

        expect(res.statusCode).toBe(404)
        expect(res.json()).toEqual({ error: 'NOT_FOUND' })
        expect(h.AgentDepositService.fulfill).not.toHaveBeenCalled()
        await app.close()
    })
})

describe('the code endpoints are throttled', () => {
    it('stops a lookup flood well short of a six-digit space', async () => {
        h.AgentDepositService.lookupByCode.mockRejectedValue(new h.RequestNotFoundError())
        const app = await buildApp(AGENT, { limiter: true })

        const statuses: number[] = []
        for (let i = 0; i < 40; i++) {
            const res = await app.inject({ method: 'GET', url: `/agent/requests/${String(100000 + i)}` })
            statuses.push(res.statusCode)
        }

        expect(statuses).toContain(429)
        expect(statuses.filter((s) => s === 404).length).toBeLessThan(40)
        await app.close()
    })

    it('throttles fulfil too, because its 404 answers the same question', async () => {
        h.AgentDepositService.fulfill.mockRejectedValue(new h.RequestNotFoundError())
        const app = await buildApp(AGENT, { limiter: true })

        const statuses: number[] = []
        for (let i = 0; i < 40; i++) {
            const res = await app.inject({ method: 'POST', url: `/agent/requests/${String(200000 + i)}/fulfill` })
            statuses.push(res.statusCode)
        }

        expect(statuses).toContain(429)
        await app.close()
    })
})

// ── Agent ledger ──────────────────────────────────────────────────────────────

describe('GET /agent/ledger', () => {
    it('resolves the agent from the token and passes the filters through', async () => {
        h.AgentService.getAgentByUserId.mockResolvedValue({ id: 'agent-1' })
        h.AgentService.getLedger.mockResolvedValue({ rows: [], total: 0, summary: {} })
        const app = await buildApp()

        const res = await app.inject({
            method: 'GET',
            url: '/agent/ledger?from=2026-09-01&to=2026-09-18&type=TOP_UP&page=2&pageSize=25',
        })

        expect(res.statusCode).toBe(200)
        expect(h.AgentService.getAgentByUserId).toHaveBeenCalledWith(AGENT.id)
        expect(h.AgentService.getLedger).toHaveBeenCalledWith('agent-1', {
            from: new Date('2026-09-01'),
            to: new Date('2026-09-18'),
            type: 'TOP_UP',
            page: 2,
            pageSize: 25,
        })
        await app.close()
    })

    it('treats a cleared type filter as no filter', async () => {
        h.AgentService.getAgentByUserId.mockResolvedValue({ id: 'agent-1' })
        h.AgentService.getLedger.mockResolvedValue({ rows: [], total: 0, summary: {} })
        const app = await buildApp()

        const res = await app.inject({ method: 'GET', url: '/agent/ledger?type=&page=1&pageSize=25' })

        expect(res.statusCode).toBe(200)
        expect(h.AgentService.getLedger.mock.calls[0][1]).toMatchObject({ type: undefined })
        await app.close()
    })

    it('rejects an unknown ledger type with 400', async () => {
        const app = await buildApp()

        const res = await app.inject({ method: 'GET', url: '/agent/ledger?type=NONSENSE' })

        expect(res.statusCode).toBe(400)
        expect(h.AgentService.getLedger).not.toHaveBeenCalled()
        await app.close()
    })
})

// ── Admin ─────────────────────────────────────────────────────────────────────

describe('/admin/agents', () => {
    it('lists agents', async () => {
        h.AgentService.listAgents.mockResolvedValue({ agents: [], summary: { floatOutstanding: '0.00' } })
        const app = await buildApp(ADMIN)

        const res = await app.inject({ method: 'GET', url: '/admin/agents' })

        expect(res.statusCode).toBe(200)
        expect(res.json().summary.floatOutstanding).toBe('0.00')
        await app.close()
    })

    it('creates an agent with 201', async () => {
        h.AgentService.createAgent.mockResolvedValue({ id: 'agent-1', shopName: 'Bole Shop' })
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/agents',
            payload: { username: 'bole_shop', password: 'correct horse', shopName: 'Bole Shop' },
        })

        expect(res.statusCode).toBe(201)
        expect(h.AgentService.createAgent).toHaveBeenCalledWith({
            username: 'bole_shop',
            password: 'correct horse',
            shopName: 'Bole Shop',
        })
        await app.close()
    })

    it('turns a taken username into a 409', async () => {
        h.AgentService.createAgent.mockRejectedValue(new h.UsernameTakenError())
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/agents',
            payload: { username: 'bole_shop', password: 'correct horse', shopName: 'Bole Shop' },
        })

        expect(res.statusCode).toBe(409)
        expect(res.json().error).toMatch(/taken/i)
        await app.close()
    })

    it('rejects a short password before it reaches the service', async () => {
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/agents',
            payload: { username: 'bole_shop', password: 'short', shopName: 'Bole Shop' },
        })

        expect(res.statusCode).toBe(400)
        expect(h.AgentService.createAgent).not.toHaveBeenCalled()
        await app.close()
    })

    // The parameterised route would otherwise swallow this and look up an agent
    // whose id is the literal string "settings".
    it('resolves /settings ahead of /:id', async () => {
        h.AgentService.getSettings.mockResolvedValue({
            commissionRate: 5,
            depositMin: '50.00',
            depositMax: '5000.00',
            codeTtlSeconds: 900,
        })
        const app = await buildApp(ADMIN)

        const res = await app.inject({ method: 'GET', url: '/admin/agents/settings' })

        expect(res.statusCode).toBe(200)
        expect(res.json().codeTtlSeconds).toBe(900)
        expect(h.AgentService.getSettings).toHaveBeenCalled()
        expect(h.AgentService.getAgent).not.toHaveBeenCalled()
        await app.close()
    })

    it('still routes a real id to /:id', async () => {
        h.AgentService.getAgent.mockResolvedValue({ agent: { id: 'agent-1', userId: 'u-1' }, stats: {}, ledger: [] })
        const app = await buildApp(ADMIN)

        const res = await app.inject({ method: 'GET', url: '/admin/agents/agent-1' })

        expect(res.statusCode).toBe(200)
        expect(h.AgentService.getAgent).toHaveBeenCalledWith('agent-1')
        expect(h.AgentService.getSettings).not.toHaveBeenCalled()
        await app.close()
    })

    it('saves settings with the acting admin as the actor', async () => {
        h.AgentService.updateSettings.mockResolvedValue({ ok: true })
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'PUT',
            url: '/admin/agents/settings',
            payload: { commissionRate: 5, depositMin: '50.00', depositMax: '5000.00' },
        })

        expect(res.statusCode).toBe(200)
        expect(h.AgentService.updateSettings).toHaveBeenCalledWith(
            { commissionRate: 5, depositMin: '50.00', depositMax: '5000.00' },
            ADMIN.id,
        )
        await app.close()
    })

    it('refuses a settings pair whose minimum is above its maximum', async () => {
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'PUT',
            url: '/admin/agents/settings',
            payload: { commissionRate: 5, depositMin: '5000.00', depositMax: '50.00' },
        })

        expect(res.statusCode).toBe(400)
        expect(h.AgentService.updateSettings).not.toHaveBeenCalled()
        await app.close()
    })

    it('renames a shop', async () => {
        h.AgentService.updateAgent.mockResolvedValue({ id: 'agent-1', shopName: 'Piassa Shop' })
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'PATCH',
            url: '/admin/agents/agent-1',
            payload: { shopName: 'Piassa Shop' },
        })

        expect(res.statusCode).toBe(200)
        expect(h.AgentService.updateAgent).toHaveBeenCalledWith('agent-1', { shopName: 'Piassa Shop' })
        await app.close()
    })
})

describe('POST /admin/agents/:id/float', () => {
    it('issues float against cash already received', async () => {
        h.AgentService.adjustFloat.mockResolvedValue({ float: '10500.00' })
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/agents/agent-1/float',
            payload: { direction: 'CREDIT', cashReceived: '10000.00', commissionAmount: '500.00', note: 'CBE ref 99' },
        })

        expect(res.statusCode).toBe(200)
        expect(h.AgentService.adjustFloat).toHaveBeenCalledWith({
            agentId: 'agent-1',
            direction: 'CREDIT',
            cashReceived: '10000.00',
            commissionAmount: '500.00',
            note: 'CBE ref 99',
            actorId: ADMIN.id,
        })
        await app.close()
    })

    // Float is credit already paid for. Clawing back more than is left would
    // mint a negative balance, so the service refuses and this is the answer.
    it('refuses a debit that would overdraw the float with 422', async () => {
        h.AgentService.adjustFloat.mockRejectedValue(new h.InsufficientFloatError('120.00', '500.00'))
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/agents/agent-1/float',
            payload: { direction: 'DEBIT', cashReceived: '500.00' },
        })

        expect(res.statusCode).toBe(422)
        expect(res.json()).toEqual({ error: 'INSUFFICIENT_FLOAT', float: '120.00', required: '500.00' })
        await app.close()
    })

    it('rejects a non-positive amount and an unknown direction', async () => {
        const app = await buildApp(ADMIN)

        const zero = await app.inject({
            method: 'POST',
            url: '/admin/agents/agent-1/float',
            payload: { direction: 'CREDIT', cashReceived: '0' },
        })
        const sideways = await app.inject({
            method: 'POST',
            url: '/admin/agents/agent-1/float',
            payload: { direction: 'SIDEWAYS', cashReceived: '10' },
        })

        expect(zero.statusCode).toBe(400)
        expect(sideways.statusCode).toBe(400)
        expect(h.AgentService.adjustFloat).not.toHaveBeenCalled()
        await app.close()
    })
})

describe('POST /admin/agents/:id/status', () => {
    it('suspends through AccountStatusService, keyed on the user id', async () => {
        h.AgentService.getAgent.mockResolvedValue({ agent: { id: 'agent-1', userId: 'user-9' }, stats: {}, ledger: [] })
        h.AccountStatusService.suspend.mockResolvedValue({ accountStatus: 'SUSPENDED' })
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/agents/agent-1/status',
            payload: { status: 'SUSPENDED', reason: 'float unaccounted for', category: 'OTHER' },
        })

        expect(res.statusCode).toBe(200)
        expect(h.AccountStatusService.suspend).toHaveBeenCalledWith('user-9', {
            reason: 'float unaccounted for',
            category: 'OTHER',
            actorId: ADMIN.id,
        })
        await app.close()
    })

    it('reinstates on ACTIVE', async () => {
        h.AgentService.getAgent.mockResolvedValue({ agent: { id: 'agent-1', userId: 'user-9' }, stats: {}, ledger: [] })
        h.AccountStatusService.reinstate.mockResolvedValue({ accountStatus: 'ACTIVE' })
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/agents/agent-1/status',
            payload: { status: 'ACTIVE', reason: 'reconciled' },
        })

        expect(res.statusCode).toBe(200)
        expect(h.AccountStatusService.reinstate).toHaveBeenCalledWith('user-9', {
            reason: 'reconciled',
            actorId: ADMIN.id,
        })
        expect(h.AccountStatusService.suspend).not.toHaveBeenCalled()
        await app.close()
    })

    it('requires a reason', async () => {
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/agents/agent-1/status',
            payload: { status: 'SUSPENDED', reason: 'x' },
        })

        expect(res.statusCode).toBe(400)
        expect(h.AccountStatusService.suspend).not.toHaveBeenCalled()
        await app.close()
    })

    it('404s an unknown agent', async () => {
        h.AgentService.getAgent.mockRejectedValue(new h.AgentNotFoundError())
        const app = await buildApp(ADMIN)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/agents/nope/status',
            payload: { status: 'SUSPENDED', reason: 'float unaccounted for' },
        })

        expect(res.statusCode).toBe(404)
        expect(h.AccountStatusService.suspend).not.toHaveBeenCalled()
        await app.close()
    })
})

// ── Player ────────────────────────────────────────────────────────────────────

describe('the player half, on /wallet', () => {
    it('reports the configured limits', async () => {
        h.AgentService.getSettings.mockResolvedValue({
            commissionRate: 5,
            depositMin: '50.00',
            depositMax: '5000.00',
            codeTtlSeconds: 900,
        })
        const app = await buildApp(PLAYER)

        const res = await app.inject({ method: 'GET', url: '/wallet/agent-deposit/limits' })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ min: '50.00', max: '5000.00', ttlSeconds: 900 })
        await app.close()
    })

    it('returns null when there is no live code', async () => {
        h.AgentDepositService.getActiveRequest.mockResolvedValue(null)
        const app = await buildApp(PLAYER)

        const res = await app.inject({ method: 'GET', url: '/wallet/agent-deposit/active' })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toBeNull()
        await app.close()
    })

    it('creates a request with 201', async () => {
        h.AgentDepositService.createRequest.mockResolvedValue({ id: 'r1', code: CODE, amount: '250.00' })
        const app = await buildApp(PLAYER)

        const res = await app.inject({
            method: 'POST',
            url: '/wallet/agent-deposit/request',
            payload: { amount: 250 },
        })

        expect(res.statusCode).toBe(201)
        expect(res.json().code).toBe(CODE)
        expect(h.AgentDepositService.createRequest).toHaveBeenCalledWith(PLAYER.id, 250)
        await app.close()
    })

    it('names the limits in force when the amount is out of range', async () => {
        h.AgentDepositService.createRequest.mockRejectedValue(new h.AmountOutOfRangeError('50.00', '5000.00'))
        const app = await buildApp(PLAYER)

        const res = await app.inject({
            method: 'POST',
            url: '/wallet/agent-deposit/request',
            payload: { amount: 10 },
        })

        expect(res.statusCode).toBe(400)
        expect(res.json().error).toContain('50.00')
        expect(res.json().error).toContain('5000.00')
        await app.close()
    })

    it('rejects a non-positive amount before the service sees it', async () => {
        const app = await buildApp(PLAYER)

        const res = await app.inject({
            method: 'POST',
            url: '/wallet/agent-deposit/request',
            payload: { amount: '-5' },
        })

        expect(res.statusCode).toBe(400)
        expect(h.AgentDepositService.createRequest).not.toHaveBeenCalled()
        await app.close()
    })

    it('cancels the live code', async () => {
        h.AgentDepositService.cancelActiveRequest.mockResolvedValue(undefined)
        const app = await buildApp(PLAYER)

        const res = await app.inject({ method: 'DELETE', url: '/wallet/agent-deposit/active' })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ success: true })
        expect(h.AgentDepositService.cancelActiveRequest).toHaveBeenCalledWith(PLAYER.id)
        await app.close()
    })
})
