import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: { $queryRaw: vi.fn() },
}))
import prisma from '../lib/prisma'
const queryRaw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>

import { AnalyticsService } from '../services/analytics.service'

beforeEach(() => { vi.clearAllMocks() })

describe('AnalyticsService.getBrowseFunnel', () => {
    it('returns browse stages with drop-off rates', async () => {
        queryRaw.mockResolvedValueOnce([{
            visited: 1000,
            viewed_game: 600,
            join_click: 300,
            registered: 120,
            deposited: 80,
            played: 60,
        }])
        const out = await AnalyticsService.getBrowseFunnel(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.stages).toHaveLength(6)
        expect(out.stages[0]).toEqual({ name: 'visited', count: 1000, dropOffPct: 0 })
        expect(out.stages[1]).toEqual({ name: 'viewed_game', count: 600, dropOffPct: 40 })
        expect(out.stages[5]).toEqual({ name: 'played', count: 60, dropOffPct: 25 })
    })

    it('handles empty result (no events yet)', async () => {
        queryRaw.mockResolvedValueOnce([])
        const out = await AnalyticsService.getBrowseFunnel(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.stages.every(s => s.count === 0)).toBe(true)
    })
})

describe('AnalyticsService.getDepositFunnel', () => {
    it('returns deposit stages and method breakdown', async () => {
        queryRaw
            .mockResolvedValueOnce([{
                modal_opened: 500,
                method_selected: 450,
                amount_entered: 380,
                submitted: 300,
                approved: 240,
                avg_approval_secs: '180.5',
            }])
            .mockResolvedValueOnce([
                { payment_method: 'TELEBIRR', submitted: 200, approved: 170 },
                { payment_method: 'CBE', submitted: 100, approved: 70 },
            ])
        const out = await AnalyticsService.getDepositFunnel(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.stages[0]).toEqual({ name: 'modal_opened', count: 500, dropOffPct: 0 })
        expect(out.stages[4]).toEqual({ name: 'approved', count: 240, dropOffPct: 20 })
        expect(out.avgApprovalSecs).toBe(181)
        expect(out.byMethod).toHaveLength(2)
        expect(out.byMethod[0].method).toBe('TELEBIRR')
        expect(out.byMethod[0].conversionPct).toBe(85)
    })
})

describe('AnalyticsService.getConversionKpis', () => {
    it('returns visitor and registration rates', async () => {
        queryRaw.mockResolvedValueOnce([{
            total_visitors: 2000,
            anon_visitors: 1500,
            registered: 120,
            first_deposited: 80,
            browse_sessions: 2200,
            join_clicks: 300,
        }])
        const out = await AnalyticsService.getConversionKpis(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.visitorToRegPct).toBe(6)
        expect(out.regToDepositPct).toBe(66.7)
        expect(out.browseToJoinPct).toBe(15)
        expect(out.totalVisitors).toBe(2000)
        expect(out.anonVisitors).toBe(1500)
    })
})
