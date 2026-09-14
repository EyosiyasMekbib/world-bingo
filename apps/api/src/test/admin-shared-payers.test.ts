import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { prisma } from './setup'
import fraudAdminRoutes from '../routes/admin/fraud'

let seq = 0
async function player(phone?: string): Promise<string> {
    seq++
    const user = await prisma.user.create({
        data: { username: `cluster-${seq}`, phone: phone ?? `+2519500000${String(seq).padStart(2, '0')}`, passwordHash: 'x' },
    })
    return user.id
}

async function approved(
    userId: string,
    o: { senderAccount?: string; payerNumberMasked?: string; payerName?: string; daysAgo?: number },
): Promise<void> {
    const tx = await prisma.transaction.create({
        data: {
            userId,
            type: 'DEPOSIT',
            amount: 150,
            status: 'APPROVED',
            senderAccount: o.senderAccount,
            createdAt: new Date(Date.now() - (o.daysAgo ?? 1) * 86_400_000),
        },
    })
    if (o.payerNumberMasked) {
        await prisma.depositVerification.create({
            data: { transactionId: tx.id, status: 'MANUAL_REQUIRED', decisionReasons: [], payerNumberMasked: o.payerNumberMasked, payerName: o.payerName },
        })
    }
}

async function get(url: string) {
    const app = Fastify({ logger: false })
    await app.register(fraudAdminRoutes, { prefix: '/admin/fraud' })
    return app.inject({ method: 'GET', url })
}

type Cluster = { signal: string; key: string; accounts: Array<{ userId: string; approvedDeposits: number; firstDepositBonus: boolean }> }

describe('GET /admin/fraud/shared-payers', () => {
    it('groups accounts by sender account, receipt payer and registered phone inside the window', async () => {
        const a = await player()
        const b = await player()
        await approved(a, { senderAccount: '0933444555' })
        await approved(b, { senderAccount: '+251933444555' })

        const c = await player()
        await approved(c, { senderAccount: '0977000000' })

        const d = await player('+251922000222')
        const e = await player()
        await approved(e, { senderAccount: '0922000222' })

        const f = await player()
        const g = await player()
        await approved(f, { payerNumberMasked: '2519****7777', payerName: 'Sara  Tesfaye' })
        await approved(g, { payerNumberMasked: '2519****7777', payerName: 'sara tesfaye' })

        const h = await player()
        const i = await player()
        await approved(h, { senderAccount: '0955000000', daysAgo: 60 })
        await approved(i, { senderAccount: '0955000000', daysAgo: 60 })

        const res = await get('/admin/fraud/shared-payers?days=14')
        expect(res.statusCode).toBe(200)
        const clusters = res.json().clusters as Cluster[]
        const ids = (signal: string, key: string) =>
            clusters.find((cl) => cl.signal === signal && cl.key === key)?.accounts.map((acc) => acc.userId)

        expect(ids('sender_account', '933444555')).toEqual([a, b].sort())
        expect(ids('receipt_payer', '2519****7777|sara tesfaye')).toEqual([f, g].sort())
        expect(ids('registered_phone', '922000222')).toEqual([d, e].sort())
        expect(ids('sender_account', '977000000')).toBeUndefined()
        expect(ids('sender_account', '955000000')).toBeUndefined()
        expect(clusters.find((cl) => cl.key === '933444555')!.accounts[0]).toMatchObject({ approvedDeposits: 1, firstDepositBonus: false })
    })

    it('rejects an out-of-range window', async () => {
        const res = await get('/admin/fraud/shared-payers?days=0')
        expect(res.statusCode).toBe(400)
    })

    // Fix round 1: the receipt_payer candidate fetch now pre-aggregates in SQL
    // (masked-number groups filtered to count(DISTINCT userId) > 1 before any row
    // is fetched) rather than pulling every verified deposit in the window and
    // grouping in JS. These two guard the pre-aggregation didn't change what the
    // endpoint reports.
    it('does not surface a receipt_payer cluster for a masked number used by only one account', async () => {
        const a = await player()
        await approved(a, { payerNumberMasked: '2519****3333', payerName: 'Solomon Girma' })
        await approved(a, { payerNumberMasked: '2519****3333', payerName: 'Solomon Girma' })

        const res = await get('/admin/fraud/shared-payers?days=14')
        expect(res.statusCode).toBe(200)
        const clusters = res.json().clusters as Cluster[]
        expect(
            clusters.find((cl) => cl.signal === 'receipt_payer' && cl.key === '2519****3333|solomon girma'),
        ).toBeUndefined()
    })

    it('respects limit: with limit=1 and two qualifying receipt_payer clusters, exactly one is returned', async () => {
        const a = await player()
        const b = await player()
        await approved(a, { payerNumberMasked: '2519****4444', payerName: 'Amanuel Tesema' })
        await approved(b, { payerNumberMasked: '2519****4444', payerName: 'amanuel tesema' })

        const c = await player()
        const d = await player()
        await approved(c, { payerNumberMasked: '2519****5555', payerName: 'Betelhem Alemu' })
        await approved(d, { payerNumberMasked: '2519****5555', payerName: 'betelhem alemu' })

        const res = await get('/admin/fraud/shared-payers?days=14&limit=1')
        expect(res.statusCode).toBe(200)
        const clusters = res.json().clusters as Cluster[]
        const receiptClusters = clusters.filter((cl) => cl.signal === 'receipt_payer')
        expect(receiptClusters).toHaveLength(1)
    })
})

