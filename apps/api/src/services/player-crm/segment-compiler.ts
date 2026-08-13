import type { Prisma } from '@prisma/client'
import {
    OPERATOR_ARITY,
    SegmentRuleSetSchema,
    segmentField,
} from '@world-bingo/shared-types'
import type {
    SegmentGroup,
    SegmentLeaf,
    SegmentNode,
    SegmentOperator,
    SegmentRuleSet,
} from '@world-bingo/shared-types'

/**
 * Compiles a segment rule AST into a Prisma `where` clause on PlayerMetrics.
 *
 * PURE — no I/O, no prisma client import, no clock read unless you pass one. That
 * is deliberate: this is the security boundary of the CRM (every AST comes from an
 * admin form), and a pure function can be exhaustively tested without a database,
 * which matters given how unreliable the DB-backed suites are here.
 *
 * The safety property: a user-supplied string NEVER becomes a SQL identifier or an
 * operator. Field keys are looked up in a frozen whitelist and mapped to column
 * names this module owns; operators are looked up in a closed switch. Anything
 * unrecognised throws instead of being passed through. Values stay values — Prisma
 * parameterises them.
 */

export class SegmentCompileError extends Error {
    readonly issues: string[]

    constructor(message: string, issues: string[] = []) {
        super(message)
        this.name = 'SegmentCompileError'
        this.issues = issues
    }
}

export interface CompileOptions {
    /** Injected so relative-date compilation stays deterministic under test. */
    now?: Date
}

type Where = Prisma.PlayerMetricsWhereInput

const DAY_MS = 24 * 60 * 60 * 1000

function daysAgo(now: Date, days: number): Date {
    return new Date(now.getTime() - days * DAY_MS)
}

/** Numeric/date comparison operators that map 1:1 onto Prisma filter keys. */
const DIRECT_FILTER: Partial<Record<SegmentOperator, 'gt' | 'gte' | 'lt' | 'lte'>> = {
    gt: 'gt',
    gte: 'gte',
    lt: 'lt',
    lte: 'lte',
}

function compileLeaf(leaf: SegmentLeaf, now: Date): Where {
    const descriptor = segmentField(leaf.field)
    const column = descriptor.column
    const { op } = leaf

    // Presence checks work identically for every nullable column.
    if (op === 'is_null') return { [column]: null } as Where
    if (op === 'is_not_null') return { [column]: { not: null } } as Where

    const arity = OPERATOR_ARITY[op]
    if (arity > 0 && leaf.value === undefined) {
        throw new SegmentCompileError(`Operator "${op}" on "${leaf.field}" requires a value`)
    }

    // Relative-date questions compile against the TIMESTAMP column, never the
    // stored daysSince* integer.
    //
    // Those integers are only recomputed when a player's row is refreshed, and the
    // incremental pass only refreshes players who did something. A player who goes
    // quiet does nothing by definition — so their daysSinceLastPlay freezes at the
    // value it had when they were last active, and only the nightly full rebuild
    // corrects it. Churn is the primary use case here, so anchoring it to a number
    // that stops moving precisely when the player churns is exactly backwards.
    //
    // Comparing lastPlayedAt against a cutoff is always correct and costs nothing:
    // both columns are indexed, so either way it is an index scan.
    if (op === 'in_last_days' || op === 'not_in_last_days') {
        const days = leaf.value as number
        const cutoff = daysAgo(now, days)
        return op === 'in_last_days'
            ? ({ [column]: { gte: cutoff } } as Where)
            : // `not: null` is explicit: "more than N days ago" means they DID it,
              // just not recently. Never-played is reached with is_null, so the two
              // populations stay separable.
              ({ [column]: { lt: cutoff, not: null } } as Where)
    }

    const isDate = descriptor.type === 'date'
    const coerce = (v: number | string) => (isDate ? new Date(v as string) : v)

    if (op === 'between') {
        const [lo, hi] = leaf.value as [number, number] | [string, string]
        return { [column]: { gte: coerce(lo), lte: coerce(hi) } } as Where
    }

    if (op === 'eq') return { [column]: { equals: coerce(leaf.value as number | string) } } as Where
    if (op === 'neq') return { [column]: { not: coerce(leaf.value as number | string) } } as Where

    // `before`/`after` are the date spellings of lt/gt.
    if (op === 'before') return { [column]: { lt: coerce(leaf.value as string) } } as Where
    if (op === 'after') return { [column]: { gt: coerce(leaf.value as string) } } as Where

    const filter = DIRECT_FILTER[op]
    if (!filter) {
        // Unreachable via a validated AST — present so an operator added to the
        // shared enum without a compiler branch fails loudly instead of silently
        // matching every row.
        throw new SegmentCompileError(`Operator "${op}" has no compiler mapping`)
    }

    return { [column]: { [filter]: coerce(leaf.value as number | string) } } as Where
}

