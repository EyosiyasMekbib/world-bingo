/**
 * The cash agent network.
 *
 * An agent is a shop holding PREPAID float. The operator takes cash from the
 * agent up front and issues float against it, plus a commission bonus on top
 * which is the agent's margin: they sell that float on to players who hand cash
 * across the counter. Cash itself never touches the platform - the only thing
 * that crosses is the player's six-digit deposit code.
 *
 * Because the float is prepaid, the operator's exposure is bounded by whatever
 * is already in the agents' balances, and the whole design rests on one rule:
 * float NEVER goes below zero. That rule is enforced three deep - a
 * SELECT ... FOR UPDATE on the agent row before every read-then-write, an
 * explicit refusal in application code, and a raw CHECK (float >= 0) on the
 * table as the last-resort backstop (see the add_agent_network migration). It is
 * the same shape platform rule #1 uses for player wallets.
 *
 * This file owns agents and their float. The player-facing deposit codes and the
 * fulfilment transaction live in agent-deposit.service.ts.
 */

import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { AccountStatus, UserRole } from '@world-bingo/shared-types'
import prisma from '../lib/prisma'

const DAY_MS = 24 * 60 * 60 * 1000

/** Money is stored as Decimal(12,2) everywhere; every figure crossing this boundary matches. */
const MONEY_DP = 2

/** How many ledger rows `getAgent` attaches to the detail view. */
const AGENT_DETAIL_LEDGER_ROWS = 50

// ─── Errors ──────────────────────────────────────────────────────────────────

export class AgentNotFoundError extends Error {
    readonly statusCode = 404
    readonly code = 'agent_not_found'
    constructor(readonly agentId?: string) {
        super('Agent not found')
        this.name = 'AgentNotFoundError'
    }
}

/**
 * A float movement refused because the agent does not hold enough.
 *
 * `float` and `required` are 2dp decimal STRINGS, never numbers: the counter
 * screen prints them straight back at the operator, and a float round trip on
 * the way out would be the one place in this feature where money stopped being
 * exact.
 */
export class InsufficientFloatError extends Error {
    readonly statusCode = 422
    readonly code = 'insufficient_float'
    readonly float: string
    readonly required: string
    constructor(float: Decimal | string | number, required: Decimal | string | number) {
        const have = money(float)
        const need = money(required)
        super(`Insufficient float: ${have} available, ${need} required`)
        this.name = 'InsufficientFloatError'
        this.float = have
        this.required = need
    }
}

export class UsernameTakenError extends Error {
    readonly statusCode = 409
    readonly code = 'username_taken'
    constructor(readonly username?: string) {
        super('Username already taken')
        this.name = 'UsernameTakenError'
    }
}

// ─── Money helpers ───────────────────────────────────────────────────────────

/**
 * Build a Decimal from whatever the route handed us. Amounts arrive as decimal
 * STRINGS wherever the caller can manage it (the admin and wallet routes both
 * pass the caller's own digits through untouched) so the value is never routed
 * through a binary float on the way in. Returns null for anything that is not a
 * finite number, which callers turn into their own typed refusal.
 */
export function toDecimal(value: Decimal | string | number | null | undefined): Decimal | null {
    if (value === null || value === undefined || value === '') return null
    try {
        const d = value instanceof Decimal ? value : new Decimal(typeof value === 'number' ? String(value) : String(value).trim())
        return d.isFinite() ? d : null
    } catch {
        return null
    }
}

/** A money value as the fixed 2dp string this service hands back. */
export function money(value: Decimal | string | number | null | undefined): string {
    const d = toDecimal(value)
    return (d ?? new Decimal(0)).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP).toFixed(MONEY_DP)
}

/** Rounded to the scale the column actually stores, so validation and storage agree. */
export function toMoneyDecimal(value: Decimal | string | number | null | undefined): Decimal | null {
    const d = toDecimal(value)
    return d === null ? null : d.toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP)
}

/** True for a Postgres unique-constraint violation, including the partial indexes Prisma cannot see. */
export function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

