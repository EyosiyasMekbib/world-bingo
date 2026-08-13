import { z } from 'zod'

/**
 * Segment rule AST — the contract shared by the API (which validates and compiles
 * it) and the admin builder UI (which renders it). Both import the SAME whitelist
 * object, so the two cannot drift.
 *
 * The security property that matters: no user-supplied string ever reaches SQL as
 * an identifier or an operator. A leaf names a FIELD KEY from a closed set; the
 * compiler maps that key to a column name it owns. Anything not in the set fails
 * Zod parsing before the compiler is ever called.
 */

export const SEGMENT_RULESET_VERSION = 1 as const

/** Root group is level 1. Bounded by construction, not by a runtime check. */
export const SEGMENT_MAX_DEPTH = 3
export const SEGMENT_MAX_CHILDREN = 12
export const SEGMENT_MAX_NODES = 40

export const SEGMENT_OPERATORS = [
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'before',
    'after',
    'in_last_days',
    'not_in_last_days',
    'is_null',
    'is_not_null',
] as const

export type SegmentOperator = (typeof SEGMENT_OPERATORS)[number]

/** 0 = takes no value, 1 = scalar, 2 = inclusive pair. */
export const OPERATOR_ARITY: Record<SegmentOperator, 0 | 1 | 2> = {
    is_null: 0,
    is_not_null: 0,
    eq: 1,
    neq: 1,
    gt: 1,
    gte: 1,
    lt: 1,
    lte: 1,
    before: 1,
    after: 1,
    in_last_days: 1,
    not_in_last_days: 1,
    between: 2,
}

export type SegmentFieldType = 'money' | 'int' | 'days' | 'date' | 'presence'

export interface SegmentFieldDescriptor {
    /** The ONLY string ever used as a SQL identifier. Never comes from user input. */
    column: string
    type: SegmentFieldType
    operators: readonly SegmentOperator[]
    label: string
    /**
     * Metadata only: names the precomputed "days since" companion for display.
     * The compiler does NOT use it — recency compiles against the timestamp,
     * because the stored integer stops moving for exactly the players a churn
     * segment is looking for.
     */
    recencyColumn?: string
    min?: number
    max?: number
}

const NUMERIC: readonly SegmentOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between']

/**
 * Money deliberately has no `eq`/`neq`.
 *
 * Balances are Decimal(20,8). `realBalance eq 0` looks like "empty wallet" but
 * silently misses anyone holding 0.00000001 of provider-settlement dust — no
 * error, just a cohort that quietly excludes real players. Range operators express
 * the same intent without the trap: use `lt 1` for "effectively empty".
 */
const MONEY: readonly SegmentOperator[] = ['gt', 'gte', 'lt', 'lte', 'between']
const DAYS: readonly SegmentOperator[] = [...NUMERIC, 'is_null', 'is_not_null']
const DATE: readonly SegmentOperator[] = [
    'before',
    'after',
    'between',
    'in_last_days',
    'not_in_last_days',
    'is_null',
    'is_not_null',
]
const PRESENCE: readonly SegmentOperator[] = ['is_null', 'is_not_null']

const money = (column: string, label: string, min = 0): SegmentFieldDescriptor => ({
    column,
    type: 'money',
    operators: MONEY,
    label,
    min,
    max: 1_000_000_000,
})

const int = (column: string, label: string, max = 100_000): SegmentFieldDescriptor => ({
    column,
    type: 'int',
    operators: NUMERIC,
    label,
    min: 0,
    max,
})

const days = (column: string, label: string): SegmentFieldDescriptor => ({
    column,
    type: 'days',
    operators: DAYS,
    label,
    min: 0,
    max: 3650,
})

const date = (column: string, label: string, recencyColumn?: string): SegmentFieldDescriptor => ({
    column,
    type: 'date',
    operators: DATE,
    label,
    ...(recencyColumn ? { recencyColumn } : {}),
})

/**
 * The whitelist. Keys are STABLE PUBLIC field names; `column` is the Prisma scalar
 * on PlayerMetrics. That indirection is the migration seam — a column can be
 * renamed without invalidating every saved segment.
 */
