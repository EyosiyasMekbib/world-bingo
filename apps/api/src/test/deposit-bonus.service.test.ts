import { describe, it, expect } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from './setup'
import { DepositBonusService } from '../services/deposit-bonus.service'
import { BonusRuleService } from '../services/bonus-rule.service'
import { dayBucketStart } from '../lib/bonus-period'

async function makeUser(username: string, phone: string) {
    return prisma.user.create({
        data: { username, phone, passwordHash: 'hashed:pass', role: 'PLAYER', wallet: { create: { realBalance: 0, bonusBalance: 0 } } },
    })
}

async function approvedDeposit(userId: string, amount: number, at: Date) {
    return prisma.transaction.create({
        data: { userId, type: 'DEPOSIT', amount, status: 'APPROVED', createdAt: at },
    })
}

describe('DepositBonusService.evaluateAndGrant', () => {
    it('grants the daily bonus once the bucket total crosses the threshold, from multiple small deposits', async () => {
        const user = await makeUser('depbonus1', '+251900000012')
        await BonusRuleService.create({
            name: 'Daily 500', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(user.id, 300, day)
        await approvedDeposit(user.id, 250, day) // bucket total now 550, crosses 500

        const result = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day, day))

        expect(result.daily).toHaveLength(1)
        expect(result.daily[0].amount.toNumber()).toBe(50)
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(50)
    })

    it('does not grant when the bucket total is below threshold', async () => {
        const user = await makeUser('depbonus2', '+251900000013')
        await BonusRuleService.create({
            name: 'Daily 500b', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(user.id, 100, day)

        const result = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day, day))
        expect(result.daily).toHaveLength(0)
    })

    it('a percentage reward clamps to maxReward and rounds down', async () => {
        const user = await makeUser('depbonus3', '+251900000014')
        await BonusRuleService.create({
            name: 'Weekly 10pct', type: 'WEEKLY_DEPOSIT', threshold: 1000, rewardType: 'PERCENTAGE',
            rewardValue: 10, maxReward: 80, validityHours: 168,
            startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        const day = new Date('2026-08-24T10:00:00Z') // a Monday
        await approvedDeposit(user.id, 3333.33, day) // 10% = 333.333, clamped to 80

        const result = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day, day))
        expect(result.weekly).toHaveLength(1)
        expect(result.weekly[0].amount.toNumber()).toBe(80)
    })

    it('a single deposit crossing both a daily and a weekly threshold grants two independent lots', async () => {
        const user = await makeUser('depbonus4', '+251900000015')
        await BonusRuleService.create({
            name: 'Daily', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        await BonusRuleService.create({
            name: 'Weekly', type: 'WEEKLY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 150, validityHours: 168, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(user.id, 600, day)

        const result = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day, day))
        expect(result.daily).toHaveLength(1)
        expect(result.daily[0].amount.toNumber()).toBe(50)
        expect(result.weekly).toHaveLength(1)
        expect(result.weekly[0].amount.toNumber()).toBe(150)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(200)
    })

    it('is idempotent per day — evaluating twice for the same bucket grants once', async () => {
        const user = await makeUser('depbonus5', '+251900000016')
        await BonusRuleService.create({
            name: 'Daily idem', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })
        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(user.id, 600, day)

        await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day, day))
        const second = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day, day))

        expect(second.daily).toHaveLength(0) // already granted for this bucket
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(50)
    })

    it('anchors the bucket window to the deposit\'s own createdAt, not a later approval instant', async () => {
        // Regression test for the depositAt/createdAt mismatch bug: a deposit made
        // late on day D but approved after local midnight (day D+1) must still be
        // evaluated against day D's bucket -- the day it actually happened -- not
        // excluded entirely, and not misattributed to D+1.
        const user = await makeUser('depbonus6', '+251900000019')
        await BonusRuleService.create({
            name: 'Daily cross-day', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
        })

        // Addis Ababa is a fixed UTC+3 offset. Local day D = 2026-08-20 runs from
        // UTC 2026-08-19T21:00:00Z to UTC 2026-08-20T21:00:00Z.
        const depositCreatedAt = new Date('2026-08-20T20:55:00Z') // Addis: Aug 20, 23:55 local (day D)
        const grantedAt = new Date('2026-08-20T21:10:00Z') // Addis: Aug 21, 00:10 local (day D+1) -- approved the next local day
        await approvedDeposit(user.id, 600, depositCreatedAt)

        const result = await prisma.$transaction((tx) =>
            DepositBonusService.evaluateAndGrant(tx, user.id, depositCreatedAt, grantedAt),
        )

        expect(result.daily).toHaveLength(1)
        expect(result.daily[0].amount.toNumber()).toBe(50)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(50)

        // The grant's periodStart must be day D's bucket (the deposit's own day),
        // not day D+1's bucket (the approval day).
        const grant = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: user.id } })
        expect(grant.periodStart.toISOString()).toBe(dayBucketStart(depositCreatedAt).toISOString())

        // expiresAt must be anchored to grantedAt (the approval instant), not
        // depositCreatedAt -- validityHours=24 from grantedAt.
        expect(grant.expiresAt?.toISOString()).toBe(new Date(grantedAt.getTime() + 24 * 3_600_000).toISOString())
    })
})
