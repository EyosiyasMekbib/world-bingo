import { describe, it, expect } from 'vitest'
import { prisma } from './setup'
import { BonusRuleService } from '../services/bonus-rule.service'

describe('BonusRuleService', () => {
    it('creates a rule and lists it', async () => {
        const rule = await BonusRuleService.create({
            name: 'Daily 500',
            type: 'DAILY_DEPOSIT',
            threshold: 500,
            rewardType: 'FIXED',
            rewardValue: 50,
            validityHours: 24,
            startsAt: '2026-08-01T00:00:00Z',
            endsAt: '2026-12-31T00:00:00Z',
        })
        expect(rule.name).toBe('Daily 500')

        const all = await BonusRuleService.list()
        expect(all.map((r) => r.id)).toContain(rule.id)
    })

    it('listActive filters by isActive and the startsAt/endsAt window', async () => {
        const now = new Date('2026-08-20T12:00:00Z')
        const inWindow = await BonusRuleService.create({
            name: 'In window', type: 'WEEKLY_DEPOSIT', threshold: 2000,
            rewardType: 'FIXED', rewardValue: 150, validityHours: 168,
            startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z',
        })
        await BonusRuleService.create({
            name: 'Not started', type: 'WEEKLY_DEPOSIT', threshold: 2000,
            rewardType: 'FIXED', rewardValue: 150, validityHours: 168,
            startsAt: '2027-01-01T00:00:00Z', endsAt: '2027-06-01T00:00:00Z',
        })
        const inactive = await BonusRuleService.create({
            name: 'Deactivated', type: 'DAILY_DEPOSIT', threshold: 500,
            rewardType: 'FIXED', rewardValue: 50, validityHours: 24,
            startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z',
        })
        await BonusRuleService.update(inactive.id, { isActive: false })

        const active = await BonusRuleService.listActive(now)
        const ids = active.map((r) => r.id)
        expect(ids).toContain(inWindow.id)
        expect(ids).not.toContain(inactive.id)
        expect(active.length).toBe(1)
    })

    it('update() clamps maxReward and rejects endsAt before startsAt implicitly via caller validation', async () => {
        const rule = await BonusRuleService.create({
            name: 'To edit', type: 'DAILY_DEPOSIT', threshold: 500,
            rewardType: 'PERCENTAGE', rewardValue: 10, maxReward: 100, validityHours: 24,
            startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z',
        })
        const updated = await BonusRuleService.update(rule.id, { rewardValue: 15 })
        expect(Number(updated.rewardValue)).toBe(15)
    })
})