export const SEGMENT_FIELDS = {
    // Money
    lifetimeDeposits: money('lifetimeDeposits', 'Lifetime deposits (ETB)'),
    lifetimeWithdrawals: money('lifetimeWithdrawals', 'Lifetime withdrawals (ETB)'),
    totalStaked: money('totalStaked', 'Total staked (ETB)'),
    totalWon: money('totalWon', 'Total won (ETB)'),
    netLoss: { ...money('netLoss', 'Net loss (ETB)'), min: -1_000_000_000 },
    tpStaked: money('tpStaked', 'Casino staked (ETB)'),
    tpWon: money('tpWon', 'Casino won (ETB)'),
    bonusReceived: money('bonusReceived', 'Bonus received (ETB)'),
    realBalance: money('realBalance', 'Real balance (ETB)'),
    bonusBalance: money('bonusBalance', 'Bonus balance (ETB)'),

    // Counts
    depositCount: int('depositCount', 'Number of deposits'),
    withdrawalCount: int('withdrawalCount', 'Number of withdrawals'),
    gamesPlayed: int('gamesPlayed', 'Bingo games played', 1_000_000),
    cartelasBought: int('cartelasBought', 'Cartelas bought', 10_000_000),
    referralCount: int('referralCount', 'Players referred'),

    // Recency (precomputed integers — cheap to filter)
    daysSinceLastDeposit: days('daysSinceLastDeposit', 'Days since last deposit'),
    daysSinceLastPlay: days('daysSinceLastPlay', 'Days since last play'),
    tenureDays: days('tenureDays', 'Days since signup'),

    // Dates
    firstDepositAt: date('firstDepositAt', 'First deposit date'),
    lastDepositAt: date('lastDepositAt', 'Last deposit date', 'daysSinceLastDeposit'),
    lastWithdrawalAt: date('lastWithdrawalAt', 'Last withdrawal date'),
    firstPlayedAt: date('firstPlayedAt', 'First play date'),
    lastPlayedAt: date('lastPlayedAt', 'Last play date', 'daysSinceLastPlay'),
    lastTpPlayedAt: date('lastTpPlayedAt', 'Last casino play date'),
    registeredAt: date('registeredAt', 'Signup date', 'tenureDays'),

    // Presence
    hasPhone: { column: 'phone', type: 'presence', operators: PRESENCE, label: 'Has phone number' },
    hasTelegram: {
        column: 'telegramId',
        type: 'presence',
        operators: PRESENCE,
        label: 'Linked Telegram',
    },
} as const satisfies Record<string, SegmentFieldDescriptor>

export type SegmentField = keyof typeof SEGMENT_FIELDS

export const SEGMENT_FIELD_KEYS = Object.keys(SEGMENT_FIELDS) as [SegmentField, ...SegmentField[]]

/** Runtime lookup that narrows to the descriptor interface. */
export function segmentField(field: SegmentField): SegmentFieldDescriptor {
    return SEGMENT_FIELDS[field] as SegmentFieldDescriptor
}

// ─── AST ──────────────────────────────────────────────────────────────────────

const LeafShape = z.object({
    kind: z.literal('cond'),
    field: z.enum(SEGMENT_FIELD_KEYS),
    op: z.enum(SEGMENT_OPERATORS),
    value: z
        .union([
            z.number().finite(),
            z.string().datetime(),
            z.tuple([z.number().finite(), z.number().finite()]),
            z.tuple([z.string().datetime(), z.string().datetime()]),
        ])
        .optional(),
}).strict()

/**
 * Second-stage checks Zod's shape layer cannot express: operator must be allowed
 * for the field, arity must match, value type must match the field type, and a
 * `between` pair must be ordered. Issues carry a path so the builder can point at
 * the offending leaf.
 */
function validateLeafSemantics(
    leaf: z.infer<typeof LeafShape>,
    ctx: z.RefinementCtx,
    basePath: (string | number)[] = [],
): void {
    const at = (...rest: (string | number)[]) => [...basePath, ...rest]
    const descriptor = segmentField(leaf.field)

    if (!descriptor.operators.includes(leaf.op)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: at('op'),
            message: `Operator "${leaf.op}" is not valid for field "${leaf.field}"`,
        })
        return
    }

    const arity = OPERATOR_ARITY[leaf.op]

    if (arity === 0) {
        if (leaf.value !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: at('value'),
                message: `Operator "${leaf.op}" does not take a value`,
            })
        }
        return
    }

    if (leaf.value === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: at('value'),
            message: `Operator "${leaf.op}" requires a value`,
        })
        return
    }

    const isPair = Array.isArray(leaf.value)

    if (arity === 2 && !isPair) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: at('value'),
            message: `Operator "${leaf.op}" requires a [min, max] pair`,
        })
        return
    }
    if (arity === 1 && isPair) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: at('value'),
            message: `Operator "${leaf.op}" takes a single value, not a pair`,
        })
        return
    }

    // `in_last_days` / `not_in_last_days` are day counts even though the field is
    // a date — they compile to the companion integer column.
    const wantsNumber =
        descriptor.type === 'money' ||
        descriptor.type === 'int' ||
        descriptor.type === 'days' ||
        leaf.op === 'in_last_days' ||
        leaf.op === 'not_in_last_days'

    const values = (isPair ? leaf.value : [leaf.value]) as Array<number | string>

    for (const v of values) {
        if (wantsNumber && typeof v !== 'number') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: at('value'),
                message: `Field "${leaf.field}" with operator "${leaf.op}" expects a number`,
            })
            return
        }
        if (!wantsNumber && typeof v !== 'string') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: at('value'),
                message: `Field "${leaf.field}" expects an ISO-8601 date string`,
            })
            return
        }
        if (typeof v === 'number') {
            if (descriptor.min !== undefined && v < descriptor.min) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: at('value'),
                    message: `Value ${v} is below the minimum ${descriptor.min} for "${leaf.field}"`,
                })
                return
            }
            if (descriptor.max !== undefined && v > descriptor.max) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: at('value'),
                    message: `Value ${v} exceeds the maximum ${descriptor.max} for "${leaf.field}"`,
                })
                return
            }
        }
    }

    if (isPair) {
        const [lo, hi] = leaf.value as [number | string, number | string]
        if (lo > hi) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: at('value'),
                message: 'Range minimum must not be greater than its maximum',
            })
        }
    }
}

