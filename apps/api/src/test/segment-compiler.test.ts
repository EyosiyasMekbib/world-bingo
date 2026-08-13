import { describe, it, expect } from 'vitest'
import { compileSegment, SegmentCompileError } from '../services/player-crm/segment-compiler'
import { SEGMENT_RULESET_VERSION } from '@world-bingo/shared-types'
import type { SegmentNode, SegmentRuleSet } from '@world-bingo/shared-types'

/**
 * The compiler turns a user-authored JSON AST into a Prisma `where` clause. It is
 * the security boundary of the whole CRM: everything in the AST originates from
 * an admin form. The invariant under test is that no user-supplied string ever
 * becomes a SQL identifier or operator — field keys are looked up in a closed
 * whitelist, and anything unrecognised is rejected rather than passed through.
 *
 * Pure function, no DB, no I/O — so these run in milliseconds and are unaffected
 * by the flakiness of the DB-backed suites.
 */

const ruleSet = (...children: SegmentNode[]): SegmentRuleSet => ({
    version: SEGMENT_RULESET_VERSION,
    root: { kind: 'group', op: 'AND', children },
})

describe('compileSegment — leaves', () => {
    it('compiles a numeric comparison to the mapped column', () => {
        const where = compileSegment(
            ruleSet({ kind: 'cond', field: 'lifetimeDeposits', op: 'gt', value: 1000 }),
        )

        expect(where).toEqual({ AND: [{ lifetimeDeposits: { gt: 1000 } }] })
    })

    it('compiles equality', () => {
        const where = compileSegment(
            ruleSet({ kind: 'cond', field: 'depositCount', op: 'eq', value: 0 }),
        )

        expect(where).toEqual({ AND: [{ depositCount: { equals: 0 } }] })
    })

    it('compiles between to an inclusive range', () => {
        const where = compileSegment(
            ruleSet({ kind: 'cond', field: 'netLoss', op: 'between', value: [100, 500] }),
        )

        expect(where).toEqual({ AND: [{ netLoss: { gte: 100, lte: 500 } }] })
    })

    it('compiles is_null and is_not_null on a presence field', () => {
        expect(compileSegment(ruleSet({ kind: 'cond', field: 'hasPhone', op: 'is_null' }))).toEqual({
            AND: [{ phone: null }],
        })
        expect(
            compileSegment(ruleSet({ kind: 'cond', field: 'hasTelegram', op: 'is_not_null' })),
        ).toEqual({ AND: [{ telegramId: { not: null } }] })
    })

    it('compiles a date comparison to the date column', () => {
        const when = '2026-01-01T00:00:00.000Z'
        const where = compileSegment(
            ruleSet({ kind: 'cond', field: 'firstDepositAt', op: 'after', value: when }),
        )

        expect(where).toEqual({ AND: [{ firstDepositAt: { gt: new Date(when) } }] })
    })
})

describe('compileSegment — recency compiles against the timestamp, not the stored integer', () => {
    // The stored daysSince* integers only move when a player's row is refreshed,
    // and the incremental pass only refreshes players who were ACTIVE. A churned
    // player is by definition inactive, so their integer freezes on the day they
    // stopped — the one cohort a churn segment exists to find would be missed
    // until the nightly rebuild. Anchoring to the timestamp is always correct.
    const now = new Date('2026-08-12T00:00:00.000Z')

    it('maps in_last_days to a timestamp cutoff', () => {
        const where = compileSegment(
            ruleSet({ kind: 'cond', field: 'lastPlayedAt', op: 'in_last_days', value: 7 }),
            { now },
        )

        expect(where).toEqual({
            AND: [{ lastPlayedAt: { gte: new Date('2026-08-05T00:00:00.000Z') } }],
        })
    })

    it('maps not_in_last_days to a timestamp cutoff, excluding never-played', () => {
        // "not in the last 30 days" means they DID play, just not recently.
        // Never-played is reached with is_null, so the two stay separable.
        const where = compileSegment(
            ruleSet({ kind: 'cond', field: 'lastPlayedAt', op: 'not_in_last_days', value: 30 }),
            { now },
        )

        expect(where).toEqual({
            AND: [{ lastPlayedAt: { lt: new Date('2026-07-13T00:00:00.000Z'), not: null } }],
        })
    })

    it('never references a daysSince column, which would reintroduce the staleness', () => {
        const where = compileSegment(
            ruleSet({ kind: 'cond', field: 'lastDepositAt', op: 'not_in_last_days', value: 14 }),
            { now },
        )

        expect(JSON.stringify(where)).not.toContain('daysSince')
    })
})

