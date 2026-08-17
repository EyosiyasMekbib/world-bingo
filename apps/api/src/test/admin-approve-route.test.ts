/**
 * HTTP-level coverage for POST /admin/transactions/:id/approve.
 *
 * deposit-adjust.test.ts calls WalletService.approveDeposit directly, so it
 * cannot catch a break in the layers the browser actually goes through: JSON
 * body parsing, the controller's `body.amount` read/validate/round, and the
 * positional hand-off through AdminService.reviewTransaction. This drives the
 * real route with a real payload and asserts the credited balance.
 */
import { describe, it, expect, vi } from 'vitest'
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

// Mirrors production: requireAdminOrClerk runs jwtVerify, which populates
// request.user from the token payload ({ id, role }).
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

async function seed(amount: number) {
    const rnd = () => Math.random().toString(36).slice(2, 10)
    const mk = (role: 'PLAYER' | 'ADMIN') =>
        prisma.user.create({
            data: {
                username: `route_${role}_${rnd()}`,
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
            type: TransactionType.DEPOSIT,
            amount,
            status: PaymentStatus.PENDING_REVIEW,
            note: 'telebirr',
        },
    })
    return { player, reviewer, tx }
}

const realBalance = async (userId: string) =>
    Number((await prisma.wallet.findUniqueOrThrow({ where: { userId } })).realBalance)

describe('POST /admin/transactions/:id/approve', () => {
    it('credits the adjusted amount sent in the body and records the stated one', async () => {
        const { player, reviewer, tx } = await seed(100)
        const app = await buildApp(reviewer.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/transactions/${tx.id}/approve`,
            payload: { amount: 90 },
        })

        expect(res.statusCode).toBe(200)
        const updated = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
        expect(updated.status).toBe(PaymentStatus.APPROVED)
        expect(Number(updated.amount)).toBe(90)
        expect(Number(updated.originalAmount)).toBe(100)
        expect(await realBalance(player.id)).toBe(90)
    })

    it('credits the stated amount when no body is sent at all (plain approve)', async () => {
        const { player, reviewer, tx } = await seed(100)
        const app = await buildApp(reviewer.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/transactions/${tx.id}/approve`,
        })

        expect(res.statusCode).toBe(200)
        const updated = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
        expect(Number(updated.amount)).toBe(100)
        expect(updated.originalAmount).toBeNull()
        expect(await realBalance(player.id)).toBe(100)
    })

    // What the fixed client sends for a plain approve: JSON.stringify drops the
    // undefined `amount`, so the body arrives as {}.
    it('credits the stated amount for an empty-object body', async () => {
        const { player, reviewer, tx } = await seed(100)
        const app = await buildApp(reviewer.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/transactions/${tx.id}/approve`,
            payload: {},
        })

        expect(res.statusCode).toBe(200)
        expect(Number((await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })).amount)).toBe(100)
        expect(await realBalance(player.id)).toBe(100)
    })

    it('rounds a fractional adjustment to 2dp', async () => {
        const { player, reviewer, tx } = await seed(100)
        const app = await buildApp(reviewer.id)

        await app.inject({
            method: 'POST',
            url: `/admin/transactions/${tx.id}/approve`,
            payload: { amount: 90.567 },
        })

        expect(await realBalance(player.id)).toBe(90.57)
    })

    it('rejects a non-positive adjustment with 400 and leaves the wallet untouched', async () => {
        const { player, reviewer, tx } = await seed(100)
        const app = await buildApp(reviewer.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/transactions/${tx.id}/approve`,
            payload: { amount: 0 },
        })

        expect(res.statusCode).toBe(400)
        const updated = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
        expect(updated.status).toBe(PaymentStatus.PENDING_REVIEW)
        expect(await realBalance(player.id)).toBe(0)
    })
})
