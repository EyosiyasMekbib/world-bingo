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

  it('carries each lot\'s source, which is the only thing telling three of them apart', async () => {
    // Cashback, welcome and campaign lots all have ruleId null, so the ruleName
    // asserted above is null for all three. This service's explicit field map is
    // the only thing deciding whether `source` reaches the wallet at all, and a
    // field dropped from it does not fail a type check — the client falls through
    // to its own default chip, so every lot silently reads as one anonymous
    // "Bonus" and the per-source chips become unreachable code.
    const user = await makeUser('grantquery4', '+251900000039')
    const expiresAt = new Date(Date.now() + 86_400_000)

    await prisma.$transaction(async (tx) => {
      for (const source of ['CASHBACK', 'FIRST_DEPOSIT', 'CAMPAIGN'] as const) {
        await BonusService.grant(tx, { userId: user.id, amount: 50, source, expiresAt })
      }
    })

    const grants = await BonusGrantQueryService.listActiveForUser(user.id)

    expect(grants).toHaveLength(3)
    expect(grants.map((g) => g.source).sort()).toEqual(['CAMPAIGN', 'CASHBACK', 'FIRST_DEPOSIT'])
  })
})
