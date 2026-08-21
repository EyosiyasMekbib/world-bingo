import { describe, it, expect } from 'vitest'
import { prisma } from './setup'
import { BonusService } from '../services/bonus.service'
import { BonusGrantQueryService } from '../services/bonus-grant-query.service'

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

describe('BonusGrantQueryService.listActiveForUser', () => {
  it('lists only ACTIVE lots, soonest expiry first, with the rule name resolved', async () => {
    const user = await makeUser('grantquery1', '+251900000036')
    const rule = await prisma.bonusRule.create({
      data: {
        name: 'Daily 500',
        type: 'DAILY_DEPOSIT',
        threshold: 500,
        rewardType: 'FIXED',
        rewardValue: 50,
        validityHours: 24,
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 86_400_000),
      },
    })
    // consumeLots drains soonest-expiry-first (see BonusService.consumeLots),
    // so the admin lot is given the sooner expiry: spending exactly its
    // 100 balance drains it entirely without touching the daily lot, which
    // is left as the sole surviving ACTIVE grant.
    const soon = new Date(Date.now() + 3600_000)
    const later = new Date(Date.now() + 7 * 86_400_000)

    await prisma.$transaction(async (tx) => {
      await BonusService.grant(tx, { userId: user.id, amount: 100, source: 'ADMIN', expiresAt: soon })
      await BonusService.grant(tx, {
        userId: user.id,
        amount: 50,
        source: 'DAILY_DEPOSIT',
        ruleId: rule.id,
        periodStart: new Date(),
        expiresAt: later,
      })
      const spent = await BonusService.spend(tx, user.id, 100) // drains the admin lot entirely
      expect(spent.spent.toNumber()).toBe(100)
    })

    const grants = await BonusGrantQueryService.listActiveForUser(user.id)

    expect(grants).toHaveLength(1)
    expect(grants[0].ruleName).toBe('Daily 500')
    expect(grants[0].remaining).toBe(50)
  })

  it('does not leak another user\'s grants', async () => {
    const user = await makeUser('grantquery2', '+251900000037')
    const otherUser = await makeUser('grantquery3', '+251900000038')

    await prisma.$transaction(async (tx) => {
      await BonusService.grant(tx, { userId: otherUser.id, amount: 75, source: 'ADMIN', expiresAt: new Date(Date.now() + 86_400_000) })
    })

    const grants = await BonusGrantQueryService.listActiveForUser(user.id)

    expect(grants).toHaveLength(0)
  })
})