function compileNode(node: SegmentNode, now: Date): Where {
    return node.kind === 'group' ? compileGroup(node, now) : compileLeaf(node, now)
}

function compileGroup(group: SegmentGroup, now: Date): Where {
    if (!group.children.length) {
        // An empty group would compile to a clause matching EVERY player — the
        // worst possible failure mode for a campaign. Zod rejects this first;
        // this is the belt-and-braces.
        throw new SegmentCompileError('A rule group must contain at least one condition')
    }

    const compiled = group.children.map((child) => compileNode(child, now))

    // No NOT branch by design — see the groupOf() comment in shared-types.
    return group.op === 'AND' ? { AND: compiled } : { OR: compiled }
}

/**
 * Validate then compile. Always call this rather than the internals — validation
 * is what guarantees the field/operator whitelist has been applied.
 *
 * @throws SegmentCompileError on any invalid rule set (map to HTTP 400).
 */
export function compileSegment(ruleSet: SegmentRuleSet, options: CompileOptions = {}): Where {
    const parsed = SegmentRuleSetSchema.safeParse(ruleSet)

    if (!parsed.success) {
        const issues = parsed.error.issues.map(
            (i) => `${i.path.join('.') || 'root'}: ${i.message}`,
        )
        throw new SegmentCompileError(`Invalid segment rules: ${issues[0] ?? 'unknown error'}`, issues)
    }

    return compileGroup(parsed.data.root as SegmentGroup, options.now ?? new Date())
}

/**
 * Human-readable rendering of a rule set, for campaign confirmation screens and
 * audit records. Deliberately built from the same whitelist as the compiler so a
 * campaign can never display one thing and target another.
 */
export function explainSegment(ruleSet: SegmentRuleSet): string {
    const parsed = SegmentRuleSetSchema.safeParse(ruleSet)
    if (!parsed.success) return 'Invalid segment rules'

    const renderLeaf = (leaf: SegmentLeaf): string => {
        const { label } = segmentField(leaf.field)
        const v = Array.isArray(leaf.value) ? `${leaf.value[0]} and ${leaf.value[1]}` : leaf.value
        switch (leaf.op) {
            case 'is_null':
                return `${label} is not set`
            case 'is_not_null':
                return `${label} is set`
            case 'between':
                return `${label} is between ${v}`
            case 'in_last_days':
                return `${label} within the last ${v} days`
            case 'not_in_last_days':
                return `${label} more than ${v} days ago`
            case 'eq':
                return `${label} is ${v}`
            case 'neq':
                return `${label} is not ${v}`
            case 'gt':
                return `${label} is more than ${v}`
            case 'gte':
                return `${label} is at least ${v}`
            case 'lt':
                return `${label} is less than ${v}`
            case 'lte':
                return `${label} is at most ${v}`
            case 'before':
                return `${label} is before ${v}`
            case 'after':
                return `${label} is after ${v}`
        }
    }

    const renderNode = (node: SegmentNode): string =>
        node.kind === 'group' ? renderGroup(node) : renderLeaf(node)

    const renderGroup = (group: SegmentGroup): string => {
        const joiner = group.op === 'AND' ? ' AND ' : ' OR '
        const body = group.children.map(renderNode).join(joiner)
        return group.children.length > 1 ? `(${body})` : body
    }

    return renderGroup(parsed.data.root as SegmentGroup)
}