describe('compileSegment — groups', () => {
    it('compiles nested AND/OR', () => {
        const where = compileSegment({
            version: SEGMENT_RULESET_VERSION,
            root: {
                kind: 'group',
                op: 'AND',
                children: [
                    { kind: 'cond', field: 'lifetimeDeposits', op: 'gte', value: 1000 },
                    {
                        kind: 'group',
                        op: 'OR',
                        children: [
                            { kind: 'cond', field: 'daysSinceLastPlay', op: 'gt', value: 14 },
                            { kind: 'cond', field: 'daysSinceLastDeposit', op: 'gt', value: 14 },
                        ],
                    },
                ],
            },
        })

        expect(where).toEqual({
            AND: [
                { lifetimeDeposits: { gte: 1000 } },
                { OR: [{ daysSinceLastPlay: { gt: 14 } }, { daysSinceLastDeposit: { gt: 14 } }] },
            ],
        })
    })

    it('rejects a negated group — NOT silently drops NULL rows in SQL', () => {
        // "Churned AND NOT recent depositor" would exclude every player who never
        // deposited, which is the cohort such a campaign targets. Cut from v1
        // rather than shipping a construct that reads correct and behaves wrong.
        expect(() =>
            compileSegment({
                version: SEGMENT_RULESET_VERSION,
                root: {
                    kind: 'group',
                    op: 'AND',
                    not: true,
                    children: [{ kind: 'cond', field: 'gamesPlayed', op: 'eq', value: 0 }],
                },
            } as never),
        ).toThrow()
    })
})

describe('compileSegment — money fields reject exact equality', () => {
    it('rejects eq on a money field, which decimal dust makes unreliable', () => {
        // realBalance is Decimal(20,8). `eq 0` misses a wallet holding
        // 0.00000001 of settlement dust, with no error — use `lt 1` instead.
        expect(() =>
            compileSegment(ruleSet({ kind: 'cond', field: 'realBalance', op: 'eq', value: 0 } as never)),
        ).toThrow(/operator/i)
    })

    it('still allows range comparisons on money', () => {
        expect(() =>
            compileSegment(ruleSet({ kind: 'cond', field: 'realBalance', op: 'lt', value: 1 })),
        ).not.toThrow()
    })
})

describe('compileSegment — rejections', () => {
    const rejects = (input: unknown, match: RegExp) =>
        expect(() => compileSegment(input as SegmentRuleSet)).toThrow(match)

    it('rejects an unknown field rather than passing it through as a column', () => {
        rejects(ruleSet({ kind: 'cond', field: 'passwordHash', op: 'eq', value: 1 } as never), /field/i)
    })

    it('rejects an operator the field does not allow', () => {
        // `before` is a date operator; lifetimeDeposits is money.
        rejects(
            ruleSet({ kind: 'cond', field: 'lifetimeDeposits', op: 'before', value: 1 } as never),
            /operator/i,
        )
    })

    it('rejects a type mismatch, naming the offending value', () => {
        rejects(
            ruleSet({ kind: 'cond', field: 'lifetimeDeposits', op: 'gt', value: 'lots' } as never),
            /\.value/i,
        )
    })

    it('rejects a value outside the field bounds', () => {
        rejects(
            ruleSet({ kind: 'cond', field: 'depositCount', op: 'gt', value: 999_999_999 } as never),
            /maximum|exceed/i,
        )
    })

    it('rejects an empty group', () => {
        rejects({ version: SEGMENT_RULESET_VERSION, root: { kind: 'group', op: 'AND', children: [] } }, /.+/)
    })

    it('rejects nesting deeper than the limit', () => {
        const deep = {
            version: SEGMENT_RULESET_VERSION,
            root: {
                kind: 'group',
                op: 'AND',
                children: [
                    {
                        kind: 'group',
                        op: 'AND',
                        children: [
                            {
                                kind: 'group',
                                op: 'AND',
                                children: [
                                    {
                                        kind: 'group',
                                        op: 'AND',
                                        children: [
                                            { kind: 'cond', field: 'gamesPlayed', op: 'gt', value: 1 },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        }
        rejects(deep, /.+/)
    })

    it('rejects a wrong ruleset version', () => {
        rejects({ version: 99, root: { kind: 'group', op: 'AND', children: [] } }, /.+/)
    })

    it('rejects a SQL-injection attempt in the field position', () => {
        rejects(
            ruleSet({
                kind: 'cond',
                field: 'lifetimeDeposits"; DROP TABLE users; --',
                op: 'gt',
                value: 1,
            } as never),
            /field/i,
        )
    })

    it('rejects a SQL-injection attempt in the operator position', () => {
        rejects(
            ruleSet({ kind: 'cond', field: 'lifetimeDeposits', op: "gt' OR '1'='1", value: 1 } as never),
            /.+/,
        )
    })

    it('passes an injection attempt in the VALUE position through as a bound value, never as SQL', () => {
        // A string value on a date field is legitimate input shape-wise; what
        // matters is that it stays a value. It must not be accepted as a number
        // field's value, and it never becomes an identifier.
        rejects(
            ruleSet({
                kind: 'cond',
                field: 'lifetimeDeposits',
                op: 'gt',
                value: "1; DROP TABLE users",
            } as never),
            /\.value/i,
        )
    })

    it('throws SegmentCompileError, so callers can map it to a 400', () => {
        try {
            compileSegment(ruleSet({ kind: 'cond', field: 'nope', op: 'gt', value: 1 } as never))
            throw new Error('should have thrown')
        } catch (err) {
            expect(err).toBeInstanceOf(SegmentCompileError)
        }
    })
})
