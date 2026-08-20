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
})
