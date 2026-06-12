import { describe, it, expect } from 'vitest'
import { AnalyticsService } from '../services/analytics.service'

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
