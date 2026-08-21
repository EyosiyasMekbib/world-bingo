/**
 * HTTP-level coverage for the admin deposit-bonus-rule routes: CRUD on
 * /admin/bonus-rules, the toggle sub-route, and the /admin/bonus-reconciliation
 * invariant-drift check (Task 24).
 *
 * Mirrors admin-approve-route.test.ts's convention: build a bare Fastify
 * instance, stub the auth decorators adminRoutes' preValidation hooks call
 * (they just set request.user — no real JWT is verified), register
 * adminRoutes, and drive it with app.inject.
 */
import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { prisma } from './setup'

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

function mkAdmin() {
    const rnd = () => Math.random().toString(36).slice(2, 10)
    return prisma.user.create({
        data: {
            username: `bonusrule_admin_${rnd()}`,
            phone: `09${Math.floor(10000000 + Math.random() * 89999999)}`,
            passwordHash: 'hashed:x',
            role: 'ADMIN',
        },
    })
}

describe('Admin bonus rules', () => {
    it('creates, lists, and toggles a bonus rule', async () => {
        const admin = await mkAdmin()
        const app = await buildApp(admin.id)

        const createRes = await app.inject({
            method: 'POST',
            url: '/admin/bonus-rules',
            payload: {
                name: 'Daily 500',
                type: 'DAILY_DEPOSIT',
                threshold: 500,
                rewardType: 'FIXED',
                rewardValue: 50,
                validityHours: 24,
                startsAt: '2026-01-01T00:00:00Z',
                endsAt: '2027-01-01T00:00:00Z',
            },
        })
        expect(createRes.statusCode).toBe(200)
        const ruleId = createRes.json().id
        expect(ruleId).toBeTruthy()

        const dbRuleAfterCreate = await prisma.bonusRule.findUniqueOrThrow({ where: { id: ruleId } })
        expect(dbRuleAfterCreate.name).toBe('Daily 500')
        expect(dbRuleAfterCreate.isActive).toBe(true)

        const listRes = await app.inject({ method: 'GET', url: '/admin/bonus-rules' })
        expect(listRes.statusCode).toBe(200)
        expect(listRes.json().some((r: any) => r.id === ruleId)).toBe(true)

        const toggleRes = await app.inject({
            method: 'PATCH',
            url: `/admin/bonus-rules/${ruleId}/toggle`,
            payload: { isActive: false },
        })
        expect(toggleRes.statusCode).toBe(200)
        expect(toggleRes.json().isActive).toBe(false)

        const dbRuleAfterToggle = await prisma.bonusRule.findUniqueOrThrow({ where: { id: ruleId } })
        expect(dbRuleAfterToggle.isActive).toBe(false)
    })

    it('rejects endsAt before startsAt', async () => {
        const admin = await mkAdmin()
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/bonus-rules',
            payload: {
                name: 'Bad',
                type: 'DAILY_DEPOSIT',
                threshold: 500,
                rewardType: 'FIXED',
                rewardValue: 50,
                validityHours: 24,
                startsAt: '2027-01-01T00:00:00Z',
                endsAt: '2026-01-01T00:00:00Z',
            },
        })
        expect(res.statusCode).toBe(400)
        expect(await prisma.bonusRule.count()).toBe(0)
    })

    it('reconciliation endpoint reports empty on a healthy system', async () => {
        const admin = await mkAdmin()
        const app = await buildApp(admin.id)

        const res = await app.inject({ method: 'GET', url: '/admin/bonus-reconciliation' })
        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual([])
    })
})
