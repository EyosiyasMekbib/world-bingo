import { describe, it, expect } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from './setup'
import { BonusService, InsufficientBonusBalanceError } from '../services/bonus.service'

async function makeUser(username: string, phone: string) {
    return prisma.user.create({
        data: {
            username,
            phone,
            passwordHash: 'hashed:pass',
            role: 'PLAYER',
            wallet: { create: { realBalance: 0, bonusBalance: 0 } },
        },
    })
}

describe('BonusService invariant', () => {
    it('holds across a scenario covering grant, spend (success), spend (deliberate underflow), reduce, and restore', async () => {
        const user = await makeUser('invariant1', '+251900000008')

        async function assertInvariant() {
            const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
            const lots = await prisma.bonusGrant.aggregate({
                where: { userId: user.id, status: 'ACTIVE' },
                _sum: { remaining: true },
            })
            const lotSum = new Decimal(lots._sum.remaining ?? 0)
            expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(lotSum.toNumber())
        }

        // 1. grant — establishes a starting balance
        await prisma.$transaction((tx) =>
            BonusService.grant(tx, { userId: user.id, amount: 37, source: 'ADMIN', expiresAt: new Date(Date.now() + 3600_000) }),
        )
        await assertInvariant()

        // 2. spend — succeeds, well within balance
        await prisma.$transaction((tx) => BonusService.spend(tx, user.id, 20))
        await assertInvariant()

        // 3. spend — deliberately exceeds the live balance (37 - 20 = 17 available, ask for 9999)
        await expect(prisma.$transaction((tx) => BonusService.spend(tx, user.id, 9999))).rejects.toThrow(
            InsufficientBonusBalanceError,
        )
        await assertInvariant() // must still hold — the rejected spend must not have partially mutated anything

        // 4. reduce — clamps rather than throws; balance is 17 here, ask for 10
        await prisma.$transaction((tx) => BonusService.reduce(tx, user.id, 10))
        await assertInvariant()

        // 5. restore — recreates a lot with a caller-supplied expiry, as a refund would
        const restoreExpiry = new Date(Date.now() + 1800_000)
        await prisma.$transaction((tx) => BonusService.restore(tx, user.id, 15, restoreExpiry))
        await assertInvariant()
    })

    it('reconcile() reports no mismatches on a clean wallet', async () => {
        const user = await makeUser('invariant2', '+251900000009')
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 15, source: 'ADMIN' }))

        const mismatches = await BonusService.reconcile()
        expect(mismatches.find((m) => m.userId === user.id)).toBeUndefined()
    })

    it('reconcile() reports a mismatch when bonusBalance is written outside BonusService', async () => {
        const user = await makeUser('invariant3', '+251900000010')
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 15, source: 'ADMIN' }))
        // Simulate the exact bug the invariant exists to catch.
        await prisma.wallet.update({ where: { userId: user.id }, data: { bonusBalance: { increment: 5 } } })

        const mismatches = await BonusService.reconcile()
        const mine = mismatches.find((m) => m.userId === user.id)
        expect(mine).toBeDefined()
        expect(mine!.cachedBalance.toNumber()).toBe(20)
        expect(mine!.lotSum.toNumber()).toBe(15)
    })
})
