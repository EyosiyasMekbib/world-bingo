/**
 * POST /admin/players/:id/adjust-balance is ADMIN-only, and every adjustment
 * leaves an audit row.
 *
 * The route used to sit in the requireAdminOrClerk scope: a clerk could move
 * real or bonus money in any amount on any account, and nothing recorded who
 * did it. These tests pin both halves of the fix — the scope and the trail.
 *
 * Harness is admin-adjust-balance.test.ts's: a bare Fastify instance with the
 * auth decorators stubbed (no real JWT is verified), except that requireAdmin
 * enforces the role the way index.ts does, which is the thing under test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import Fastify from 'fastify'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma, expectInvariantClean } from './setup'
import { TransactionType } from '@world-bingo/shared-types'

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

import adminRoutes from '../routes/admin/index'

type Actor = { id: string; role: 'ADMIN' | 'CLERK' }

async function buildApp(actor: Actor) {
    const app = Fastify({ logger: false })
    // In production both hooks populate request.user from the JWT and only
    // requireAdmin checks the role, so the clerk-scoped hooks stay permissive
    // here — otherwise a 403 would prove nothing about which scope the route
    // is registered in.
    const setUser = async (request: any) => {
        request.user = { id: actor.id, role: actor.role }
    }
    const requireAdmin = async (request: any, reply: any) => {
        await setUser(request)
        if (actor.role !== 'ADMIN') {
            return reply.status(403).send({ error: 'Forbidden: Admin access only' })
        }
    }
    app.decorate('authenticate', setUser)
    app.decorate('requireAdmin', requireAdmin)
    app.decorate('requireAdminOrClerk', setUser)
    app.decorate('requireSuperAdmin', setUser)
    await app.register(adminRoutes, { prefix: '/admin' })
    await app.ready()
    return app
}

function mk(role: 'PLAYER' | 'ADMIN' | 'CLERK', realBalance = 0, bonusBalance = 0) {
    const rnd = () => Math.random().toString(36).slice(2, 10)
    return prisma.user.create({
        data: {
            username: `adjscope_${role.toLowerCase()}_${rnd()}`,
            phone: `09${Math.floor(10000000 + Math.random() * 89999999)}`,
            passwordHash: 'hashed:x',
            role,
            wallet: { create: { realBalance, bonusBalance } },
        },
    })
}

function auditRowsFor(playerId: string) {
    return prisma.auditLog.findMany({
        where: { action: 'player.balance.adjust', target: `player:${playerId}` },
        orderBy: { createdAt: 'desc' },
    })
}

describe('POST /admin/players/:id/adjust-balance — admin scope + audit trail', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('refuses a CLERK token and moves no money', async () => {
        const player = await mk('PLAYER', 100)
        const clerk = await mk('CLERK')
        const app = await buildApp({ id: clerk.id, role: 'CLERK' })

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/adjust-balance`,
            payload: { type: 'real', amount: 500, note: 'clerk should not be able to do this' },
        })

        expect(res.statusCode).toBe(403)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(new Decimal(wallet.realBalance).toNumber()).toBe(100)
        expect(
            await prisma.transaction.count({
                where: { userId: player.id, type: TransactionType.ADMIN_REAL_ADJUSTMENT },
            }),
        ).toBe(0)
        expect(await auditRowsFor(player.id)).toHaveLength(0)
    })

    it('lets an ADMIN adjust real balance and records who did it', async () => {
        const player = await mk('PLAYER', 100)
        const admin = await mk('ADMIN')
        const app = await buildApp({ id: admin.id, role: 'ADMIN' })

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/adjust-balance`,
            payload: { type: 'real', amount: 250, note: 'goodwill credit' },
        })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toMatchObject({ realBalance: 350 })

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(new Decimal(wallet.realBalance).toNumber()).toBe(350)

        const [audit] = await auditRowsFor(player.id)
        expect(audit).toBeDefined()
        expect(audit.actorId).toBe(admin.id)
        expect(audit.actorName).toBe(admin.username)
        expect(audit.detail).toMatchObject({
            type: 'real',
            requestedAmount: 250,
            appliedDelta: 250,
            note: 'goodwill credit',
        })
    })

    it('audits the applied delta, not the requested one, when a bonus removal clamps', async () => {
        const player = await mk('PLAYER', 0, 30)
        await prisma.bonusGrant.create({
            data: { userId: player.id, amount: 30, remaining: 30, periodStart: new Date(), status: 'ACTIVE' },
        })
        const admin = await mk('ADMIN')
        const app = await buildApp({ id: admin.id, role: 'ADMIN' })

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/adjust-balance`,
            payload: { type: 'bonus', amount: -999, note: 'clawback' },
        })

        expect(res.statusCode).toBe(200)
        expect(res.json().bonusBalance).toBe(0)

        const [audit] = await auditRowsFor(player.id)
        // reduce() clamps at zero, so only 30 ever moved — an audit row saying
        // 999 would overstate what the admin actually took.
        expect(audit.detail).toMatchObject({ type: 'bonus', requestedAmount: -999, appliedDelta: -30 })
    })
})
