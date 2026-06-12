import { vi } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: { $queryRaw: vi.fn() },
}))

import { describe, it, expect, beforeEach } from 'vitest'
import prisma from '../lib/prisma'
import { AnalyticsService } from '../services/analytics.service'

const queryRaw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
    vi.clearAllMocks()
})

describe('AnalyticsService.parseRange', () => {
    it('defaults to last 30 days when no params given', () => {
        const now = new Date('2026-06-12T10:00:00Z')
        const { from, to } = AnalyticsService.parseRange(undefined, undefined, now)
        expect(to.getTime()).toBe(now.getTime())
        expect(from.getTime()).toBe(now.getTime() - 30 * 24 * 3600 * 1000)
    })

    it('parses explicit ISO dates', () => {
        const { from, to } = AnalyticsService.parseRange('2026-01-01', '2026-02-01')
        expect(from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
        expect(to.toISOString()).toBe('2026-02-01T00:00:00.000Z')
    })

    it('throws when from is after to', () => {
        expect(() => AnalyticsService.parseRange('2026-02-01', '2026-01-01')).toThrow('from must be before to')
    })

    it('throws on invalid date strings', () => {
        expect(() => AnalyticsService.parseRange('not-a-date', undefined)).toThrow('Invalid date')
    })
})

describe('AnalyticsService.pct', () => {
    it('computes a rounded percentage', () => {
        expect(AnalyticsService.pct(1, 3)).toBe(33.3)
        expect(AnalyticsService.pct(2, 4)).toBe(50)
    })

    it('returns 0 when the denominator is 0', () => {
        expect(AnalyticsService.pct(5, 0)).toBe(0)
    })
})

describe('AnalyticsService.buildRetentionMatrix', () => {
    const sizes = [
        { cohort_week: new Date('2026-05-18T00:00:00Z'), size: 10 },
        { cohort_week: new Date('2026-05-25T00:00:00Z'), size: 4 },
    ]
    const activity = [
        { cohort_week: new Date('2026-05-18T00:00:00Z'), week_offset: 0, active_users: 6 },
        { cohort_week: new Date('2026-05-18T00:00:00Z'), week_offset: 1, active_users: 3 },
        { cohort_week: new Date('2026-05-25T00:00:00Z'), week_offset: 0, active_users: 4 },
    ]

    it('builds one row per cohort with pct per week offset', () => {
        const rows = AnalyticsService.buildRetentionMatrix(sizes, activity, 3)
        expect(rows).toEqual([
            { week: '2026-05-18', size: 10, offsets: [60, 30, 0] },
            { week: '2026-05-25', size: 4, offsets: [100, 0, 0] },
        ])
    })

    it('handles cohorts with zero activity', () => {
        const rows = AnalyticsService.buildRetentionMatrix(sizes, [], 2)
        expect(rows[0].offsets).toEqual([0, 0])
    })
})

describe('AnalyticsService.getFunnel', () => {
    it('returns counts and conversion rates', async () => {
        queryRaw.mockResolvedValueOnce([
            { signups: 200, depositors: 80, players: 60, repeat_players: 30 },
        ])
        const out = await AnalyticsService.getFunnel(new Date('2026-05-01'), new Date('2026-06-01'))
        expect(out).toEqual({
            signups: 200,
            depositors: 80,
            players: 60,
            repeatPlayers: 30,
            rates: { signupToDeposit: 40, depositToPlay: 75, playToRepeat: 50 },
        })
    })
})

describe('AnalyticsService.getEngagement', () => {
    it('shapes distribution, activity, win-experience and idle money', async () => {
        queryRaw
            .mockResolvedValueOnce([{ one_game: 50, g2_5: 30, g6_20: 15, g20_plus: 5, active_7d: 20, total_players: 100 }])
            .mockResolvedValueOnce([{ winners_total: 40, winners_active_7d: 20, losers_total: 30, losers_active_7d: 3 }])
            .mockResolvedValueOnce([{ idle_wallets: 12, idle_balance: '340.50' }])
        const out = await AnalyticsService.getEngagement()
        expect(out.oneAndDonePct).toBe(50)
        expect(out.distribution).toEqual({ '1': 50, '2-5': 30, '6-20': 15, '20+': 5 })
        expect(out.winExperience).toEqual({
            winners: { total: 40, active7dPct: 50 },
            neverWon: { total: 30, active7dPct: 10 },
        })
        expect(out.idleMoney).toEqual({ wallets: 12, balance: 340.5 })
    })
})
