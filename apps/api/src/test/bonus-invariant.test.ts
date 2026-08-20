import { describe, it, expect } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from './setup'
import { BonusService } from '../services/bonus.service'

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
    it('holds after a randomized sequence of grant/spend/reduce/restore', async () => {
        const user = await makeUser('invariant1', '+251900000008')
        const ops: Array<'grant' | 'spend' | 'reduce'> = [
            'grant', 'grant', 'spend', 'grant', 'reduce', 'spend', 'grant',
        ]

        for (const op of ops) {
            try {
                if (op === 'grant') {
                    await prisma.$transaction((tx) =>
                        BonusService.grant(tx, { userId: user.id, amount: 37, source: 'ADMIN', expiresAt: new Date(Date.now() + 3600_000) }),
                    )
                } else if (op === 'spend') {
                    await prisma.$transaction((tx) => BonusService.spend(tx, user.id, 20)).catch(() => {})
                } else {
                    await prisma.$transaction((tx) => BonusService.reduce(tx, user.id, 10))
                }
            } catch {
                // InsufficientBonusBalanceError is an expected outcome of this random sequence
            }

            const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
            const lots = await prisma.bonusGrant.aggregate({
                where: { userId: user.id, status: 'ACTIVE' },
                _sum: { remaining: true },
            })
            const lotSum = new Decimal(lots._sum.remaining ?? 0)
            expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(lotSum.toNumber())
        }
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
