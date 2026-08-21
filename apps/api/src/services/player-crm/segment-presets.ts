import prisma from '../../lib/prisma'
import { SEGMENT_RULESET_VERSION } from '@world-bingo/shared-types'
import type { SegmentRuleSet } from '@world-bingo/shared-types'

/**
 * The seeded segments.
 *
 * These are ROWS, not code paths — "preset" and "custom" are the same thing, so a
 * marketer can clone one and adjust a threshold on day one without a deploy. They
 * are seeded only when absent, and never overwritten, so local edits survive
 * redeploys.
 *
 * Thresholds are scaled to this platform: tickets are 10–100 ETB, so a lifetime
 * deposit of 5,000 ETB is a genuine high roller rather than an arbitrary round
 * number.
 */

const and = (...children: SegmentRuleSet['root']['children']): SegmentRuleSet => ({
    version: SEGMENT_RULESET_VERSION,
    root: { kind: 'group', op: 'AND', children },
})

export interface SegmentPreset {
    name: string
    description: string
    rules: SegmentRuleSet
}

export const SEGMENT_PRESETS: SegmentPreset[] = [
    {
        name: 'New players',
        description: 'Signed up in the last 7 days. Onboarding and first-deposit nudges.',
        rules: and({ kind: 'cond', field: 'tenureDays', op: 'lte', value: 7 }),
    },
    {
        name: 'Active players',
        description: 'Played within the last 7 days. Your healthy core — do not spam them.',
        rules: and({ kind: 'cond', field: 'daysSinceLastPlay', op: 'lte', value: 7 }),
    },
    {
        name: 'At risk',
        description:
            'Deposited before, last played 8–30 days ago. The highest-value window to intervene: still warm, not yet gone.',
        rules: and(
            { kind: 'cond', field: 'depositCount', op: 'gte', value: 1 },
            { kind: 'cond', field: 'daysSinceLastPlay', op: 'between', value: [8, 30] },
        ),
    },
    {
        name: 'Churned depositors',
        description:
            'Paying players who have not played in over 30 days. Win-back targets — they already trusted you with money once.',
        rules: and(
            { kind: 'cond', field: 'depositCount', op: 'gte', value: 1 },
            { kind: 'cond', field: 'daysSinceLastPlay', op: 'gt', value: 30 },
        ),
    },
    {
        name: 'VIP / high rollers',
        description: 'Lifetime deposits of 5,000 ETB or more. Small group, large share of revenue.',
        rules: and({ kind: 'cond', field: 'lifetimeDeposits', op: 'gte', value: 5000 }),
    },
    {
        name: 'Deposited but never played',
        description:
            'Money is in the wallet and no game has been played. Usually a UX or comprehension problem, not a pricing one.',
        rules: and(
            { kind: 'cond', field: 'depositCount', op: 'gte', value: 1 },
            { kind: 'cond', field: 'gamesPlayed', op: 'eq', value: 0 },
        ),
    },
    {
        name: 'Heavy losers',
        description:
            'Net loss over 1,000 ETB across bingo and casino. Treat as a duty-of-care list first and a cashback list second.',
        rules: and({ kind: 'cond', field: 'netLoss', op: 'gte', value: 1000 }),
    },
    {
        name: 'Referrers',
        description: 'Brought at least one player in. Your cheapest acquisition channel.',
        rules: and({ kind: 'cond', field: 'referralCount', op: 'gte', value: 1 }),
    },
    {
        name: 'Micro depositor',
        description: 'Averaging under 50 ETB/day since their first deposit. Small, frequent top-ups.',
        rules: and({ kind: 'cond', field: 'avgDailyDeposit', op: 'lt', value: 50 }),
    },
    {
        name: 'Casual depositor',
        description: 'Averaging 50-200 ETB/day since their first deposit.',
        rules: and(
            { kind: 'cond', field: 'avgDailyDeposit', op: 'gte', value: 50 },
            { kind: 'cond', field: 'avgDailyDeposit', op: 'lt', value: 200 },
        ),
    },
    {
        name: 'Core depositor',
        description: 'Averaging 200-1000 ETB/day since their first deposit. The bulk of deposit volume.',
        rules: and(
            { kind: 'cond', field: 'avgDailyDeposit', op: 'gte', value: 200 },
            { kind: 'cond', field: 'avgDailyDeposit', op: 'lt', value: 1000 },
        ),
    },
    {
        name: 'Whale',
        description: 'Averaging 1000+ ETB/day since their first deposit. High-value, handle with care.',
        rules: and({ kind: 'cond', field: 'avgDailyDeposit', op: 'gte', value: 1000 }),
    },
]

/**
 * Seed presets that do not already exist. Idempotent, and deliberately does NOT
 * update existing rows — an operator who retuned a threshold should not have it
 * silently reverted by the next deploy.
 */
export async function seedSegmentPresets(): Promise<{ created: number; skipped: number }> {
    let created = 0
    let skipped = 0

    for (const preset of SEGMENT_PRESETS) {
        const existing = await prisma.segment.findUnique({ where: { name: preset.name } })
        if (existing) {
            skipped++
            continue
        }
        await prisma.segment.create({
            data: {
                name: preset.name,
                description: preset.description,
                rules: preset.rules as never,
                isPreset: true,
            },
        })
        created++
    }

    return { created, skipped }
}
