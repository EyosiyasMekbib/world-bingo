/**
 * Cash-agent deposits: the six-digit code, and the fulfilment that settles it.
 *
 * A player names an amount and gets a code. They hand cash to an agent, who
 * types the code in and confirms. That confirmation is a single commit which
 * debits the agent's prepaid float and credits the player's wallet - if either
 * half fails, neither happens, which is the only reason it is safe to let the
 * cash and the credit happen in different places.
 *
 * The code is a BEARER TOKEN FOR CASH: whoever reads it out at a counter gets
 * the credit. So it is generated with `crypto.randomInt` rather than
 * `Math.random`, it is short-lived, a player holds at most one at a time, and
 * the routes rate-limit both the lookup and the fulfil so the six-digit space
 * cannot be swept.
 *
 * Agents and their float live in agent.service.ts.
 */

import { randomInt } from 'crypto'
import { Decimal } from '@prisma/client/runtime/library'
import { AccountStatus, PaymentStatus, TransactionType } from '@world-bingo/shared-types'
import prisma from '../lib/prisma'
import {
    AgentNotFoundError,
    AgentService,
    InsufficientFloatError,
    isUniqueViolation,
    money,
    toMoneyDecimal,
} from './agent.service'
import { WalletService } from './wallet.service'

/** Read aloud at a counter, so: short, all digits, no ambiguous characters. */
const CODE_LENGTH = 6
const CODE_SPACE = 10 ** CODE_LENGTH

/**
 * How many times a create retries after a unique violation.
 *
 * Two different indexes can raise it. A `code` collision is a genuine (rare)
 * clash against another live code and a fresh draw fixes it. A `userId`
 * collision means a concurrent create for the same player won the race, and the
 * retry re-runs the cancel step and supersedes it. Bounded so a persistent
 * constraint problem surfaces as an error instead of spinning.
 */
const CREATE_RETRIES = 5

/**
 * Bounds on the fulfilment transaction. The LOSER of a race between two agents
 * blocks on the request row lock for the whole of the winner's transaction, and
 * that transaction does real work (the paying-account advisory locks and the
 * bonus evaluation inside WalletService), so the default 5s is tighter than it
 * looks. Explicit and generous: a timeout here rolls the whole thing back, which
 * is safe but leaves an agent holding cash with nothing credited.
 */
const FULFILL_TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 }

// ─── Errors ──────────────────────────────────────────────────────────────────

export class RequestNotFoundError extends Error {
    readonly statusCode = 404
    readonly code = 'request_not_found'
    constructor() {
        super('No deposit request found for that code')
        this.name = 'RequestNotFoundError'
    }
}

export class RequestAlreadyFulfilledError extends Error {
    readonly statusCode = 409
    readonly code = 'request_already_fulfilled'
    constructor(readonly fulfilledAt: Date | null) {
        super('That code has already been fulfilled')
        this.name = 'RequestAlreadyFulfilledError'
    }
}

export class RequestExpiredError extends Error {
    readonly statusCode = 410
    readonly code = 'request_expired'
    constructor(readonly expiredAt: Date) {
        super('That code has expired')
        this.name = 'RequestExpiredError'
    }
}

export class AmountOutOfRangeError extends Error {
    readonly statusCode = 400
    readonly code = 'amount_out_of_range'
    constructor(readonly min: string, readonly max: string) {
        super(`Amount must be between ${min} and ${max}`)
        this.name = 'AmountOutOfRangeError'
    }
}

export class AgentSuspendedError extends Error {
    readonly statusCode = 403
    readonly code = 'agent_suspended'
    constructor() {
        super('This agent account is not active')
        this.name = 'AgentSuspendedError'
    }
}

// Re-exported so a caller handling the fulfilment path can import every refusal
// it can produce from one module; the canonical definitions stay in agent.service.
export { AgentNotFoundError, InsufficientFloatError } from './agent.service'

// ─── Masking ─────────────────────────────────────────────────────────────────

/**
 * `Kebede Mekonnen` -> `K••••• M.`
 *
 * Enough for an agent to check they are talking to the right person, and not
 * enough to identify a player from a code alone. Never returns the raw name.
 */
function maskName(user: { firstName?: string | null; lastName?: string | null; username?: string | null } | null): string {
    if (!user) return 'Player'
    const first = (user.firstName ?? '').trim()
    const last = (user.lastName ?? '').trim()
    const lead = first || (user.username ?? '').trim()
    if (!lead) return 'Player'
    // At least one bullet even for a one-character name, so the mask never
    // collapses to a bare initial.
    const masked = lead[0].toUpperCase() + '•'.repeat(Math.max(lead.length - 1, 1))
    return last ? `${masked} ${last[0].toUpperCase()}.` : masked
}

