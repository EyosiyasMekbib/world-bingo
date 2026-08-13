import prisma from '../../lib/prisma'
import { compileSegment, explainSegment, SegmentCompileError } from './segment-compiler'
import { parseSegmentRuleSet } from '@world-bingo/shared-types'
import type { SegmentRuleSet } from '@world-bingo/shared-types'

/**
 * Segment CRUD, counting and export.
 *
 * Every path that turns stored `rules` JSON into a query goes through
 * compileSegment, which re-validates against the field whitelist. Rules are
 * validated on write too, but a row could have been edited directly in the DB —
 * validating on read as well means a hand-edited row fails loudly instead of
 * becoming an unbounded query.
 */

/** Columns exported to CSV. Deliberately excludes anything not needed for outreach. */
const EXPORT_COLUMNS = [
    'userId',
    'phone',
    'lifetimeDeposits',
    'depositCount',
    'lastDepositAt',
    'gamesPlayed',
    'lastPlayedAt',
    'netLoss',
    'realBalance',
    'bonusBalance',
    'daysSinceLastDeposit',
    'daysSinceLastPlay',
    'tenureDays',
] as const

export interface SegmentInput {
    name: string
    description?: string | null
    rules: unknown
    createdById?: string | null
}

export class SegmentService {
    /**
     * List with counts.
     *
     * A segment list where every count reads "—" hides the one number the screen
     * exists to show, so counts are filled in on read. They are only recomputed
     * when missing or older than the last metrics rebuild — the numbers cannot
     * have changed otherwise, since the rollup is the only thing that moves them.
     * Repeat loads are therefore a single query.
     */
    static async list() {
        const [segments, metrics] = await Promise.all([
            prisma.segment.findMany({ orderBy: [{ isPreset: 'desc' }, { name: 'asc' }] }),
            prisma.playerMetrics.aggregate({ _max: { refreshedAt: true } }),
        ])
        const metricsAt = metrics._max.refreshedAt

        return Promise.all(
            segments.map(async (s) => {
                const stale =
                    s.cachedCount === null ||
                    s.countedAt === null ||
                    (metricsAt !== null && s.countedAt < metricsAt)

                let cachedCount = s.cachedCount
                let countedAt = s.countedAt

                if (stale) {
                    try {
                        cachedCount = await SegmentService.countRules(s.rules)
                        countedAt = new Date()
                        await prisma.segment.update({
                            where: { id: s.id },
                            data: { cachedCount, countedAt },
                        })
                    } catch {
                        // A malformed stored rule set must not break the list screen.
                        cachedCount = null
                    }
                }

                return {
                    ...s,
                    cachedCount,
                    countedAt,
                    summary: SegmentService.safeExplain(s.rules),
                }
            }),
        )
    }

    static async getById(id: string) {
        const segment = await prisma.segment.findUnique({ where: { id } })
        if (!segment) throw new Error('Segment not found')
        return { ...segment, summary: SegmentService.safeExplain(segment.rules) }
    }

    /** Never throws — a malformed stored rule set must not break the list screen. */
    private static safeExplain(rules: unknown): string {
        try {
            return explainSegment(parseSegmentRuleSet(rules))
        } catch {
            return 'Invalid segment rules'
        }
    }

    static async create(input: SegmentInput) {
        const rules = parseSegmentRuleSet(input.rules)
        return prisma.segment.create({
            data: {
                name: input.name,
                description: input.description ?? null,
                rules: rules as never,
                createdById: input.createdById ?? null,
                isPreset: false,
            },
        })
    }

    static async update(id: string, input: Partial<SegmentInput>) {
        const data: Record<string, unknown> = {}
        if (input.name !== undefined) data.name = input.name
        if (input.description !== undefined) data.description = input.description
        if (input.rules !== undefined) {
            data.rules = parseSegmentRuleSet(input.rules) as never
            // Any rule change invalidates the cached count — showing a stale number
            // next to new rules is how someone launches at the wrong audience.
            data.cachedCount = null
            data.countedAt = null
        }
        return prisma.segment.update({ where: { id }, data })
    }

    static async remove(id: string) {
        const campaignCount = await prisma.campaign.count({ where: { segmentId: id } })
        if (campaignCount > 0) {
            // Campaigns record who they targeted and why; deleting the segment out
            // from under them would destroy that.
            throw new Error('Cannot delete a segment that campaigns reference')
        }
        return prisma.segment.delete({ where: { id } })
    }

    /** Count matching players for an unsaved rule set — powers the live builder preview. */
    static async countRules(rules: unknown): Promise<number> {
        const where = compileSegment(parseSegmentRuleSet(rules))
        return prisma.playerMetrics.count({ where })
    }

    /** Count a saved segment and cache the result. */
    static async countSegment(id: string): Promise<{ count: number; countedAt: Date }> {
        const segment = await prisma.segment.findUnique({ where: { id } })
        if (!segment) throw new Error('Segment not found')

        const count = await SegmentService.countRules(segment.rules)
        const countedAt = new Date()

        await prisma.segment.update({
            where: { id },
            data: { cachedCount: count, countedAt },
        })

        return { count, countedAt }
    }

    /** A page of matching players, for the drill-down list. */
    static async preview(rules: unknown, opts: { page?: number; limit?: number } = {}) {
        const page = Math.max(1, opts.page ?? 1)
        const limit = Math.min(200, Math.max(1, opts.limit ?? 25))
        const where = compileSegment(parseSegmentRuleSet(rules))

        const [rows, total] = await Promise.all([
            // No include: serial and username are denormalized onto the rollup, so
            // this stays a single-table read no matter how large the segment is.
            prisma.playerMetrics.findMany({
                where,
                orderBy: { lifetimeDeposits: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.playerMetrics.count({ where }),
        ])

        return {
            rows,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        }
    }

    /**
     * Streams the segment to CSV in batches.
     *
     * Batched by design: a 100k-row segment materialised into one array is tens of
     * MB of Decimals and Dates held in memory while the request is open. Cursor
     * pagination (not skip/take) keeps each page cheap regardless of depth.
     */
    static async *exportCsv(rules: unknown, batchSize = 1000): AsyncGenerator<string> {
        const where = compileSegment(parseSegmentRuleSet(rules))

        yield `${EXPORT_COLUMNS.join(',')}\n`

        let cursor: string | undefined
        for (;;) {
            const batch = await prisma.playerMetrics.findMany({
                where,
                orderBy: { userId: 'asc' },
                take: batchSize,
                ...(cursor ? { skip: 1, cursor: { userId: cursor } } : {}),
            })
            if (!batch.length) return

            let chunk = ''
            for (const row of batch) {
                chunk += `${EXPORT_COLUMNS.map((col) => csvCell((row as Record<string, unknown>)[col])).join(',')}\n`
            }
            yield chunk

            cursor = batch[batch.length - 1].userId
            if (batch.length < batchSize) return
        }
    }
}

/**
 * CSV escaping. Phone numbers and usernames are player-controlled in places, so a
 * value starting with =, +, - or @ is prefixed with a quote: spreadsheet software
 * would otherwise execute it as a formula when the file is opened.
 */
function csvCell(value: unknown): string {
    if (value === null || value === undefined) return ''

    let text = value instanceof Date ? value.toISOString() : String(value)

    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`

    if (/[",\n\r]/.test(text)) {
        text = `"${text.replace(/"/g, '""')}"`
    }
    return text
}

export { SegmentCompileError }
