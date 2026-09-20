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

    it('refuses an adjustment past the cap, in either direction, and moves no money', async () => {
        // The scope move and the audit row both landed; neither stops a mistyped
        // digit. An admin who means 100000 and types 1000000 moves ten times the
        // money and the audit row only records it afterwards.
        const player = await mk('PLAYER', 100)
        const admin = await mk('ADMIN')
        const app = await buildApp({ id: admin.id, role: 'ADMIN' })

        for (const amount of [100_001, -100_001]) {
            const res = await app.inject({
                method: 'POST',
                url: `/admin/players/${player.id}/adjust-balance`,
                payload: { type: 'real', amount, note: 'fat finger' },
            })
            expect(res.statusCode).toBe(400)
        }

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(new Decimal(wallet.realBalance).toNumber()).toBe(100)
        expect(await auditRowsFor(player.id)).toHaveLength(0)

        // The boundary itself is allowed: the cap is a ceiling, not an exclusion.
        const ok = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/adjust-balance`,
            payload: { type: 'real', amount: 100_000, note: 'large but deliberate' },
        })
        expect(ok.statusCode).toBe(200)
    })

    it('reports bonus lost to expiry, which cannot be read off the lots', async () => {
        // expireForUser zeroes `remaining` as it sets EXPIRED, so summing
        // remaining over expired lots is always 0 — the panel's "expired unused"
        // stat was structurally dead. The BONUS_EXPIRED transaction is the
        // surviving record, and its amount IS the unused remainder.
        const player = await mk('PLAYER', 0, 0)
        const admin = await mk('ADMIN')
        const app = await buildApp({ id: admin.id, role: 'ADMIN' })

        await prisma.bonusGrant.create({
            data: {
                userId: player.id, amount: 500, remaining: 0, periodStart: new Date(),
                status: 'EXPIRED', source: 'CASHBACK',
            },
        })
        await prisma.transaction.create({
            data: {
                userId: player.id, type: TransactionType.BONUS_EXPIRED, amount: 500,
                status: 'APPROVED', balanceBefore: 0, balanceAfter: 0,
                bonusBalanceBefore: 500, bonusBalanceAfter: 0,
            },
        })

        const res = await app.inject({ method: 'GET', url: `/admin/players/${player.id}/bonus-grants` })

        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.expiredUnused).toBe(500)
        // Provenance still rides along per lot, or every row reads as a manual grant.
        expect(body.grants).toHaveLength(1)
        expect(body.grants[0]).toMatchObject({ status: 'EXPIRED', source: 'CASHBACK', remaining: 0 })
    })
})
