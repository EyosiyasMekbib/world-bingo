import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SegmentService } from '../services/player-crm/segment.service'
import { SEGMENT_PRESETS, seedSegmentPresets } from '../services/player-crm/segment-presets'
import { PlayerMetricsService } from '../services/player-crm/player-metrics.service'
import { compileSegment } from '../services/player-crm/segment-compiler'
import { prisma } from './setup'
import { SEGMENT_RULESET_VERSION } from '@world-bingo/shared-types'

vi.mock('../lib/socket', () => ({
    getIo: () => ({ to: () => ({ emit: vi.fn() }), emit: vi.fn() }),
}))

async function player(username: string, phone: string, deposits: number[]) {
    const user = await prisma.user.create({
        data: {
            username,
            phone,
            passwordHash: 'hashed:pass',
            role: 'PLAYER',
            wallet: { create: { realBalance: 0, bonusBalance: 0 } },
        },
    })
    for (const amount of deposits) {
        await prisma.transaction.create({
            data: {
                userId: user.id,
                type: 'DEPOSIT',
                status: 'APPROVED',
                amount,
                balanceBefore: 0,
                balanceAfter: 0,
                bonusBalanceBefore: 0,
                bonusBalanceAfter: 0,
            },
        })
    }
    return user
}

const rules = (field: string, op: string, value: unknown) => ({
    version: SEGMENT_RULESET_VERSION,
    root: { kind: 'group', op: 'AND', children: [{ kind: 'cond', field, op, value }] },
})

describe('SEGMENT_PRESETS', () => {
    // A preset that does not compile is a broken product on first load, and the
    // AST is easy to drift away from the whitelist. This is the guard.
    it.each(SEGMENT_PRESETS.map((p) => [p.name, p] as const))(
        'preset "%s" compiles to a valid query',
        (_name, preset) => {
            expect(() => compileSegment(preset.rules)).not.toThrow()
        },
    )

    it('ships exactly the twelve documented presets, uniquely named', () => {
        expect(SEGMENT_PRESETS).toHaveLength(12)
        expect(new Set(SEGMENT_PRESETS.map((p) => p.name)).size).toBe(12)
    })

    it('every preset actually runs against the database', async () => {
        for (const preset of SEGMENT_PRESETS) {
            const count = await SegmentService.countRules(preset.rules)
            expect(typeof count).toBe('number')
        }
    })
})

describe('seedSegmentPresets', () => {
    it('creates the presets once and is idempotent', async () => {
        const first = await seedSegmentPresets()
        expect(first.created).toBe(12)

        const second = await seedSegmentPresets()
        expect(second.created).toBe(0)
        expect(second.skipped).toBe(12)
        expect(await prisma.segment.count()).toBe(12)
    })

    it('does not overwrite an operator-retuned threshold', async () => {
        await seedSegmentPresets()
        const vip = await prisma.segment.findUnique({ where: { name: 'VIP / high rollers' } })
        await prisma.segment.update({
            where: { id: vip!.id },
            data: { rules: rules('lifetimeDeposits', 'gte', 99) as never },
        })

        await seedSegmentPresets()

        const after = await prisma.segment.findUnique({ where: { id: vip!.id } })
        expect((after!.rules as never as ReturnType<typeof rules>).root.children[0].value).toBe(99)
    })

    it('seeds the four avgDailyDeposit presets', async () => {
        await seedSegmentPresets()
        const names = (await prisma.segment.findMany({ where: { isPreset: true } })).map((s) => s.name)
        expect(names).toEqual(
            expect.arrayContaining([
                'Micro depositor',
                'Casual depositor',
                'Core depositor',
                'Whale',
            ]),
        )
    })
})

describe('SegmentService — counting and preview', () => {
    beforeEach(async () => {
        await player('seg_small', '+251900700001', [100])
        await player('seg_big', '+251900700002', [6000])
        await player('seg_none', '+251900700003', [])
        await PlayerMetricsService.refreshAll()
    })

    it('counts players matching an unsaved rule set', async () => {
        expect(await SegmentService.countRules(rules('lifetimeDeposits', 'gte', 5000))).toBe(1)
        expect(await SegmentService.countRules(rules('depositCount', 'gte', 1))).toBe(2)
        expect(await SegmentService.countRules(rules('depositCount', 'eq', 0))).toBe(1)
    })

    it('returns a paginated drill-down', async () => {
        const result = await SegmentService.preview(rules('depositCount', 'gte', 1), { limit: 1 })

        expect(result.rows).toHaveLength(1)
        expect(result.pagination.total).toBe(2)
        expect(result.pagination.totalPages).toBe(2)
    })

    it('caches the count on a saved segment', async () => {
        const segment = await SegmentService.create({
            name: 'Depositors',
            rules: rules('depositCount', 'gte', 1),
        })

        const { count } = await SegmentService.countSegment(segment.id)

        expect(count).toBe(2)
        const stored = await prisma.segment.findUnique({ where: { id: segment.id } })
        expect(stored!.cachedCount).toBe(2)
        expect(stored!.countedAt).not.toBeNull()
    })

    it('clears the cached count when rules change, so a stale number is never shown', async () => {
        const segment = await SegmentService.create({
            name: 'Retuned',
            rules: rules('depositCount', 'gte', 1),
        })
        await SegmentService.countSegment(segment.id)

        await SegmentService.update(segment.id, { rules: rules('depositCount', 'gte', 99) })

        const stored = await prisma.segment.findUnique({ where: { id: segment.id } })
        expect(stored!.cachedCount).toBeNull()
        expect(stored!.countedAt).toBeNull()
    })

    it('rejects invalid rules on create', async () => {
        await expect(
            SegmentService.create({ name: 'Bad', rules: rules('passwordHash', 'eq', 1) }),
        ).rejects.toThrow()
    })

    it('avgDailyDeposit is a valid segment field and compiles', async () => {
        const count = await SegmentService.countRules(rules('avgDailyDeposit', 'gte', 200))
        expect(typeof count).toBe('number')
    })
})

describe('SegmentService — CSV export', () => {
    beforeEach(async () => {
        await player('csv_one', '+251900700004', [500])
        await PlayerMetricsService.refreshAll()
    })

    async function collect(rulesInput: unknown): Promise<string> {
        let out = ''
        for await (const chunk of SegmentService.exportCsv(rulesInput, 2)) out += chunk
        return out
    }

    it('emits a header row and one row per player', async () => {
        const csv = await collect(rules('depositCount', 'gte', 1))
        const lines = csv.trim().split('\n')

        expect(lines[0]).toContain('userId')
        expect(lines[0]).toContain('phone')
        expect(lines).toHaveLength(2)
        expect(lines[1]).toContain('+251900700004')
    })

    it('neutralises spreadsheet formula injection in exported values', async () => {
        // Phone is player-controlled in places. A cell starting with = would be
        // executed by Excel/Sheets when the marketer opens the file.
        await prisma.user.create({
            data: {
                username: 'csv_evil',
                phone: '=HYPERLINK("http://evil","click")',
                passwordHash: 'hashed:pass',
                role: 'PLAYER',
                wallet: { create: { realBalance: 0, bonusBalance: 0 } },
            },
        })
        await PlayerMetricsService.refreshAll()

        const csv = await collect(rules('depositCount', 'gte', 0))

        expect(csv).toContain("'=HYPERLINK")
        expect(csv).not.toMatch(/(^|,)=HYPERLINK/m)
    })
})