/**
 * Midnight UTC of `now`'s day. Day boundaries in this codebase are anchored to
 * UTC (see the cashback period helper), not to the server's local zone, so a
 * deployment moving between regions cannot silently reshape "today".
 */
function startOfUtcDay(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** SiteSetting keys this service owns. Absent rows fall back to the defaults below. */
export const AGENT_SETTING_KEYS = {
    commissionRate: 'agent_commission_rate',
    depositMin: 'agent_deposit_min',
    depositMax: 'agent_deposit_max',
    codeTtlSeconds: 'agent_code_ttl_seconds',
} as const

const AGENT_SETTING_DEFAULTS = {
    commissionRate: '5',
    depositMin: '50',
    depositMax: '5000',
    codeTtlSeconds: '900',
} as const

export interface AgentSettings {
    /** Percent of the cash received, issued as extra float on a top-up. 5 means 5%. */
    commissionRate: number
    /** Decimal strings: the player deposit limits a code may be created for. */
    depositMin: string
    depositMax: string
    /** How long a freshly issued deposit code stays live. */
    codeTtlSeconds: number
}

export type AgentSettingsInput = Partial<{
    commissionRate: number | string
    depositMin: number | string
    depositMax: number | string
    codeTtlSeconds: number | string
}>

// ─── Service ─────────────────────────────────────────────────────────────────

export class AgentService {
    // ── Settings ─────────────────────────────────────────────────────────────

    static async getSettings(): Promise<AgentSettings> {
        const keys = Object.values(AGENT_SETTING_KEYS)
        const rows = await prisma.siteSetting.findMany({ where: { key: { in: [...keys] } } })
        const byKey = new Map(rows.map((r) => [r.key, r.value]))

        // Every read falls back to the default when the row is absent, blank, or
        // unparseable. A malformed row must not be able to take the deposit form
        // down, and it must never widen a limit by accident.
        const rate = Number(byKey.get(AGENT_SETTING_KEYS.commissionRate) ?? AGENT_SETTING_DEFAULTS.commissionRate)
        const ttl = Number(byKey.get(AGENT_SETTING_KEYS.codeTtlSeconds) ?? AGENT_SETTING_DEFAULTS.codeTtlSeconds)
        const min = toMoneyDecimal(byKey.get(AGENT_SETTING_KEYS.depositMin) ?? AGENT_SETTING_DEFAULTS.depositMin)
        const max = toMoneyDecimal(byKey.get(AGENT_SETTING_KEYS.depositMax) ?? AGENT_SETTING_DEFAULTS.depositMax)

        return {
            commissionRate: Number.isFinite(rate) && rate >= 0 ? rate : Number(AGENT_SETTING_DEFAULTS.commissionRate),
            depositMin: money(min ?? AGENT_SETTING_DEFAULTS.depositMin),
            depositMax: money(max ?? AGENT_SETTING_DEFAULTS.depositMax),
            codeTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : Number(AGENT_SETTING_DEFAULTS.codeTtlSeconds),
        }
    }

    /**
     * Write whichever of the four settings the caller supplied and answer with the
     * full, re-read set. Audited, because these numbers decide how much float the
     * operator gives away per top-up and how large a single counter deposit can be.
     */
    static async updateSettings(input: AgentSettingsInput, actorId?: string): Promise<AgentSettings> {
        const writes: Array<{ key: string; value: string }> = []
        if (input.commissionRate !== undefined) {
            const rate = Number(input.commissionRate)
            if (!Number.isFinite(rate) || rate < 0) throw Object.assign(new Error('Commission rate must be a non-negative number'), { statusCode: 400 })
            writes.push({ key: AGENT_SETTING_KEYS.commissionRate, value: String(rate) })
        }
        if (input.depositMin !== undefined) {
            const min = toMoneyDecimal(input.depositMin)
            if (min === null || min.lessThan(0)) throw Object.assign(new Error('Minimum deposit must be a non-negative amount'), { statusCode: 400 })
            writes.push({ key: AGENT_SETTING_KEYS.depositMin, value: min.toFixed(MONEY_DP) })
        }
        if (input.depositMax !== undefined) {
            const max = toMoneyDecimal(input.depositMax)
            if (max === null || max.lessThanOrEqualTo(0)) throw Object.assign(new Error('Maximum deposit must be a positive amount'), { statusCode: 400 })
            writes.push({ key: AGENT_SETTING_KEYS.depositMax, value: max.toFixed(MONEY_DP) })
        }
        if (input.codeTtlSeconds !== undefined) {
            const ttl = Number(input.codeTtlSeconds)
            if (!Number.isFinite(ttl) || ttl <= 0) throw Object.assign(new Error('Code lifetime must be a positive number of seconds'), { statusCode: 400 })
            writes.push({ key: AGENT_SETTING_KEYS.codeTtlSeconds, value: String(Math.floor(ttl)) })
        }

        await prisma.$transaction(async (tx) => {
            for (const w of writes) {
                await tx.siteSetting.upsert({ where: { key: w.key }, update: { value: w.value }, create: w })
            }
            if (writes.length > 0) {
                await tx.auditLog.create({
                    data: {
                        action: 'agent.settings_updated',
                        actorId: actorId ?? null,
                        target: 'agent:settings',
                        detail: Object.fromEntries(writes.map((w) => [w.key, w.value])),
                    },
                })
            }
        })

        return AgentService.getSettings()
    }

    // ── Roster ───────────────────────────────────────────────────────────────

    /**
     * The admin roster: every agent, plus the network-level numbers the float desk
     * works from.
     *
     * `floatOutstanding` is the operator's live exposure - float already issued and
     * not yet sold on - so it is the one number on this screen that has to be a sum
     * over every agent, not a sampled or paged figure.
     */
    static async listAgents() {
        const now = new Date()
        const since7d = new Date(now.getTime() - 7 * DAY_MS)
        const since30d = new Date(now.getTime() - 30 * DAY_MS)
        const startOfToday = startOfUtcDay(now)

        const [agents, fulfilled7d, lastTopUps, todayFulfilled, commission30d] = await Promise.all([
            prisma.agent.findMany({
                orderBy: { createdAt: 'desc' },
                include: { user: { select: { username: true, accountStatus: true } } },
            }),
            prisma.agentDepositRequest.groupBy({
                by: ['agentId'],
                where: { status: 'FULFILLED', fulfilledAt: { gte: since7d } },
                _sum: { amount: true },
                _count: { _all: true },
            }),
            prisma.agentLedger.groupBy({
                by: ['agentId'],
                where: { type: 'TOP_UP' },
                _max: { createdAt: true },
            }),
            prisma.agentDepositRequest.aggregate({
                where: { status: 'FULFILLED', fulfilledAt: { gte: startOfToday } },
                _sum: { amount: true },
                _count: { _all: true },
            }),
            prisma.agentLedger.aggregate({
                where: { type: 'COMMISSION', createdAt: { gte: since30d } },
                _sum: { amount: true },
            }),
        ])

        const fulfilledByAgent = new Map(fulfilled7d.map((r) => [r.agentId, r]))
        const lastTopUpByAgent = new Map(lastTopUps.map((r) => [r.agentId, r._max.createdAt]))

        const floatOutstanding = agents.reduce((sum, a) => sum.plus(new Decimal(a.float)), new Decimal(0))

        return {
            agents: agents.map((a) => {
                const f = fulfilledByAgent.get(a.id)
                return {
                    id: a.id,
                    userId: a.userId,
                    username: a.user?.username ?? null,
                    shopName: a.shopName,
                    float: money(a.float),
                    accountStatus: a.user?.accountStatus ?? null,
                    /** Seven-day fulfilled VOLUME, not a count. The count is fulfilled7dCount. */
                    fulfilled7d: money(f?._sum.amount ?? 0),
                    fulfilled7dCount: f?._count._all ?? 0,
                    lastTopUpAt: lastTopUpByAgent.get(a.id) ?? null,
                    createdAt: a.createdAt,
                }
            }),
            summary: {
                floatOutstanding: money(floatOutstanding),
                activeCount: agents.filter((a) => a.user?.accountStatus === AccountStatus.ACTIVE).length,
                totalCount: agents.length,
                fulfilledTodayVolume: money(todayFulfilled._sum.amount ?? 0),
                fulfilledTodayCount: todayFulfilled._count._all,
                commission30d: money(commission30d._sum.amount ?? 0),
            },
        }
    }

    /**
     * Create the agent's login and their agent record in one transaction.
     *
     * The username pre-check mirrors the clerk-creation route in
     * routes/admin/index.ts; the P2002 catch behind it is what actually closes the
     * race between two operators onboarding the same shop at once.
     */
    static async createAgent(input: { username: string; password: string; shopName: string }) {
        const username = input.username.trim()
        const shopName = input.shopName.trim()

        const existing = await prisma.user.findFirst({ where: { username } })
        if (existing) throw new UsernameTakenError(username)

        const passwordHash = await bcrypt.hash(input.password, 10)

        try {
            return await prisma.$transaction(async (tx) => {
                // accountStatus defaults to ACTIVE; suspending an agent goes through
                // AccountStatusService like every other account, so there is exactly
                // one audited notion of "switched off".
                const user = await tx.user.create({
                    data: { username, passwordHash, role: UserRole.AGENT },
                })
                return tx.agent.create({
                    data: { userId: user.id, shopName },
                    include: { user: { select: { id: true, username: true, role: true, accountStatus: true } } },
                })
            })
        } catch (err) {
            if (isUniqueViolation(err)) throw new UsernameTakenError(username)
            throw err
        }
    }

    static async getAgentByUserId(userId: string) {
        return prisma.agent.findUnique({
            where: { userId },
            include: { user: { select: { id: true, username: true, firstName: true, lastName: true, accountStatus: true } } },
        })
    }

    /**
     * Admin detail view. `sold30d` is the float this shop sold on to players in the
     * window (the fulfilment volume); `commission30d` is what the operator paid them
     * for doing it.
     */
    static async getAgent(agentId: string) {
        const agent = await prisma.agent.findUnique({
            where: { id: agentId },
            include: {
                user: {
                    select: { id: true, username: true, firstName: true, lastName: true, accountStatus: true, createdAt: true },
                },
            },
        })
        if (!agent) throw new AgentNotFoundError(agentId)

        const since30d = new Date(Date.now() - 30 * DAY_MS)
        const [sold, commission, ledger] = await Promise.all([
            prisma.agentDepositRequest.aggregate({
                where: { agentId, status: 'FULFILLED', fulfilledAt: { gte: since30d } },
                _sum: { amount: true },
                _count: { _all: true },
            }),
            prisma.agentLedger.aggregate({
                where: { agentId, type: 'COMMISSION', createdAt: { gte: since30d } },
                _sum: { amount: true },
            }),
            prisma.agentLedger.findMany({
                where: { agentId },
                orderBy: { createdAt: 'desc' },
                take: AGENT_DETAIL_LEDGER_ROWS,
            }),
        ])

        return {
            agent,
            stats: {
                sold30d: money(sold._sum.amount ?? 0),
                commission30d: money(commission._sum.amount ?? 0),
                fulfilledCount30d: sold._count._all,
            },
            ledger,
        }
    }

    static async updateAgent(agentId: string, input: { shopName: string }) {
        const existing = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } })
        if (!existing) throw new AgentNotFoundError(agentId)
        return prisma.agent.update({
            where: { id: agentId },
            data: { shopName: input.shopName.trim() },
            include: { user: { select: { id: true, username: true, accountStatus: true } } },
        })
    }

    // ── Float ────────────────────────────────────────────────────────────────

    /**
     * Issue float against cash the operator has already taken, or claw it back.
     *
     * `cashReceived` is always a POSITIVE magnitude; `direction` decides the sign.
     * CREDIT writes a TOP_UP row for the cash and, when there is any, a second
     * COMMISSION row for the margin on top - two rows rather than one net figure,
     * because the operator's books need the commission separable from the cash.
     *
     * When `commissionAmount` is omitted it is computed from `agent_commission_rate`.
     * When it is supplied it is used VERBATIM, including zero: an operator striking a
     * one-off deal with a shop must be able to override the standing rate, and a
     * recomputation behind their back would quietly overwrite the number they agreed.
     *
     * DEBIT writes a single negative ADJUSTMENT. It is the deliberate correction
     * path - there is no automatic reversal anywhere in this system - and a debit
     * that would take the float below zero is REFUSED, never clamped. Clamping would
     * silently forgive the difference and leave the ledger disagreeing with the cash
     * that actually changed hands.
     */
    static async adjustFloat(input: {
        agentId: string
        direction: 'CREDIT' | 'DEBIT'
        cashReceived: Decimal | string | number
        commissionAmount?: Decimal | string | number
        note?: string
        actorId: string
        actorName?: string
    }) {
        const cash = toMoneyDecimal(input.cashReceived)
        if (cash === null || cash.lessThanOrEqualTo(0)) {
            throw Object.assign(new Error('Cash received must be a positive amount'), { statusCode: 400 })
        }

        let commission = new Decimal(0)
        if (input.direction === 'CREDIT') {
            if (input.commissionAmount !== undefined) {
                const supplied = toMoneyDecimal(input.commissionAmount)
                if (supplied === null || supplied.lessThan(0)) {
                    throw Object.assign(new Error('Commission must be a non-negative amount'), { statusCode: 400 })
                }
                commission = supplied
            } else {
                const { commissionRate } = await AgentService.getSettings()
                // Decimal throughout: rate is a percent, so cash * rate / 100.
                commission = cash
                    .mul(new Decimal(String(commissionRate)))
                    .div(100)
                    .toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP)
            }
        }

        return prisma.$transaction(async (tx) => {
            // Lock the agent row before reading the float, exactly as the wallet
            // paths lock a wallet row: without it two concurrent adjustments both
            // read the same balanceBefore and one overwrites the other's balanceAfter.
            const rows = await tx.$queryRaw<Array<{ id: string; float: Decimal }>>`
                SELECT id, "float" FROM agents WHERE id = ${input.agentId} FOR UPDATE
            `
            const locked = rows[0]
            if (!locked) throw new AgentNotFoundError(input.agentId)

            const floatBefore = new Decimal(locked.float)
            const entries: Array<Awaited<ReturnType<typeof tx.agentLedger.create>>> = []
            let running = floatBefore

            if (input.direction === 'CREDIT') {
                const afterCash = running.plus(cash)
                entries.push(
                    await tx.agentLedger.create({
                        data: {
                            agentId: input.agentId,
                            type: 'TOP_UP',
                            amount: cash,
                            balanceBefore: running,
                            balanceAfter: afterCash,
                            actorId: input.actorId,
                            note: input.note ?? null,
                        },
                    }),
                )
                running = afterCash

                if (!commission.isZero()) {
                    const afterCommission = running.plus(commission)
                    entries.push(
                        await tx.agentLedger.create({
                            data: {
                                agentId: input.agentId,
                                type: 'COMMISSION',
                                amount: commission,
                                balanceBefore: running,
                                balanceAfter: afterCommission,
                                actorId: input.actorId,
                                note: input.note ?? null,
                            },
                        }),
                    )
                    running = afterCommission
                }
            } else {
                const afterDebit = running.minus(cash)
                // Refused, not clamped. The CHECK (float >= 0) on the table would
                // catch this too, but a constraint violation is an opaque 500; the
                // operator needs to be told what the shop actually holds.
                if (afterDebit.lessThan(0)) {
                    throw new InsufficientFloatError(running, cash)
                }
                entries.push(
                    await tx.agentLedger.create({
                        data: {
                            agentId: input.agentId,
                            type: 'ADJUSTMENT',
                            amount: cash.negated(),
                            balanceBefore: running,
                            balanceAfter: afterDebit,
                            actorId: input.actorId,
                            note: input.note ?? null,
                        },
                    }),
                )
                running = afterDebit
            }

            await tx.agent.update({ where: { id: input.agentId }, data: { float: running } })

            await tx.auditLog.create({
                data: {
                    action: input.direction === 'CREDIT' ? 'agent.float_credit' : 'agent.float_debit',
                    actorId: input.actorId,
                    actorName: input.actorName ?? null,
                    target: `agent:${input.agentId}`,
                    detail: {
                        direction: input.direction,
                        cashReceived: cash.toFixed(MONEY_DP),
                        commissionAmount: commission.toFixed(MONEY_DP),
                        floatBefore: floatBefore.toFixed(MONEY_DP),
                        floatAfter: running.toFixed(MONEY_DP),
                        note: input.note ?? null,
                    },
                },
            })

            return { floatAfter: money(running), entries }
        })
    }

    /**
     * One agent's float history, filtered and paged.
     *
     * The summary is deliberately NOT scoped by the caller's filters: it is the
     * seven-day context strip above the table, and it has to stay put while the
     * operator pages and filters underneath it.
     */
    static async getLedger(
        agentId: string,
        opts: { from?: Date; to?: Date; type?: 'TOP_UP' | 'COMMISSION' | 'FULFILLMENT' | 'ADJUSTMENT'; page?: number; pageSize?: number } = {},
    ) {
        const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true, float: true } })
        if (!agent) throw new AgentNotFoundError(agentId)

        const page = Math.max(opts.page ?? 1, 1)
        const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200)
        const since7d = new Date(Date.now() - 7 * DAY_MS)

        const where: Prisma.AgentLedgerWhereInput = {
            agentId,
            ...(opts.type ? { type: opts.type } : {}),
            ...(opts.from || opts.to
                ? { createdAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
                : {}),
        }

        const [rows, total, fulfilled, toppedUp] = await Promise.all([
            prisma.agentLedger.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            prisma.agentLedger.count({ where }),
            prisma.agentLedger.aggregate({
                where: { agentId, type: 'FULFILLMENT', createdAt: { gte: since7d } },
                _sum: { amount: true },
                _count: { _all: true },
            }),
            // TOP_UP and COMMISSION together: both are float that arrived at the
            // shop on a top-up, and the agent reads this as "what I was issued".
            prisma.agentLedger.aggregate({
                where: { agentId, type: { in: ['TOP_UP', 'COMMISSION'] }, createdAt: { gte: since7d } },
                _sum: { amount: true },
            }),
        ])

        return {
            rows,
            total,
            summary: {
                /** Seven-day fulfilled VOLUME. FULFILLMENT rows are negative, so negate the sum. */
                fulfilled7d: money(new Decimal(fulfilled._sum.amount ?? 0).negated()),
                /** Integer COUNT of fulfilments in the same window. */
                deposits7d: fulfilled._count._all,
                toppedUp7d: money(toppedUp._sum.amount ?? 0),
                float: money(agent.float),
            },
        }
    }

    /**
     * What the agent's own counter screen opens on. Keyed on the USER id, because
     * that is what the agent's token carries.
     */
    static async getDashboard(agentUserId: string) {
        const agent = await AgentService.getAgentByUserId(agentUserId)
        if (!agent) throw new AgentNotFoundError()

        const startOfToday = startOfUtcDay(new Date())
        const [today, settings] = await Promise.all([
            prisma.agentDepositRequest.aggregate({
                where: { agentId: agent.id, status: 'FULFILLED', fulfilledAt: { gte: startOfToday } },
                _sum: { amount: true },
                _count: { _all: true },
            }),
            AgentService.getSettings(),
        ])

        const displayName =
            [agent.user?.firstName, agent.user?.lastName].filter(Boolean).join(' ').trim() ||
            agent.user?.username ||
            agent.shopName

        return {
            id: agent.id,
            shopName: agent.shopName,
            displayName,
            float: money(agent.float),
            today: {
                count: today._count._all,
                volume: money(today._sum.amount ?? 0),
            },
            limits: {
                min: settings.depositMin,
                max: settings.depositMax,
            },
        }
    }
}