/**
 * `+251912345284` -> `+251 9•• ••• 284`
 *
 * Shows the country code, the leading digit of the subscriber number and the
 * last three, which is what a player can confirm out loud without the agent
 * learning a number they could reuse. Null when there is no phone, or too few
 * digits to mask meaningfully - showing a short number nearly unmasked would be
 * worse than showing nothing.
 */
function maskPhone(phone: string | null | undefined): string | null {
    if (!phone) return null
    const digits = phone.replace(/\D/g, '')
    if (digits.length < 9) return null
    const local = digits.slice(-9)
    const country = digits.slice(0, -9).replace(/^0+/, '') || '251'
    return `+${country} ${local[0]}•• ••• ${local.slice(-3)}`
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A fresh six-digit code.
 *
 * `crypto.randomInt`, never `Math.random`: this value is a bearer token for
 * cash, and Math.random's state is recoverable from a handful of outputs - which
 * an attacker can collect simply by asking for codes on their own account.
 */
function newCode(): string {
    return String(randomInt(0, CODE_SPACE)).padStart(CODE_LENGTH, '0')
}

interface RequestRow {
    id: string
    code: string
    userId: string
    amount: Decimal
    status: string
    expiresAt: Date
    fulfilledAt: Date | null
}

/**
 * Refuse anything an agent must not be allowed to fulfil, with the reason.
 *
 * The three refusals are deliberately distinct: at a counter with cash already on
 * it, "someone else got there first" and "this code timed out" call for
 * completely different conversations. A CANCELLED code answers as not-found -
 * the player withdrew it, and there is nothing for the agent to act on.
 */
function assertUsable(request: RequestRow, now: Date): void {
    if (request.status === 'FULFILLED') throw new RequestAlreadyFulfilledError(request.fulfilledAt)
    if (request.status === 'CANCELLED') throw new RequestNotFoundError()
    if (request.status === 'EXPIRED') throw new RequestExpiredError(request.expiresAt)
    // A PENDING row past its expiry is treated as expired wherever it is read.
    // Nothing sweeps these rows, so the timestamp is the authority, not the status.
    if (request.expiresAt.getTime() <= now.getTime()) throw new RequestExpiredError(request.expiresAt)
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class AgentDepositService {
    /**
     * Issue a code for `amount`.
     *
     * Any live code the player already holds is cancelled first: one player, one
     * code, so there is never an ambiguity about which one the cash at the counter
     * is for. That rule is carried by a PARTIAL UNIQUE INDEX on (userId) WHERE
     * status = 'PENDING' rather than by this read-then-write, which is what makes
     * it true under concurrency - the losing insert raises P2002 and the retry
     * below re-runs the cancel against the winner's row.
     */
    static async createRequest(userId: string, amount: Decimal | string | number) {
        const settings = await AgentService.getSettings()
        // Round to the scale the column stores BEFORE validating, so the figure
        // that gets range-checked is the figure that gets persisted.
        const requested = toMoneyDecimal(amount)
        const min = new Decimal(settings.depositMin)
        const max = new Decimal(settings.depositMax)
        if (requested === null || requested.lessThan(min) || requested.greaterThan(max)) {
            throw new AmountOutOfRangeError(settings.depositMin, settings.depositMax)
        }

        const expiresAt = new Date(Date.now() + settings.codeTtlSeconds * 1000)

        for (let attempt = 0; ; attempt++) {
            try {
                return await prisma.$transaction(async (tx) => {
                    await tx.agentDepositRequest.updateMany({
                        where: { userId, status: 'PENDING' },
                        data: { status: 'CANCELLED' },
                    })
                    const created = await tx.agentDepositRequest.create({
                        data: { code: newCode(), userId, amount: requested, expiresAt },
                    })
                    return {
                        id: created.id,
                        code: created.code,
                        amount: money(created.amount),
                        expiresAt: created.expiresAt,
                        status: created.status,
                    }
                })
            } catch (err) {
                if (attempt < CREATE_RETRIES && isUniqueViolation(err)) continue
                throw err
            }
        }
    }

    /** The player's live code, or null. An expired PENDING row counts as absent. */
    static async getActiveRequest(userId: string) {
        const row = await prisma.agentDepositRequest.findFirst({
            where: { userId, status: 'PENDING', expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
        })
        if (!row) return null
        return {
            id: row.id,
            code: row.code,
            amount: money(row.amount),
            expiresAt: row.expiresAt,
            status: row.status,
        }
    }

    /** Idempotent: no live code is a success, not an error. */
    static async cancelActiveRequest(userId: string) {
        const { count } = await prisma.agentDepositRequest.updateMany({
            where: { userId, status: 'PENDING' },
            data: { status: 'CANCELLED' },
        })
        return { cancelled: count }
    }

    /**
     * Resolve a code to the row an agent may act on, or throw the reason they may
     * not. Prefers the live PENDING row; falls back to the most recent settled row
     * so the refusal can be specific rather than a blanket 404 (codes are reused
     * once settled, so both can exist for one code).
     */
    private static async resolveRequest(code: string): Promise<RequestRow> {
        const pending = await prisma.agentDepositRequest.findFirst({
            where: { code, status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
        })
        const row =
            pending ??
            (await prisma.agentDepositRequest.findFirst({
                where: { code },
                orderBy: { createdAt: 'desc' },
            }))
        if (!row) throw new RequestNotFoundError()
        assertUsable(row as RequestRow, new Date())
        return row as RequestRow
    }

    /**
     * What the agent sees BEFORE taking the cash. Read-only: it moves no money and
     * claims nothing, so two agents can both be looking at the same code.
     *
     * The player's name and phone are masked here and never leave this service
     * unmasked. `depositCount` and `since` are the reassurance an agent needs that
     * they are dealing with a real returning player, without handing them a profile.
     */
    static async lookupByCode(code: string) {
        const request = await AgentDepositService.resolveRequest(code)

        const [user, depositCount] = await Promise.all([
            prisma.user.findUnique({
                where: { id: request.userId },
                select: { firstName: true, lastName: true, username: true, phone: true, createdAt: true },
            }),
            prisma.transaction.count({
                where: { userId: request.userId, type: TransactionType.DEPOSIT, status: PaymentStatus.APPROVED },
            }),
        ])

        return {
            code: request.code,
            amount: money(request.amount),
            expiresAt: request.expiresAt,
            player: {
                maskedName: maskName(user),
                maskedPhone: maskPhone(user?.phone),
                since: user?.createdAt ?? null,
                depositCount,
            },
        }
    }

    /**
     * The cash is in the drawer. Settle the code.
     *
     * ONE transaction does all of it: claim the request, debit the float, write the
     * agent ledger row, create the player's deposit and credit it. Splitting any of
     * that across commits would create a window where the agent has been debited and
     * the player has not been paid, or the reverse.
     *
     * Lock order is request -> agent -> wallet, the same every time, so two agents
     * racing on one code queue up instead of deadlocking.
     */
    static async fulfill(code: string, agentUserId: string) {
        // Fast-fail before opening the money transaction, so a suspended agent does
        // not take a lock on a live code just to be refused. The authoritative check
        // is repeated INSIDE the transaction below: this one is only a courtesy and
        // must never be the thing standing between a suspended shop and the float.
        const precheck = await prisma.agent.findUnique({
            where: { userId: agentUserId },
            select: { id: true, user: { select: { accountStatus: true } } },
        })
        if (!precheck) throw new AgentNotFoundError()
        if (precheck.user?.accountStatus !== AccountStatus.ACTIVE) throw new AgentSuspendedError()

        const committed = await prisma.$transaction(async (tx) => {
            const now = new Date()

            // 1. Claim the request. FOR UPDATE is what decides the race between two
            // agents holding the same code: the loser blocks here, and when the
            // winner commits Postgres re-reads the row it was waiting on, so the
            // loser sees status = 'FULFILLED' and is refused before touching any
            // float. The WHERE is on `code` alone (which never changes) so the
            // re-read cannot silently drop the row; the ORDER BY prefers the live
            // row over the settled history a reused code leaves behind.
            const rows = await tx.$queryRaw<RequestRow[]>`
                SELECT id, code, "userId", amount, status::text AS status, "expiresAt", "fulfilledAt"
                FROM agent_deposit_requests
                WHERE code = ${code}
                ORDER BY (status = 'PENDING') DESC, "createdAt" DESC
                LIMIT 1
                FOR UPDATE
            `
            const request = rows[0]
            if (!request) throw new RequestNotFoundError()
            assertUsable(request, now)

            // 2. Lock the agent row and read the float under that lock. `FOR UPDATE
            // OF a` locks only the agent, not the joined user row.
            const agents = await tx.$queryRaw<Array<{ id: string; userId: string; float: Decimal; accountStatus: string }>>`
                SELECT a.id, a."userId", a."float", u."accountStatus"::text AS "accountStatus"
                FROM agents a
                JOIN users u ON u.id = a."userId"
                WHERE a."userId" = ${agentUserId}
                FOR UPDATE OF a
            `
            const agent = agents[0]
            if (!agent) throw new AgentNotFoundError()
            if (agent.accountStatus !== AccountStatus.ACTIVE) throw new AgentSuspendedError()

            const amount = new Decimal(request.amount)
            const floatBefore = new Decimal(agent.float)
            // Prepaid means prepaid. Refused, never clamped and never allowed to go
            // negative: a negative float is the operator extending unsecured credit
            // to a shop, which this system has no mechanism to collect.
            if (floatBefore.lessThan(amount)) throw new InsufficientFloatError(floatBefore, amount)
            const floatAfter = floatBefore.minus(amount)

            // 3. Debit the float and record it. actorId is null because no member of
            // staff moved this: the agent settled it themselves at the counter.
            await tx.agent.update({ where: { id: agent.id }, data: { float: floatAfter } })
            await tx.agentLedger.create({
                data: {
                    agentId: agent.id,
                    type: 'FULFILLMENT',
                    amount: amount.negated(),
                    balanceBefore: floatBefore,
                    balanceAfter: floatAfter,
                    requestId: request.id,
                    actorId: null,
                },
            })

            // 4. The player's deposit row.
            //
            // senderName and senderAccount MUST STAY NULL. DO NOT "FIX" THIS BY
            // STAMPING THE AGENT'S DETAILS HERE.
            //
            // PayerIdentityService keys its shared-payer detection on
            // senderAccount: two accounts whose first deposits were paid from one
            // account are treated as duplicate-account farming, and both the
            // first-deposit bonus and the referral reward are withheld from the
            // second. An agent shop is the legitimate opposite of that pattern -
            // every player at that counter pays through the same shop - so putting
            // the agent in senderAccount would make every player after the very
            // first one at each shop look like a shared payer, and silently strip
            // the incentives they are entitled to. The failure would be invisible:
            // no error, no alert, just a bonus quietly not granted.
            //
            // The agent is recorded where it belongs instead: on the
            // AgentDepositRequest (agentId) and on the AgentLedger FULFILLMENT row.
            const transaction = await tx.transaction.create({
                data: {
                    userId: request.userId,
                    type: TransactionType.DEPOSIT,
                    status: PaymentStatus.PENDING_REVIEW,
                    gateway: 'agent',
                    amount,
                    note: null,
                },
            })

            // 5. Credit it in this same commit.
            //
            // reviewedById is the AGENT's user id, and that is load-bearing as well
            // as informative: it arms the existing separation-of-duties check inside
            // creditApprovedDepositInTx, so an agent who generates a code on their
            // own player account and then fulfils it is refused by the same rule
            // that stops a clerk approving their own deposit.
            const result = await WalletService.creditApprovedDepositInTx(tx, transaction.id, {
                reviewerId: agent.userId,
            })

            // 6. Settle the request. Moving it out of PENDING is also what releases
            // the player's one-live-code slot and frees the code for reuse.
            const fulfilled = await tx.agentDepositRequest.update({
                where: { id: request.id },
                data: {
                    status: 'FULFILLED',
                    agentId: agent.id,
                    transactionId: transaction.id,
                    fulfilledAt: now,
                },
            })

            return { result, fulfilled, floatAfter, amount, transactionId: transaction.id, playerId: request.userId }
        }, FULFILL_TX_OPTIONS)

        // Post-commit, exactly as a gateway deposit would: the wallet push, the
        // bonuses, the notification, the PostHog events and the Prometheus counter.
        // An agent deposit is a full first-class deposit and earns every incentive a
        // gateway deposit earns - that is a deliberate product decision, not an
        // oversight, and it is the other half of the senderAccount rule above.
        await WalletService.runPostApprovalEffects(committed.result)

        const player = await prisma.user.findUnique({
            where: { id: committed.playerId },
            select: { firstName: true, lastName: true, username: true },
        })

        return {
            reference: committed.transactionId,
            amount: money(committed.amount),
            code,
            fulfilledAt: committed.fulfilled.fulfilledAt,
            floatAfter: money(committed.floatAfter),
            player: { maskedName: maskName(player) },
        }
    }
}