/**
 * Structural shape only. Semantic checks run in the tree walk below rather than
 * as a `.superRefine` here, because a refined schema is a ZodEffects and cannot
 * be a discriminated-union member — and a plain `z.union` collapses every branch
 * failure into a bare "Invalid input", which would leave the segment builder
 * unable to say WHICH row is wrong.
 */
export const SegmentLeafSchema = LeafShape

/**
 * No group-level `not` in v1.
 *
 * It compiles to Prisma's `NOT (…)`, and in SQL a row whose referenced column is
 * NULL evaluates to NULL inside the negation and is dropped. "Churned players NOT
 * recent depositors" would therefore silently exclude every player who never
 * deposited — exactly the cohort such a campaign is aimed at — while the
 * human-readable summary still reads like set complement. None of the eight
 * presets need it. If it ever ships, the NULL arm has to be compiled explicitly
 * and spelled out in the explain text.
 */
const groupOf = <T extends z.ZodTypeAny>(child: T) =>
    z.object({
        kind: z.literal('group'),
        op: z.enum(['AND', 'OR']),
        children: z.array(child).min(1).max(SEGMENT_MAX_CHILDREN),
    })
        // Strict: an unknown key is an error, not something to quietly drop. A rule
        // set carrying `not: true` must fail loudly rather than compile to its
        // own opposite.
        .strict()

// Depth is bounded BY CONSTRUCTION — a finite chain rather than z.lazy recursion.
// Discriminating on `kind` means an invalid leaf reports its own error ("Invalid
// enum value ... received 'passwordHash'") instead of the union's generic one.
const L3 = LeafShape
const L2 = z.discriminatedUnion('kind', [LeafShape, groupOf(L3)])
const L1 = z.discriminatedUnion('kind', [LeafShape, groupOf(L2)])

/** Applies leaf semantics to every leaf, tagging issues with its exact path. */
function walkLeaves(node: unknown, ctx: z.RefinementCtx, path: (string | number)[]): void {
    if (!node || typeof node !== 'object') return
    const n = node as { kind?: string; children?: unknown[] }

    if (n.kind === 'group') {
        ;(n.children ?? []).forEach((child, i) => walkLeaves(child, ctx, [...path, 'children', i]))
        return
    }
    if (n.kind === 'cond') {
        validateLeafSemantics(node as z.infer<typeof LeafShape>, ctx, path)
    }
}

/** Hand-written recursive types — the inferred nested-union type is unusable. */
export interface SegmentLeaf {
    kind: 'cond'
    field: SegmentField
    op: SegmentOperator
    value?: number | string | [number, number] | [string, string]
}

export interface SegmentGroup {
    kind: 'group'
    op: 'AND' | 'OR'
    children: SegmentNode[]
}

export type SegmentNode = SegmentLeaf | SegmentGroup

export interface SegmentRuleSet {
    version: typeof SEGMENT_RULESET_VERSION
    root: SegmentGroup
}

function countNodes(node: unknown): number {
    if (!node || typeof node !== 'object') return 0
    const n = node as { kind?: string; children?: unknown[] }
    if (n.kind === 'group') {
        return 1 + (n.children ?? []).reduce<number>((sum, c) => sum + countNodes(c), 0)
    }
    return 1
}

export const SegmentRuleSetSchema = z
    .object({
        version: z.literal(SEGMENT_RULESET_VERSION),
        root: groupOf(L1),
    })
    .superRefine((ruleSet, ctx) => {
        const total = countNodes(ruleSet.root)
        if (total > SEGMENT_MAX_NODES) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['root'],
                message: `Rule set has ${total} nodes, exceeding the maximum of ${SEGMENT_MAX_NODES}`,
            })
        }
        walkLeaves(ruleSet.root, ctx, ['root'])
    })

/** Parse unknown JSON (e.g. a `Segment.rules` column) into a validated rule set. */
export function parseSegmentRuleSet(input: unknown): SegmentRuleSet {
    return SegmentRuleSetSchema.parse(input) as SegmentRuleSet
}
