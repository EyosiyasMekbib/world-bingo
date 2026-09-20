/**
 * HTTP coverage for POST /admin/transactions/:id/decline. The same route
 * rejects deposits (reason required) and withdrawals (note only, refunds).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
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
const { notifyCreate } = vi.hoisted(() => ({ notifyCreate: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../services/notification.service', () => ({
    NotificationService: { pushWalletUpdate: vi.fn(), create: notifyCreate },
}))
vi.mock('../services/referral.service', () => ({
    ReferralService: { processFirstDepositBonus: vi.fn().mockResolvedValue(undefined) },
}))

import adminRoutes from '../routes/admin/index'

async function buildApp(reviewerId: string) {
    const app = Fastify({ logger: false })
    const setUser = async (request: any) => {
        request.user = { id: reviewerId, role: 'ADMIN' }
    }
    app.decorate('authenticate', setUser)
    app.decorate('requireAdmin', setUser)
    app.decorate('requireAdminOrClerk', setUser)
    app.decorate('requireSuperAdmin', setUser)
    await app.register(adminRoutes, { prefix: '/admin' })
    await app.ready()
    return app
}

async function seed(type: TransactionType) {
    const rnd = () => Math.random().toString(36).slice(2, 10)
    const mk = (role: 'PLAYER' | 'ADMIN') =>
        prisma.user.create({
            data: {
                username: `decline_${role}_${rnd()}`,
                phone: `09${Math.floor(10000000 + Math.random() * 89999999)}`,
                passwordHash: 'hashed:x',
                role,
                wallet: { create: { realBalance: 0, bonusBalance: 0 } },
            },
        })
    const player = await mk('PLAYER')
    const reviewer = await mk('ADMIN')
    const tx = await prisma.transaction.create({
        data: {
            userId: player.id,
            type,
            amount: 150,
            status: PaymentStatus.PENDING_REVIEW,
            note: type === TransactionType.DEPOSIT ? 'telebirr' : 'telebirr: 0911000000',
        },
    })
    return { player, reviewer, tx }
}

beforeEach(() => notifyCreate.mockClear())

describe('POST /admin/transactions/:id/decline', () => {
    it('rejects a deposit with a reason, stores it, and tells the player the reason', async () => {
        const { reviewer, tx } = await seed(TransactionType.DEPOSIT)
        const app = await buildApp(reviewer.id)
        const res = await app.inject({
            method: 'POST',
            url: `/admin/transactions/${tx.id}/decline`,
            payload: { reason: 'AMOUNT_MISMATCH' },
        })
        expect(res.statusCode).toBe(200)
        const row = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
        expect(row.status).toBe('REJECTED')
        expect(row.rejectionReason).toBe('AMOUNT_MISMATCH')
        expect(notifyCreate.mock.calls[0][3]).toContain('Amount does not match the receipt')
        await app.close()
    })

    it('400s a deposit decline without a reason and leaves it pending', async () => {
        const { reviewer, tx } = await seed(TransactionType.DEPOSIT)
        const app = await buildApp(reviewer.id)
        const res = await app.inject({
            method: 'POST',
            url: `/admin/transactions/${tx.id}/decline`,
            payload: { note: 'bad' },
        })
        expect(res.statusCode).toBe(400)
        expect((await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })).status).toBe(
            'PENDING_REVIEW',
        )
        await app.close()
    })

    it('400s OTHER without a note', async () => {
        const { reviewer, tx } = await seed(TransactionType.DEPOSIT)
        const app = await buildApp(reviewer.id)
        const res = await app.inject({
            method: 'POST',
            url: `/admin/transactions/${tx.id}/decline`,
            payload: { reason: 'OTHER' },
        })
        expect(res.statusCode).toBe(400)
        expect(res.json().error).toMatch(/note/i)
        await app.close()
    })

    it('still rejects a withdrawal with only a note, and refunds it', async () => {
        const { player, reviewer, tx } = await seed(TransactionType.WITHDRAWAL)
        const app = await buildApp(reviewer.id)
        const res = await app.inject({
            method: 'POST',
            url: `/admin/transactions/${tx.id}/decline`,
            payload: { note: 'Invalid account' },
        })
        expect(res.statusCode).toBe(200)
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(Number(wallet.realBalance)).toBe(150)
        await app.close()
    })
})
