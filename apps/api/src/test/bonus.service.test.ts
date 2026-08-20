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

describe('BonusService.grant', () => {
    it('creates a lot and increments the cached wallet balance', async () => {
        const user = await makeUser('grant1', '+251900000001')
        const expiresAt = new Date(Date.now() + 3600_000)

        const result = await prisma.$transaction((tx) =>
            BonusService.grant(tx, {
                userId: user.id,
                amount: 100,
                source: 'ADMIN',
                expiresAt,
            }),
        )

        expect(result.granted).toBe(true)
        expect(result.bonusBalanceBefore.toNumber()).toBe(0)
        expect(result.bonusBalanceAfter.toNumber()).toBe(100)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(100)

        const lot = await prisma.bonusGrant.findUniqueOrThrow({ where: { id: result.grantId! } })
        expect(new Decimal(lot.amount).toNumber()).toBe(100)
        expect(new Decimal(lot.remaining).toNumber()).toBe(100)
        expect(lot.status).toBe('ACTIVE')
        expect(lot.expiresAt?.getTime()).toBe(expiresAt.getTime())
    })

    it('is idempotent on (ruleId, userId, periodStart)', async () => {
        const user = await makeUser('grant2', '+251900000002')
        const rule = await prisma.bonusRule.create({
            data: {
                name: 'Daily test',
                type: 'DAILY_DEPOSIT',
                threshold: 500,
                rewardType: 'FIXED',
                rewardValue: 50,
                validityHours: 24,
                startsAt: new Date(Date.now() - 1000),
                endsAt: new Date(Date.now() + 86_400_000),
            },
        })
        const periodStart = new Date('2026-08-20T00:00:00Z')

        const grantOnce = () =>
            prisma.$transaction((tx) =>
                BonusService.grant(tx, {
                    userId: user.id,
                    amount: 50,
                    source: 'DAILY_DEPOSIT',
                    ruleId: rule.id,
                    periodStart,
                }),
            )

        const first = await grantOnce()
        const second = await grantOnce()

        expect(first.granted).toBe(true)
        expect(second.granted).toBe(false)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(50)
    })

    it('a duplicate grant does not poison the transaction for subsequent queries', async () => {
        const user = await makeUser('poisontest', '+251900000099')
        const rule = await prisma.bonusRule.create({
            data: {
                name: 'Poison test rule',
                type: 'DAILY_DEPOSIT',
                threshold: 500,
                rewardType: 'FIXED',
                rewardValue: 10,
                validityHours: 24,
                startsAt: new Date(Date.now() - 1000),
                endsAt: new Date(Date.now() + 86_400_000),
            },
        })
        const periodStart = new Date('2026-08-20T00:00:00Z')

        await prisma.$transaction(async (tx) => {
            // First grant succeeds
            const first = await BonusService.grant(tx, {
                userId: user.id,
                amount: 10,
                source: 'DAILY_DEPOSIT',
                ruleId: rule.id,
                periodStart,
            })
            expect(first.granted).toBe(true)

            // Duplicate grant returns false but should not poison the transaction
            const dup = await BonusService.grant(tx, {
                userId: user.id,
                amount: 10,
                source: 'DAILY_DEPOSIT',
                ruleId: rule.id,
                periodStart,
            })
            expect(dup.granted).toBe(false)

            // If the transaction were poisoned, this next query would throw.
            // We verify that a subsequent tx.* call succeeds.
            const stillWorks = await tx.wallet.findUnique({ where: { userId: user.id } })
            expect(stillWorks).not.toBeNull()
            expect(new Decimal(stillWorks!.bonusBalance).toNumber()).toBe(10)
        })
    })
})

describe('BonusService.spend', () => {
    it('consumes lots soonest-expiry-first and marks drained lots CONSUMED', async () => {
        const user = await makeUser('spend1', '+251900000003')
        const soon = new Date(Date.now() + 3600_000)
        const later = new Date(Date.now() + 7 * 86_400_000)

        await prisma.$transaction(async (tx) => {
            await BonusService.grant(tx, { userId: user.id, amount: 30, source: 'ADMIN', expiresAt: later })
            await BonusService.grant(tx, { userId: user.id, amount: 20, source: 'ADMIN', expiresAt: soon })
        })

        const result = await prisma.$transaction((tx) => BonusService.spend(tx, user.id, 25))

        expect(result.spent.toNumber()).toBe(25)
        expect(result.bonusBalanceAfter.toNumber()).toBe(25)
        expect(result.soonestExpiryConsumed?.getTime()).toBe(soon.getTime())

        const lots = await prisma.bonusGrant.findMany({ where: { userId: user.id }, orderBy: { expiresAt: 'asc' } })
        expect(lots[0].status).toBe('CONSUMED')
        expect(new Decimal(lots[0].remaining).toNumber()).toBe(0)
        expect(lots[1].status).toBe('ACTIVE')
        expect(new Decimal(lots[1].remaining).toNumber()).toBe(25)
    })

    it('throws InsufficientBonusBalanceError and touches nothing when lots fall short', async () => {
        const user = await makeUser('spend2', '+251900000004')
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 10, source: 'ADMIN' }))

        await expect(prisma.$transaction((tx) => BonusService.spend(tx, user.id, 50))).rejects.toThrow(
            InsufficientBonusBalanceError,
        )

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(10)
    })
})

describe('BonusService.reduce', () => {
    it('consumes lots soonest-first like spend', async () => {
        const user = await makeUser('reduce1', '+251900000005')
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 40, source: 'ADMIN' }))

        const result = await prisma.$transaction((tx) => BonusService.reduce(tx, user.id, 15))

        expect(result.reduced.toNumber()).toBe(15)
        expect(result.bonusBalanceAfter.toNumber()).toBe(25)
    })

    it('clamps at zero instead of throwing when the reduction exceeds the balance', async () => {
        const user = await makeUser('reduce2', '+251900000006')
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 10, source: 'ADMIN' }))

        const result = await prisma.$transaction((tx) => BonusService.reduce(tx, user.id, 999))

        expect(result.reduced.toNumber()).toBe(10)
        expect(result.bonusBalanceAfter.toNumber()).toBe(0)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(0)
    })
})

describe('BonusService.restore', () => {
    it('grants a fresh lot carrying the passed-in expiry, not a new window', async () => {
        const user = await makeUser('restore1', '+251900000007')
        const originalExpiry = new Date(Date.now() + 1800_000)

        const result = await prisma.$transaction((tx) => BonusService.restore(tx, user.id, 25, originalExpiry))

        expect(result.granted).toBe(true)
        expect(result.bonusBalanceAfter.toNumber()).toBe(25)
        const lot = await prisma.bonusGrant.findUniqueOrThrow({ where: { id: result.grantId! } })
        expect(lot.ruleId).toBeNull()
        expect(lot.expiresAt?.getTime()).toBe(originalExpiry.getTime())
    })
})
