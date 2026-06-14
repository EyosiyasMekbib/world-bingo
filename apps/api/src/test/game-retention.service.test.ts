import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: { $queryRaw: vi.fn() },
}))
import prisma from '../lib/prisma'
const queryRaw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>

import { AnalyticsService } from '../services/analytics.service'

beforeEach(() => vi.clearAllMocks())

describe('AnalyticsService.getGameRetentionScorecard', () => {
    it('shapes cohort + stickiness rows into scorecard rows', async () => {
        // cohortRows (query 1): one per game
        queryRaw.mockResolvedValueOnce([
            {
                game_key: 'bingo:t1',
                game_label: 'Quick 10',
                game_type: 'bingo',
                cohort_size: 100,
                returned_7d: 60,
                returned_next_day: 40,
                baseline_total: 200,
                baseline_returned: 80,
            },
            {
                game_key: 'provider:SLOTS_001',
                game_label: 'Lucky Spin',
                game_type: 'provider',
                cohort_size: 50,
                returned_7d: 20,
                returned_next_day: 10,
                baseline_total: 200,
                baseline_returned: 80,
            },
        ])
        // stickinessRows (query 2): one per game
        queryRaw.mockResolvedValueOnce([
            {
                game_key: 'bingo:t1',
                total_sessions: 300,
                total_players: 150,
                replay_players: 90,
                avg_net_pnl: null,
            },
            {
                game_key: 'provider:SLOTS_001',
                total_sessions: 200,
                total_players: 100,
                replay_players: 30,
                avg_net_pnl: '-12.50',
            },
        ])

        const out = await AnalyticsService.getGameRetentionScorecard(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )

        expect(out.rows).toHaveLength(2)
        expect(out.baselineReturn7dPct).toBe(40)

        const bingo = out.rows.find(r => r.gameKey === 'bingo:t1')!
        expect(bingo.gameLabel).toBe('Quick 10')
        expect(bingo.gameType).toBe('bingo')
        expect(bingo.firstGameCohort).toBe(100)
        expect(bingo.returnRate7d).toBe(60)       // pct(60, 100)
        expect(bingo.lift).toBe(20)               // 60 - 40
        expect(bingo.nextDayReturn).toBe(40)      // pct(40, 100)
        expect(bingo.replayRate).toBe(60)         // pct(90, 150)
        expect(bingo.sessionsPerPlayer).toBe(2)   // 300/150
        expect(bingo.avgNetPnl).toBeNull()
        expect(bingo.lowSample).toBe(false)

        const provider = out.rows.find(r => r.gameKey === 'provider:SLOTS_001')!
        expect(provider.returnRate7d).toBe(40)    // pct(20, 50)
        expect(provider.lift).toBe(0)             // 40 - 40
        expect(provider.avgNetPnl).toBe(-12.5)
        expect(provider.lowSample).toBe(false)
    })

    it('marks low-sample rows (cohort < 10)', async () => {
        queryRaw.mockResolvedValueOnce([{
            game_key: 'bingo:t2', game_label: 'Rare', game_type: 'bingo',
            cohort_size: 5, returned_7d: 3, returned_next_day: 2,
            baseline_total: 100, baseline_returned: 50,
        }])
        queryRaw.mockResolvedValueOnce([{
            game_key: 'bingo:t2', total_sessions: 5, total_players: 5,
            replay_players: 0, avg_net_pnl: null,
        }])
        const out = await AnalyticsService.getGameRetentionScorecard(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.rows[0].lowSample).toBe(true)
    })

    it('handles empty result gracefully', async () => {
        queryRaw.mockResolvedValueOnce([])
        queryRaw.mockResolvedValueOnce([])
        const out = await AnalyticsService.getGameRetentionScorecard(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.rows).toHaveLength(0)
        expect(out.baselineReturn7dPct).toBe(0)
    })
})

describe('AnalyticsService.getProviderBrowseFunnel', () => {
    it('returns stages with drop-off pcts', async () => {
        queryRaw.mockResolvedValueOnce([{
            viewed: 400,
            launched: 300,
            first_bet: 200,
            returned_7d: 80,
        }])
        const out = await AnalyticsService.getProviderBrowseFunnel(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.stages).toHaveLength(4)
        expect(out.stages[0]).toEqual({ name: 'viewed', count: 400, dropOffPct: 0 })
        expect(out.stages[1]).toEqual({ name: 'launched', count: 300, dropOffPct: 25 })
        expect(out.stages[2]).toEqual({ name: 'first_bet', count: 200, dropOffPct: 33.3 })
        expect(out.stages[3]).toEqual({ name: 'returned_7d', count: 80, dropOffPct: 60 })
        expect(out.hasEnoughData).toBe(true)
    })

    it('returns hasEnoughData false when viewed < 50', async () => {
        queryRaw.mockResolvedValueOnce([{ viewed: 30, launched: 20, first_bet: 10, returned_7d: 5 }])
        const out = await AnalyticsService.getProviderBrowseFunnel(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.hasEnoughData).toBe(false)
    })

    it('handles empty result', async () => {
        queryRaw.mockResolvedValueOnce([])
        const out = await AnalyticsService.getProviderBrowseFunnel(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.stages.every(s => s.count === 0)).toBe(true)
        expect(out.hasEnoughData).toBe(false)
    })
})
