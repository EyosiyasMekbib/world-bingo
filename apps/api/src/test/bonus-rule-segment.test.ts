import { describe, it, expect } from 'vitest'
import { prisma } from './setup'
import { BonusRuleService } from '../services/bonus-rule.service'
import { SEGMENT_RULESET_VERSION } from '@world-bingo/shared-types'

const BASE = {
    name: 'Targeted daily',
    type: 'DAILY_DEPOSIT' as const,
    threshold: 500,
    rewardType: 'FIXED' as const,
    rewardValue: 50,
    validityHours: 24,
    startsAt: '2026-01-01T00:00:00Z',
    endsAt: '2027-01-01T00:00:00Z',
}

async function makePlayer(username: string, phone: string, lifetimeDeposits: number) {
    const user = await prisma.user.create({
        data: { username, phone, passwordHash: 'hashed:pass', role: 'PLAYER', wallet: { create: {} } },
    })
    await prisma.playerMetrics.create({
        data: { userId: user.id, lifetimeDeposits, registeredAt: new Date(), username, phone },
    })
    return user
}

async function makeSegment(name: string, minDeposits: number) {
    return prisma.segment.create({
        data: {
            name,
            rules: {
                version: SEGMENT_RULESET_VERSION,
                root: {
                    kind: 'group',
                    op: 'AND',
                    children: [{ kind: 'cond', field: 'lifetimeDeposits', op: 'gte', value: minDeposits }],
                },
            },
        },
    })
}

describe('BonusRuleService.create — segment targeting', () => {
    it('materializes exactly the matching players and records the count', async () => {
        const rich = await makePlayer('seg_rich', '+251900001001', 5000)
        const poor = await makePlayer('seg_poor', '+251900001002', 10)
        const segment = await makeSegment('Big depositors', 1000)

        const rule = await BonusRuleService.create({ ...BASE, segmentId: segment.id })

        expect(rule.isSegmentScoped).toBe(true)
        expect(rule.segmentId).toBe(segment.id)
        expect(rule.segmentName).toBe('Big depositors')
        expect(rule.memberCount).toBe(1)

        const members = await prisma.bonusRuleMember.findMany({ where: { ruleId: rule.id } })
        expect(members.map((m) => m.userId)).toEqual([rich.id])
        expect(members.map((m) => m.userId)).not.toContain(poor.id)
    })

    it('leaves an unscoped rule global, with memberCount null and no member rows', async () => {
        await makePlayer('seg_any', '+251900001003', 5000)

        const rule = await BonusRuleService.create(BASE)

        expect(rule.isSegmentScoped).toBe(false)
        expect(rule.segmentId).toBeNull()
        expect(rule.memberCount).toBeNull()
        expect(await prisma.bonusRuleMember.count({ where: { ruleId: rule.id } })).toBe(0)
    })

    it('rejects a segment that matches nobody, and creates no rule', async () => {
        await makePlayer('seg_small', '+251900001004', 10)
        const segment = await makeSegment('Impossible', 999_999)

        await expect(BonusRuleService.create({ ...BASE, segmentId: segment.id })).rejects.toThrow(
            /matches no players/i,
        )
        expect(await prisma.bonusRule.count()).toBe(0)
    })

    it('rejects a segmentId that does not exist', async () => {
        await expect(
            BonusRuleService.create({ ...BASE, segmentId: '00000000-0000-0000-0000-000000000000' }),
        ).rejects.toThrow(/segment not found/i)
    })
})
