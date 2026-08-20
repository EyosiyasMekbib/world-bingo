/**
 * HTTP-level coverage for POST /admin/players/:id/adjust-balance's bonus
 * branch (Task 9: routes bonus adjustments through BonusService.grant()/
 * .reduce() instead of raw wallet increment/decrement).
 *
 * Mirrors admin-approve-route.test.ts's convention: build a bare Fastify
 * instance, stub the auth decorators adminRoutes' preValidation hooks call
 * (they just set request.user — no real JWT is verified), register
 * adminRoutes, and drive it with app.inject.
 */
import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from './setup'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'

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

async function buildApp(adminId: string) {
    const app = Fastify({ logger: false })
    const setUser = async (request: any) => {
        request.user = { id: adminId, role: 'ADMIN' }
    }
    app.decorate('authenticate', setUser)
    app.decorate('requireAdmin', setUser)
    app.decorate('requireAdminOrClerk', setUser)
    app.decorate('requireSuperAdmin', setUser)
    await app.register(adminRoutes, { prefix: '/admin' })
    await app.ready()
    return app
}

function mk(role: 'PLAYER' | 'ADMIN', bonusBalance = 0) {
    const rnd = () => Math.random().toString(36).slice(2, 10)
    return prisma.user.create({
        data: {
            username: `adjbal_${role}_${rnd()}`,
            phone: `09${Math.floor(10000000 + Math.random() * 89999999)}`,
            passwordHash: 'hashed:x',
            role,
            wallet: { create: { realBalance: 0, bonusBalance } },
        },
    })
}

describe('POST /admin/players/:id/adjust-balance (bonus branch)', () => {
    it('positive bonus adjustment creates a BonusGrant lot', async () => {
        const player = await mk('PLAYER')
        const admin = await mk('ADMIN')
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/adjust-balance`,
            payload: { type: 'bonus', amount: 40, note: 'test grant' },
        })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toMatchObject({ realBalance: 0, bonusBalance: 40 })

        const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: player.id } })
        expect(new Decimal(lot.remaining).toNumber()).toBe(40)
        expect(new Decimal(lot.amount).toNumber()).toBe(40)
        expect(lot.status).toBe('ACTIVE')
        expect(lot.ruleId).toBeNull()

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(40)

        const txn = await prisma.transaction.findFirstOrThrow({
            where: { userId: player.id, type: TransactionType.ADMIN_BONUS_ADJUSTMENT },
        })
        expect(txn.status).toBe(PaymentStatus.APPROVED)
        expect(new Decimal(txn.bonusBalanceBefore!).toNumber()).toBe(0)
        expect(new Decimal(txn.bonusBalanceAfter!).toNumber()).toBe(40)
        expect(new Decimal(txn.amount).toNumber()).toBe(40)
    })

    it('negative bonus adjustment clamps at zero rather than going negative', async () => {
        const player = await mk('PLAYER', 30)
        await prisma.bonusGrant.create({
            data: { userId: player.id, amount: 30, remaining: 30, periodStart: new Date(), status: 'ACTIVE' },
        })
        const admin = await mk('ADMIN')
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/adjust-balance`,
            payload: { type: 'bonus', amount: -999, note: 'test reduce' },
        })

        expect(res.statusCode).toBe(200)
        expect(res.json().bonusBalance).toBe(0)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(0)

        const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: player.id } })
        expect(new Decimal(lot.remaining).toNumber()).toBe(0)
        expect(lot.status).toBe('CONSUMED')

        const txn = await prisma.transaction.findFirstOrThrow({
            where: { userId: player.id, type: TransactionType.ADMIN_BONUS_ADJUSTMENT },
        })
        expect(new Decimal(txn.bonusBalanceBefore!).toNumber()).toBe(30)
        expect(new Decimal(txn.bonusBalanceAfter!).toNumber()).toBe(0)
        // The transaction records the actual applied delta (-30, what really
        // moved after clamping), not the admin's requested -999.
        expect(new Decimal(txn.amount).toNumber()).toBe(-30)
    })
})
