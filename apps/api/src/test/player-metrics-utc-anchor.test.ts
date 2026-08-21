import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: { $executeRaw: vi.fn().mockResolvedValue(0) },
}))
import prisma from '../lib/prisma'
const executeRaw = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>

import { PlayerMetricsService } from '../services/player-crm/player-metrics.service'

/**
 * Regression coverage for the NOW() vs (NOW() AT TIME ZONE 'UTC') bug in
 * avgDailyDeposit: elapsed-time arithmetic against a naive `timestamp` column
 * (dep.first_at / "firstDepositAt", both documented elsewhere in this file as
 * holding UTC) must anchor to UTC explicitly. Subtracting a bare NOW()
 * (timestamptz) from that naive value forces Postgres to implicitly cast it
 * through the SESSION timezone instead of treating it as already-UTC — the
 * exact failure this file's sibling daysSinceLastDeposit/daysSinceLastPlay
 * expressions already guard against via the same `AT TIME ZONE 'UTC'` idiom.
 *
 * This bug is invisible to a behavioral test whenever the test database's own
 * session already runs in UTC (true here, and in CI) — calling the service
 * again would pass regardless of whether the guard is present. So instead of
 * asserting on a computed value, this intercepts the raw SQL handed to
 * Postgres and asserts the guard text is present verbatim. A revert back to
 * bare NOW() fails this test immediately, with no non-UTC database required.
 */
describe('PlayerMetricsService — avgDailyDeposit UTC-anchoring guard', () => {
    beforeEach(() => vi.clearAllMocks())

    it("rollupSql anchors avgDailyDeposit to (NOW() AT TIME ZONE 'UTC'), not bare NOW()", async () => {
        await PlayerMetricsService.refreshAll()

        expect(executeRaw).toHaveBeenCalledTimes(1)
        const sqlArg = executeRaw.mock.calls[0][0] as { text: string }

        expect(sqlArg.text).toContain(
            `EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - dep.first_at))`,
        )
        // Guards against a partial revert that keeps the wrapper but drops the anchor.
        expect(sqlArg.text).not.toContain(`EXTRACT(EPOCH FROM (NOW() - dep.first_at))`)
    })

    it("syncAvgDailyDeposit's UPDATE anchors to (NOW() AT TIME ZONE 'UTC'), not bare NOW()", async () => {
        await PlayerMetricsService.syncAvgDailyDeposit()

        expect(executeRaw).toHaveBeenCalledTimes(1)
        const [strings] = executeRaw.mock.calls[0] as [TemplateStringsArray]
        const text = Array.isArray(strings) ? strings.join('') : String(strings)

        expect(text).toContain(
            `EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - "firstDepositAt"))`,
        )
        expect(text).not.toContain(`EXTRACT(EPOCH FROM (NOW() - "firstDepositAt"))`)
    })
})