/**
 * Admin-only wiring. This endpoint returns phone numbers and usernames, so it
 * must only ever be reachable behind `requireAdmin` — never unauthenticated,
 * never through a lower-privilege scope. Mounts the REAL `adminRoutes` plugin
 * (not a reconstruction of its registration) so a mistake like registering
 * `fraudAdminRoutes` outside the `requireAdmin` sub-plugin in
 * `routes/admin/index.ts` would actually be caught here, the same way
 * `admin-approve-route.test.ts` drives approve/decline through the real
 * wiring. Redis/notification/referral are mocked because importing the full
 * admin route tree pulls those modules in transitively, same as that file.
 */
vi.mock('../lib/redis', () => ({
    default: {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        keys: vi.fn().mockResolvedValue([]),
    },
}))
vi.mock('../services/notification.service', () => ({
    NotificationService: {
        pushWalletUpdate: vi.fn(),
        create: vi.fn().mockResolvedValue(undefined),
    },
}))
vi.mock('../services/referral.service', () => ({
    ReferralService: { processFirstDepositBonus: vi.fn().mockResolvedValue(undefined) },
}))

describe('GET /admin/fraud/shared-payers — admin-only access', () => {
    async function buildApp(opts: { authorised: boolean }) {
        const { default: adminRoutes } = await import('../routes/admin/index')
        const app = Fastify({ logger: false })
        const passThrough = async (request: any) => {
            request.user = { id: 'reviewer', role: 'ADMIN' }
        }
        app.decorate('requireAdminOrClerk', passThrough)
        app.decorate('requireSuperAdmin', passThrough)
        app.decorate(
            'requireAdmin',
            opts.authorised
                ? passThrough
                : async (_req: any, reply: any) => reply.status(401).send({ error: 'Unauthorized' }),
        )
        await app.register(adminRoutes, { prefix: '/admin' })
        await app.ready()
        return app
    }

    it('refuses an unauthenticated/non-admin request', async () => {
        const app = await buildApp({ authorised: false })

        const res = await app.inject({ method: 'GET', url: '/admin/fraud/shared-payers' })

        expect(res.statusCode).toBe(401)
        await app.close()
    })

    it('serves an authorised admin request through the real route tree', async () => {
        const app = await buildApp({ authorised: true })

        const res = await app.inject({ method: 'GET', url: '/admin/fraud/shared-payers' })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toMatchObject({ days: 14, clusters: [] })
        await app.close()
    })
})
