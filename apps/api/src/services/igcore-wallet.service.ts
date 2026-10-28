import { Prisma } from '@prisma/client'
import type { AccountStatus as AccountStatusValue, ThirdPartyTransaction } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { AccountStatus, TransactionType, PaymentStatus, ThirdPartyTxType, ThirdPartyTxStatus } from '@world-bingo/shared-types'
import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
import { getLogger } from '../lib/log-context.js'
import { maskAccount } from '../lib/logger.js'
import { emitProviderBet, emitProviderWin } from '../lib/posthog-events.js'
import { igcoreConfig } from '../gateways/igcore/igcore-config.js'
import { BonusService } from './bonus.service'
import { NotificationService } from './notification.service'

// IGCORE's seamless wallet. IGCORE (the sportsbook operator) calls us to take
// a stake, pay a result, or roll either back. Every money-moving handler runs
// in one DB transaction holding the player's wallet row FOR UPDATE, and is
// idempotent on IGCORE's `transaction_id` through the unique
// (providerId, transactionId) key on ThirdPartyTransaction.

// ─── Contract ─────────────────────────────────────────────────────────────────

export interface IgcoreCallbackBody {
    transaction_id: string; action: 'bet' | 'result' | 'freebet' | 'rollback'
    user_id: string; currency: string; amount: number
    rollback_transaction_id?: string
    rollback_transaction_action?: 'bet' | 'freebet' | 'result'
    freebet?: Record<string, unknown>
    info?: { ticketId?: number; ticket?: { id?: number; fromId?: number | null }; newTicket?: { id?: number; fromId?: number | null } }
}

/**
 * What a handler decided. The route maps it: `ok` → 200 with our row id,
 * `reject` → 200 with the error code, `retry` (or a thrown error) → 500.
 */
export type IgcoreOutcome =
    | { kind: 'ok'; transactionId: string; userId: string }
    | { kind: 'reject'; error: string }
    | { kind: 'retry'; reason: string }

/** Rejection codes, exact strings IGCORE sees in `{"error": ...}`. */
export const IGCORE_REJECT = {
    PLAYER_NOT_FOUND: 'PLAYER_NOT_FOUND',
    ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
    CURRENCY_NOT_SUPPORTED: 'CURRENCY_NOT_SUPPORTED',
    INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
    FREEBETS_NOT_ENABLED: 'FREEBETS_NOT_ENABLED',
    UNKNOWN_ACTION: 'UNKNOWN_ACTION',
} as const

const PROVIDER_CODE = 'igcore'
const GAME_CODE = 'sportsbook'
const USER_CACHE_TTL = 3600
/** Also dropped by AccountStatusService.invalidate, so a status change reaches the sportsbook at once. */
const USER_CACHE_PREFIX = 'tp:user:igcore:'
/** `rawResponse.held` on a result row whose payout a safety cap is holding. */
const HELD = 'CAP_EXCEEDED'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
type PlayerRef = { id: string; accountStatus: AccountStatusValue }
type WalletRow = { id: string; realBalance: Decimal; bonusBalance: Decimal; spendAccount: 'REAL' | 'BONUS' }

// ─── Outcomes ─────────────────────────────────────────────────────────────────

function ok(row: { id: string; userId: string }): IgcoreOutcome {
    return { kind: 'ok', transactionId: row.id, userId: row.userId }
}

function reject(error: string): IgcoreOutcome {
    return { kind: 'reject', error }
}

function retry(reason: string): IgcoreOutcome {
    return { kind: 'retry', reason }
}

// ─── Provider row ─────────────────────────────────────────────────────────────

let providerIdPromise: Promise<string> | null = null

/**
 * The `igcore` GameProvider row's id, created on first use so a missing seed
 * can never fail a callback. INACTIVE keeps it out of the public provider
 * list, the lobby, catalog sync and the launch route, which all filter on
 * ACTIVE; the sportsbook's on/off is the `feature_sportsbook` flag instead.
 * `update: {}` leaves an existing row exactly as an admin left it.
 */
export async function getIgcoreProviderId(): Promise<string> {
    if (!providerIdPromise) {
        providerIdPromise = upsertProvider().catch((e) => {
            providerIdPromise = null
            throw e
        })
    }
    return providerIdPromise
}

async function upsertProvider(): Promise<string> {
    const where = { code: PROVIDER_CODE }
    try {
        const row = await prisma.gameProvider.upsert({
            where,
            update: {},
            create: {
                code: PROVIDER_CODE, name: 'IGCORE Sportsbook', status: 'INACTIVE',
                apiBaseUrl: igcoreConfig().apiUrl || '', currency: 'ETB', config: { kind: 'sportsbook' },
            },
            select: { id: true },
        })
        return row.id
    } catch (e) {
        // Two replicas creating the row at the same moment: read the winner's.
        if (!isUniqueViolation(e)) throw e
        return (await prisma.gameProvider.findUniqueOrThrow({ where, select: { id: true } })).id
    }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function isUniqueViolation(e: unknown): boolean {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

/** IGCORE's idempotency key. A callback without one cannot be made safe, so it fails loudly (500). */
function transactionIdOf(b: IgcoreCallbackBody): string {
    const id = b?.transaction_id
    if (typeof id !== 'string' || id.length === 0) throw new Error('IGCORE callback has no transaction_id')
    return id
}

function ticketIdOf(b: IgcoreCallbackBody): string | null {
    const id = b.info?.ticketId
    return id == null ? null : String(id)
}

/** The user UUID behind IGCORE's `user_id` (its bare 32-hex form), or null when it is not one. */
function userIdOfPlayer(playerId: unknown): string | null {
    if (typeof playerId !== 'string' || !/^[0-9a-f]{32}$/i.test(playerId)) return null
    const hex = playerId.toLowerCase()
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The ticket's root: the id every callback of one ticket is filed under as
 * `roundId`, partial-cashout remainders included. A remainder names its
 * parent in `info.ticket.fromId`, and the parent's rows already carry the
 * root, so one lookup follows any depth of remainders. The bet link, the
 * per-ticket cap and shortfall netting all key on it.
 *
 * Scoped to the callback's player: a ticket only ever belongs to one, so
 * another player's rows must never shape this one's lineage. `betId` has no
 * index, so the scope also keeps the lookup on the userId index.
 */
export async function resolveTicketRoot(tx: Tx, providerId: string, b: IgcoreCallbackBody): Promise<string> {
    const userId = userIdOfPlayer(b.user_id)
    if (!userId) throw new Error('IGCORE callback has no valid user_id')
    const fromId = b.info?.ticket?.fromId ?? null
    const parent = fromId != null ? String(fromId) : ticketIdOf(b)
    if (parent == null) return transactionIdOf(b)
    const row = await tx.thirdPartyTransaction.findFirst({
        where: { providerId, userId, betId: parent, roundId: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: { roundId: true },
    })
    return row?.roundId ?? parent
}

/** A stake must be a finite positive amount. Anything else is malformed and fails loudly (500). */
function stakeOf(b: IgcoreCallbackBody): Decimal {
    const raw: unknown = b.amount
    const stake = new Decimal(typeof raw === 'number' || typeof raw === 'string' ? raw : NaN)
    if (!stake.isFinite() || stake.lte(0)) throw new Error('IGCORE stake must be a positive amount')
    return stake
}

/** A payout must be a finite amount of 0 or more (0 is a loss under sendLose). Anything else fails loudly (retry). */
function payoutOf(b: IgcoreCallbackBody): Decimal {
    const raw: unknown = b.amount
    const payout = new Decimal(typeof raw === 'number' || typeof raw === 'string' ? raw : NaN)
    if (!payout.isFinite() || payout.lt(0)) throw new Error('IGCORE payout must be a non-negative amount')
    return payout
}

/** A Decimal kept as a string under `key` of a row's rawResponse; 0 when absent. A malformed one fails loudly. */
function storedDecimal(raw: Prisma.JsonValue | null, key: 'shortfall' | 'netted'): Decimal {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw[key] : undefined
    if (value == null) return new Decimal(0)
    const amount = new Decimal(typeof value === 'string' || typeof value === 'number' ? value : NaN)
    if (!amount.isFinite() || amount.lt(0)) throw new Error(`IGCORE ledger row carries a malformed ${key}`)
    return amount
}

function sum(values: Decimal[]): Decimal {
    return values.reduce((total, v) => total.plus(v), new Decimal(0))
}

async function cacheGet(key: string): Promise<PlayerRef | null> {
    try {
        const cached = await redis.get(key)
        return cached ? (JSON.parse(cached) as PlayerRef) : null
    } catch {
        return null // A cache outage must not fail a wallet call: fall through to the DB.
    }
}

async function cacheSet(key: string, user: PlayerRef): Promise<void> {
    try {
        await redis.setex(key, USER_CACHE_TTL, JSON.stringify(user))
    } catch {
        // Best effort; the next call reads the DB again.
    }
}

/**
 * Resolves IGCORE's `user_id`, the bare 32-hex form of our user UUID (what
 * the session endpoint sends). Nothing else is accepted: we never hand IGCORE
 * a username. Misses are not cached, so a lookup never records a player.
 */
async function resolveUser(playerId: unknown): Promise<PlayerRef | null> {
    const id = userIdOfPlayer(playerId)
    if (!id) return null
    const cacheKey = `${USER_CACHE_PREFIX}${id.replace(/-/g, '')}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, accountStatus: true } })
    if (user) await cacheSet(cacheKey, user)
    return user
}

async function lockWallet(tx: Tx, userId: string): Promise<WalletRow> {
    const rows = await tx.$queryRaw<WalletRow[]>`
        SELECT id, "realBalance", "bonusBalance", "spendAccount" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `
    if (!rows[0]) throw new Error('IGCORE player has no wallet')
    return rows[0]
}

async function findExisting(db: Db, providerId: string, transactionId: string): Promise<ThirdPartyTransaction | null> {
    return db.thirdPartyTransaction.findUnique({
        where: { providerId_transactionId: { providerId, transactionId } },
    })
}

/**
 * Runs `work` once per IGCORE transaction_id, inside one DB transaction that
 * holds the player's wallet row lock. `work` gets the stored row for this
 * transaction_id as seen under the lock (null when there is none), so a copy
 * that committed while we queued for the lock is never applied twice.
 *
 * A copy that never queued on our lock (it locked another wallet, or it
 * inserted just after our re-check) surfaces as P2002 when we insert the
 * same key. That error aborts the whole transaction, so everything `work`
 * already wrote, the debit included, is rolled back; the winner's row is
 * re-read outside the dead transaction and handed to `onRace`.
 */
async function lockedOnce<T>(
    userId: string,
    transactionId: string,
    work: (tx: Tx, wallet: WalletRow, existing: ThirdPartyTransaction | null) => Promise<T>,
    onRace: (row: ThirdPartyTransaction) => T,
): Promise<T> {
    const providerId = await getIgcoreProviderId()
    try {
        return await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, userId)
            const existing = await findExisting(tx, providerId, transactionId)
            return work(tx, wallet, existing)
        })
    } catch (e) {
        if (!isUniqueViolation(e)) throw e
        const row = await findExisting(prisma, providerId, transactionId)
        if (!row) throw e
        return onRace(row)
    }
}

/**
 * True when a stored row for this transaction_id belongs to someone else.
 * IGCORE's ids are unique on their side, so this is never a plain replay;
 * answering it as one would tell IGCORE this player's money moved when it
 * did not.
 */
function ownedByAnotherPlayer(row: ThirdPartyTransaction, userId: string): boolean {
    if (row.userId === userId) return false
    getLogger().warn(
        { component: 'igcore-fraud-flag', transactionId: row.transactionId, rowId: row.id, playerId: maskAccount(userId.replace(/-/g, '')) },
        '[igcore-fraud-flag] transaction_id already recorded for another player',
    )
    return true
}

/**
 * A bet's stored outcome, replayed verbatim: an applied (or since rolled
 * back) stake is success, a refused one repeats its refusal.
 */
function answerBetDuplicate(row: ThirdPartyTransaction, userId: string): IgcoreOutcome {
    if (ownedByAnotherPlayer(row, userId)) return retry('TRANSACTION_ID_OF_ANOTHER_PLAYER')
    if (row.status === ThirdPartyTxStatus.COMPLETED || row.status === ThirdPartyTxStatus.ROLLED_BACK) return ok(row)
    const error = (row.rawResponse as { error?: unknown } | null)?.error
    return typeof error === 'string' ? reject(error) : retry('FAILED_ROW_WITHOUT_ERROR')
}

/** A result row whose payout a safety cap is holding. A retry re-evaluates it under the lock. */
function isHeld(row: ThirdPartyTransaction): boolean {
    return (
        row.type === ThirdPartyTxType.BET_RESULT &&
        row.status === ThirdPartyTxStatus.FAILED &&
        (row.rawResponse as { held?: unknown } | null)?.held === HELD
    )
}

/**
 * A result's stored outcome. Applied (or since rolled back) answers success
 * with the same id. Anything else, a held payout included, asks for a retry:
 * a result is never refused with a 200 (§4.7), and the retry is what lets a
 * held payout be re-evaluated.
 */
function answerResultDuplicate(row: ThirdPartyTransaction, userId: string): IgcoreOutcome {
    if (ownedByAnotherPlayer(row, userId)) return retry('TRANSACTION_ID_OF_ANOTHER_PLAYER')
    if (row.status === ThirdPartyTxStatus.COMPLETED || row.status === ThirdPartyTxStatus.ROLLED_BACK) return ok(row)
    return retry(isHeld(row) ? HELD : 'FAILED_ROW')
}

type ResultFields = Pick<
    Prisma.ThirdPartyTransactionUncheckedCreateInput,
    'status' | 'winAmount' | 'amount' | 'balanceBefore' | 'balanceAfter' | 'rawResponse'
>

/**
 * Writes this result's row, or settles the held row already filed under its
 * transaction_id. Updating that row, never adding a second, is what makes a
 * held payout apply at most once however it is released.
 */
async function writeResultRow(
    tx: Tx,
    held: ThirdPartyTransaction | null,
    base: Omit<Prisma.ThirdPartyTransactionUncheckedCreateInput, keyof ResultFields>,
    fields: ResultFields,
): Promise<{ id: string; userId: string }> {
    const select = { id: true, userId: true } as const
    if (!held) return tx.thirdPartyTransaction.create({ data: { ...base, ...fields }, select })
    return tx.thirdPartyTransaction.update({
        where: { id: held.id },
        data: { ...fields, roundId: base.roundId, rawResponse: fields.rawResponse ?? Prisma.DbNull },
        select,
    })
}

type ResultSettled = {
    outcome: IgcoreOutcome
    credited?: { userId: string; roundId: string; betId: string | null; credit: Decimal; stake: Decimal }
}

/**
 * §4.7: pays one result. Every non-success answer is a retry (the route's
 * 500), because a 200 with an error makes IGCORE drop the payout for good.
 * Account status never blocks: a result settles a stake already taken.
 */
async function settleResult(b: IgcoreCallbackBody): Promise<ResultSettled> {
    const transactionId = transactionIdOf(b)
    const user = await resolveUser(b.user_id)
    if (!user) {
        getLogger().warn(
            { component: 'igcore-wallet', transactionId, playerId: typeof b.user_id === 'string' ? maskAccount(b.user_id) : null },
            '[igcore-wallet] result for an unknown player; asking IGCORE to retry',
        )
        return { outcome: retry(IGCORE_REJECT.PLAYER_NOT_FOUND) }
    }
    const playerId = maskAccount(user.id.replace(/-/g, ''))

    const providerId = await getIgcoreProviderId()
    const seen = await findExisting(prisma, providerId, transactionId)
    if (seen && !isHeld(seen)) return { outcome: answerResultDuplicate(seen, user.id) }

    if (b.currency !== igcoreConfig().currency) {
        getLogger().warn(
            { component: 'igcore-wallet', transactionId, playerId, currency: b.currency },
            '[igcore-wallet] result in a currency we do not accept; asking IGCORE to retry',
        )
        return { outcome: retry(IGCORE_REJECT.CURRENCY_NOT_SUPPORTED) }
    }

    const payout = payoutOf(b)
    const betId = ticketIdOf(b)
    const onDuplicate = (row: ThirdPartyTransaction): ResultSettled => ({ outcome: answerResultDuplicate(row, user.id) })

    return lockedOnce<ResultSettled>(user.id, transactionId, async (tx, wallet, existing) => {
        // Only our own held row goes on to be re-evaluated; anything else
        // stored under this transaction_id is answered as it stands.
        if (existing && (existing.userId !== user.id || !isHeld(existing))) return onDuplicate(existing)
        const held = existing

        const roundId = await resolveTicketRoot(tx, providerId, b)
        const realBefore = new Decimal(wallet.realBalance)
        const bonus = new Decimal(wallet.bonusBalance)
        const totalBefore = realBefore.plus(bonus)
        const base = {
            providerId, userId: user.id, transactionId, betId, roundId, gameCode: GAME_CODE,
            type: ThirdPartyTxType.BET_RESULT, rawRequest: b as unknown as Prisma.InputJsonValue,
        }

        // A loss under sendLose: recorded, nothing to credit, nothing to cap.
        if (payout.isZero()) {
            const row = await writeResultRow(tx, held, base, {
                status: ThirdPartyTxStatus.COMPLETED, winAmount: payout, amount: payout,
                balanceBefore: totalBefore, balanceAfter: totalBefore,
                rawResponse: held ? { released: HELD } : undefined,
            })
            return { outcome: ok(row) }
        }

        const rootRows = await tx.thirdPartyTransaction.findMany({
            where: { providerId, userId: user.id, roundId },
            select: { type: true, status: true, amount: true, betAmount: true, rawResponse: true },
        })
        const completed = (type: ThirdPartyTxType) =>
            rootRows.filter((r) => r.type === type && r.status === ThirdPartyTxStatus.COMPLETED)
        const paidResults = completed(ThirdPartyTxType.BET_RESULT)
        const paidOnTicket = sum(paidResults.map((r) => new Decimal(r.amount)))

        // 1. Safety caps (0 disables one). Over → hold under this
        // transaction_id and ask for a retry; raising the cap and having
        // IGCORE resend releases it through the row above.
        const cfg = igcoreConfig()
        const breach =
            cfg.maxWinAmount > 0 && payout.gt(cfg.maxWinAmount) ? 'IGCORE_MAX_WIN_AMOUNT'
                : cfg.maxTicketPayout > 0 && payout.plus(paidOnTicket).gt(cfg.maxTicketPayout) ? 'IGCORE_MAX_TICKET_PAYOUT'
                    : null
        if (breach) {
            const row = held ?? (await writeResultRow(tx, null, base, {
                status: ThirdPartyTxStatus.FAILED, amount: new Decimal(0),
                balanceBefore: totalBefore, balanceAfter: totalBefore, rawResponse: { held: HELD },
            }))
            getLogger().warn(
                {
                    component: 'igcore-fraud-flag', transactionId, rowId: row.id, playerId, roundId, cap: breach,
                    payout: payout.toString(), paidOnTicket: paidOnTicket.toString(),
                },
                '[igcore-fraud-flag] result over a payout cap: held, asking IGCORE to retry',
            )
            return { outcome: retry(HELD) }
        }

        // 2. Shortfall netting: what a short rollback could not take back is
        // owed by the player and comes off this payout first. A result rolled
        // back since is out of both sums: its netted part was never paid.
        const shortfall = sum(
            rootRows.filter((r) => r.type === ThirdPartyTxType.ROLLBACK).map((r) => storedDecimal(r.rawResponse, 'shortfall')),
        )
        const alreadyNetted = sum(paidResults.map((r) => storedDecimal(r.rawResponse, 'netted')))
        const outstanding = Decimal.max(0, shortfall.minus(alreadyNetted))
        const netted = Decimal.min(payout, outstanding)
        const credit = payout.minus(netted)

        // 3. A win always lands on real, whichever account funded the stake.
        const realAfter = realBefore.plus(credit)
        const totalAfter = realAfter.plus(bonus)
        if (credit.gt(0)) await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: realAfter } })

        const response: Record<string, string> = {}
        if (held) response.released = HELD
        if (netted.gt(0)) response.netted = netted.toString()
        const row = await writeResultRow(tx, held, base, {
            status: ThirdPartyTxStatus.COMPLETED, winAmount: payout, amount: credit,
            balanceBefore: totalBefore, balanceAfter: totalAfter,
            rawResponse: Object.keys(response).length > 0 ? response : undefined,
        })
        if (credit.gt(0)) {
            await tx.transaction.create({
                data: {
                    userId: user.id, type: TransactionType.TP_WIN, amount: credit,
                    status: PaymentStatus.APPROVED,
                    note: `IGCORE sports win: ticket ${betId ?? roundId}`,
                    referenceId: transactionId,
                    balanceBefore: totalBefore, balanceAfter: totalAfter,
                    bonusBalanceBefore: bonus, bonusBalanceAfter: bonus,
                },
            })
        }

        // 4. Signed and never refusable, so paid either way; flagged for review.
        const bets = rootRows.filter((r) => r.type === ThirdPartyTxType.BET)
        const appliedBets = completed(ThirdPartyTxType.BET)
        if (appliedBets.length === 0) {
            getLogger().warn(
                { component: 'igcore-fraud-flag', transactionId, rowId: row.id, playerId, roundId, payout: payout.toString(), betRows: bets.length },
                bets.length === 0
                    ? '[igcore-fraud-flag] result with no recorded bet'
                    : '[igcore-fraud-flag] result for a ticket whose bet was refused or rolled back',
            )
        }

        if (credit.isZero()) return { outcome: ok(row) }
        const stake = sum(appliedBets.map((r) => new Decimal(r.betAmount ?? 0)))
        return { outcome: ok(row), credited: { userId: user.id, roundId, betId, credit, stake } }
    }, onDuplicate)
}

/**
 * A rollback's stored outcome. Only a rollback row under this key is a
 * duplicate; a bet or result filed under it is an id collision, and
 * answering it as done would tell IGCORE a reversal happened that did not.
 */
function answerRollbackDuplicate(row: ThirdPartyTransaction, userId: string): IgcoreOutcome {
    if (ownedByAnotherPlayer(row, userId)) return retry('TRANSACTION_ID_OF_ANOTHER_PLAYER')
    if (row.type === ThirdPartyTxType.ROLLBACK) return ok(row)
    getLogger().warn(
        { component: 'igcore-fraud-flag', transactionId: row.transactionId, rowId: row.id, type: row.type },
        '[igcore-fraud-flag] rollback transaction_id already recorded for another action',
    )
    return retry('TRANSACTION_ID_OF_ANOTHER_ACTION')
}

/**
 * The ledger type IGCORE's `rollback_transaction_action` names (a freebet is
 * filed as a bet), or null when it sent none. An action we do not know fails
 * loudly (retry).
 */
function namedTypeOf(b: IgcoreCallbackBody): ThirdPartyTxType | null {
    const action: unknown = b.rollback_transaction_action
    if (action == null) return null
    if (action === 'bet' || action === 'freebet') return ThirdPartyTxType.BET
    if (action === 'result') return ThirdPartyTxType.BET_RESULT
    throw new Error('IGCORE rollback names an unknown rollback_transaction_action')
}

type RollbackSettled = {
    outcome: IgcoreOutcome
    moved?: { userId: string }
    shortfall?: Record<string, string>
}

/**
 * §4.9: reverses the row at `rollback_transaction_id`. The kind is the one
 * `rollback_transaction_action` names, else the stored row's type. Every path
 * that answers success writes this rollback's own row (the id IGCORE gets
 * back), filed under the original's root so shortfall netting sees it.
 */
async function settleRollback(b: IgcoreCallbackBody): Promise<RollbackSettled> {
    const transactionId = transactionIdOf(b)
    const originalId: unknown = b.rollback_transaction_id
    if (typeof originalId !== 'string' || originalId.length === 0) throw new Error('IGCORE rollback has no rollback_transaction_id')
    if (originalId === transactionId) throw new Error('IGCORE rollback names itself')
    const namedType = namedTypeOf(b)

    const user = await resolveUser(b.user_id)
    if (!user) {
        getLogger().warn(
            { component: 'igcore-wallet', transactionId, playerId: typeof b.user_id === 'string' ? maskAccount(b.user_id) : null },
            '[igcore-wallet] rollback for an unknown player; asking IGCORE to retry',
        )
        return { outcome: retry(IGCORE_REJECT.PLAYER_NOT_FOUND) }
    }
    const playerId = maskAccount(user.id.replace(/-/g, ''))

    const providerId = await getIgcoreProviderId()
    const seen = await findExisting(prisma, providerId, transactionId)
    if (seen) return { outcome: answerRollbackDuplicate(seen, user.id) }

    const betId = ticketIdOf(b)
    const onDuplicate = (row: ThirdPartyTransaction): RollbackSettled => ({ outcome: answerRollbackDuplicate(row, user.id) })

    // A P2002 on the rollback's own key is a racing copy: lockedOnce answers
    // it as a duplicate. A P2002 on the placeholder key (another player's row
    // landed at rollback_transaction_id mid-flight) finds no row under ours,
    // so it is rethrown and answered as a retry; IGCORE's re-send then sees
    // that row and takes the other-player path below.
    return lockedOnce<RollbackSettled>(user.id, transactionId, async (tx, wallet, existing) => {
        if (existing) return onDuplicate(existing)

        const original = await findExisting(tx, providerId, originalId)
        const realBefore = new Decimal(wallet.realBalance)
        const bonusBefore = new Decimal(wallet.bonusBalance)
        const totalBefore = realBefore.plus(bonusBefore)
        let realAfter = realBefore
        let bonusAfter = bonusBefore
        let amount = new Decimal(0) // signed: + a stake returned, − a payout taken back
        let ledger: { type: TransactionType; amount: Decimal; note: string } | null = null
        let reversal: { payout: Decimal; debit: Decimal } | null = null
        let roundId: string
        let rowBetId = betId

        if (!original) {
            // Nothing applied (§4.11 step 4). The placeholder takes the key, so
            // an original that arrives late is a duplicate and never applies.
            roundId = await resolveTicketRoot(tx, providerId, b)
            const type = namedType ?? ThirdPartyTxType.ROLLBACK
            await tx.thirdPartyTransaction.create({
                data: {
                    providerId, userId: user.id, transactionId: originalId, betId, roundId, gameCode: GAME_CODE,
                    type, status: ThirdPartyTxStatus.ROLLED_BACK, amount: new Decimal(0),
                    balanceBefore: totalBefore, balanceAfter: totalBefore, rawResponse: { placeholder: true },
                },
            })
            getLogger().warn(
                { component: 'igcore-wallet', transactionId, originalId, playerId, roundId, type },
                '[igcore-wallet] rollback for a transaction we never recorded; placeholder written',
            )
        } else if (original.userId !== user.id) {
            // Ruling R4: IGCORE queued this after we answered another player's
            // id with a retry. The key is taken, so no placeholder, and the
            // owner's row is never touched from here. Lineage stays this player's.
            roundId = await resolveTicketRoot(tx, providerId, b)
            getLogger().warn(
                { component: 'igcore-fraud-flag', transactionId, originalId, rowId: original.id, playerId },
                '[igcore-fraud-flag] rollback names another player\'s transaction: nothing moved',
            )
        } else {
            roundId = original.roundId ?? (await resolveTicketRoot(tx, providerId, b))
            rowBetId = betId ?? original.betId
            const ticket = rowBetId ?? roundId
            const reversible =
                isHeld(original) ||
                (original.status === ThirdPartyTxStatus.COMPLETED &&
                    (original.type === ThirdPartyTxType.BET || original.type === ThirdPartyTxType.BET_RESULT))

            if (reversible && namedType != null && namedType !== original.type) {
                // Taking the action at its word would refund a result or claw
                // back a stake. Nothing is written; IGCORE retries, and the
                // unresolved callback surfaces on their side.
                getLogger().warn(
                    { component: 'igcore-fraud-flag', transactionId, originalId, rowId: original.id, playerId, named: namedType, stored: original.type },
                    '[igcore-fraud-flag] rollback action disagrees with the stored transaction; asking IGCORE to retry',
                )
                return { outcome: retry('ROLLBACK_ACTION_MISMATCH') }
            }

            if (original.type === ThirdPartyTxType.BET && original.status === ThirdPartyTxStatus.COMPLETED) {
                // Back to the account it came from, as the bet's ledger row
                // recorded it, whatever the toggle says now (AtlasVWalletService).
                const stake = new Decimal(original.betAmount ?? original.amount).abs()
                let realDelta = stake
                let bonusDelta = new Decimal(0)
                let restoreExpiry: Date | null = null
                const betTxn = await tx.transaction.findFirst({
                    where: { userId: user.id, type: TransactionType.TP_BET, referenceId: original.transactionId },
                    select: { bonusBalanceBefore: true, bonusBalanceAfter: true, bonusExpiresAtSpend: true },
                })
                if (betTxn) {
                    const bonusSpent = new Decimal(betTxn.bonusBalanceBefore ?? 0).minus(new Decimal(betTxn.bonusBalanceAfter ?? 0))
                    if (bonusSpent.gt(0)) {
                        bonusDelta = Decimal.min(bonusSpent, stake)
                        realDelta = stake.minus(bonusDelta)
                        restoreExpiry = betTxn.bonusExpiresAtSpend ?? null
                    }
                }
                if (realDelta.gt(0)) {
                    realAfter = realBefore.plus(realDelta)
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: realAfter } })
                }
                if (bonusDelta.gt(0)) {
                    bonusAfter = (await BonusService.restore(tx, user.id, bonusDelta, restoreExpiry)).bonusBalanceAfter
                }
                amount = stake
                if (stake.gt(0)) {
                    ledger = { type: TransactionType.TP_ROLLBACK, amount: stake, note: `IGCORE sports bet rolled back: ticket ${ticket}` }
                }
            } else if (original.type === ThirdPartyTxType.BET_RESULT && original.status === ThirdPartyTxStatus.COMPLETED) {
                // Real only: a win always landed on real. Never below zero;
                // what cannot be taken back is owed and netted off the
                // corrected result that §4.9 says follows.
                const paid = Decimal.max(0, new Decimal(original.amount))
                const debit = Decimal.max(0, Decimal.min(realBefore, paid))
                reversal = { payout: paid, debit }
                if (debit.gt(0)) {
                    realAfter = realBefore.minus(debit)
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: realAfter } })
                    amount = debit.negated()
                    // Ruling R5: TP_ADJUSTMENT, not TP_ROLLBACK. The player's
                    // history lists TP_ROLLBACK as a credit by type, so this
                    // debit would show as "+ Bet Reversed"; an adjustment is
                    // classified by its balance drop instead.
                    ledger = { type: TransactionType.TP_ADJUSTMENT, amount: debit, note: `IGCORE sports win reversed: ticket ${ticket}` }
                }
            }
            // Anything else (a refused bet, a row already rolled back) has
            // nothing to reverse. A held payout moved nothing either, but it
            // is retired below so a later release can never pay it.
            if (reversible) {
                await tx.thirdPartyTransaction.update({ where: { id: original.id }, data: { status: ThirdPartyTxStatus.ROLLED_BACK } })
            }
        }

        const totalAfter = realAfter.plus(bonusAfter)
        const shortfall = reversal ? reversal.payout.minus(reversal.debit) : new Decimal(0)
        const row = await tx.thirdPartyTransaction.create({
            data: {
                providerId, userId: user.id, transactionId, betId: rowBetId, roundId, gameCode: GAME_CODE,
                type: ThirdPartyTxType.ROLLBACK, status: ThirdPartyTxStatus.COMPLETED, amount,
                balanceBefore: totalBefore, balanceAfter: totalAfter,
                rawRequest: b as unknown as Prisma.InputJsonValue,
                // Only a short result reversal carries this: the netting sums it
                // over every ROLLBACK row on the root.
                rawResponse: shortfall.gt(0) ? { shortfall: shortfall.toString() } : undefined,
            },
            select: { id: true, userId: true },
        })
        if (ledger) {
            await tx.transaction.create({
                data: {
                    userId: user.id, type: ledger.type, amount: ledger.amount,
                    status: PaymentStatus.APPROVED, note: ledger.note, referenceId: transactionId,
                    balanceBefore: totalBefore, balanceAfter: totalAfter,
                    bonusBalanceBefore: bonusBefore, bonusBalanceAfter: bonusAfter,
                },
            })
        }

        return {
            outcome: ok(row),
            moved: ledger ? { userId: user.id } : undefined,
            shortfall: reversal && shortfall.gt(0)
                ? {
                    transactionId, originalId, rowId: row.id, playerId, roundId,
                    payout: reversal.payout.toString(), debited: reversal.debit.toString(), shortfall: shortfall.toString(),
                }
                : undefined,
        }
    }, onDuplicate)
}

type BetResult = { outcome: IgcoreOutcome; applied?: { spendAccount: 'REAL' | 'BONUS'; roundId: string } }

/** Thrown inside the bet transaction to abort it without moving money. */
class InsufficientFunds extends Error {
    constructor() {
        super('Insufficient funds')
        this.name = 'InsufficientFunds'
    }
}

function isInsufficient(e: unknown): boolean {
    // BonusService.spend throws InsufficientBonusBalanceError when the lots
    // fall short of the cached balance; that is a refusal too, not a 500.
    return e instanceof InsufficientFunds || (e as Error | null)?.name === 'InsufficientBonusBalanceError'
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class IgcoreWalletService {
    /**
     * §4.6: take a stake from whichever account the wallet's toggle selects.
     * Synchronous on IGCORE's side (5 s budget); a 500 makes IGCORE cancel the
     * bet and queue a rollback.
     */
    static async processBet(b: IgcoreCallbackBody): Promise<IgcoreOutcome> {
        const transactionId = transactionIdOf(b)
        const user = await resolveUser(b.user_id)
        if (!user) return reject(IGCORE_REJECT.PLAYER_NOT_FOUND)

        // A replay answers what the first copy got, before any check that may
        // have changed since: a stake already taken keeps answering success
        // even if the player was restricted in between.
        const providerId = await getIgcoreProviderId()
        const seen = await findExisting(prisma, providerId, transactionId)
        if (seen) return answerBetDuplicate(seen, user.id)

        if (user.accountStatus !== AccountStatus.ACTIVE) return reject(IGCORE_REJECT.ACCOUNT_RESTRICTED)
        if (b.currency !== igcoreConfig().currency) return reject(IGCORE_REJECT.CURRENCY_NOT_SUPPORTED)

        const stake = stakeOf(b)
        const betId = ticketIdOf(b)
        const onDuplicate = (row: ThirdPartyTransaction): BetResult => ({ outcome: answerBetDuplicate(row, user.id) })

        let result: BetResult
        try {
            result = await lockedOnce<BetResult>(user.id, transactionId, async (tx, wallet, existing) => {
                if (existing) return onDuplicate(existing)
                const roundId = await resolveTicketRoot(tx, providerId, b)

                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                let realAfter = realBefore
                let bonusAfter = bonusBefore
                let bonusExpiresAtSpend: Date | null = null

                // Checked here rather than left to the DB: the wallets CHECK
                // (>= 0) is a backstop, and it is absent from db-push databases.
                if (wallet.spendAccount === 'BONUS') {
                    if (bonusBefore.lessThan(stake)) throw new InsufficientFunds()
                    const spent = await BonusService.spend(tx, user.id, stake)
                    bonusAfter = spent.bonusBalanceAfter
                    bonusExpiresAtSpend = spent.soonestExpiryConsumed
                } else {
                    if (realBefore.lessThan(stake)) throw new InsufficientFunds()
                    realAfter = realBefore.minus(stake)
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: realAfter } })
                }
                const totalBefore = realBefore.plus(bonusBefore)
                const totalAfter = realAfter.plus(bonusAfter)

                // A racing copy that inserted this key first makes this create
                // throw P2002, which rolls back the debit above (see lockedOnce).
                const row = await tx.thirdPartyTransaction.create({
                    data: {
                        providerId, userId: user.id, transactionId, betId, roundId, gameCode: GAME_CODE,
                        type: ThirdPartyTxType.BET, status: ThirdPartyTxStatus.COMPLETED,
                        betAmount: stake, amount: stake.negated(),
                        balanceBefore: totalBefore, balanceAfter: totalAfter,
                        rawRequest: b as unknown as Prisma.InputJsonValue,
                    },
                    select: { id: true, userId: true },
                })
                await tx.transaction.create({
                    data: {
                        userId: user.id, type: TransactionType.TP_BET, amount: stake,
                        status: PaymentStatus.APPROVED,
                        note: `IGCORE sports bet: ticket ${betId ?? roundId}`,
                        referenceId: transactionId,
                        balanceBefore: totalBefore, balanceAfter: totalAfter,
                        bonusBalanceBefore: bonusBefore, bonusBalanceAfter: bonusAfter, bonusExpiresAtSpend,
                    },
                })
                return { outcome: ok(row), applied: { spendAccount: wallet.spendAccount, roundId } }
            }, onDuplicate)
        } catch (e) {
            if (!isInsufficient(e)) throw e
            // The debit transaction aborted with nothing moved. Record the
            // refusal under this transaction_id, so a replay repeats it.
            result = await lockedOnce<BetResult>(user.id, transactionId, async (tx, wallet, existing) => {
                if (existing) return onDuplicate(existing)
                const roundId = await resolveTicketRoot(tx, providerId, b)
                const total = new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))
                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId, userId: user.id, transactionId, betId, roundId, gameCode: GAME_CODE,
                        type: ThirdPartyTxType.BET, status: ThirdPartyTxStatus.FAILED,
                        betAmount: stake, amount: new Decimal(0),
                        balanceBefore: total, balanceAfter: total,
                        rawRequest: b as unknown as Prisma.InputJsonValue,
                        rawResponse: { error: IGCORE_REJECT.INSUFFICIENT_FUNDS },
                    },
                })
                return { outcome: reject(IGCORE_REJECT.INSUFFICIENT_FUNDS) }
            }, onDuplicate)
        }

        if (result.applied) {
            emitProviderBet(user.id, {
                providerCode: PROVIDER_CODE, gameCode: GAME_CODE, roundId: result.applied.roundId, betId,
                amount: stake.toNumber(), spendAccount: result.applied.spendAccount,
            })
            void IgcoreWalletService.pushBalance(user.id)
        }
        return result.outcome
    }

    /** §4.8: freebets were not requested on the account, so one arriving is refused and nothing is recorded. */
    static async processFreebet(b: IgcoreCallbackBody): Promise<IgcoreOutcome> {
        getLogger().warn(
            { component: 'igcore-wallet', transactionId: b?.transaction_id },
            '[igcore-wallet] freebet refused: freebets are not enabled on this account',
        )
        return reject(IGCORE_REJECT.FREEBETS_NOT_ENABLED)
    }

    /**
     * §4.7: pay a settled ticket (settlement, cashout, partial cashout or
     * re-settlement). Queued and retried by IGCORE, and never refusable, so
     * every failure, thrown or not, answers `retry` (the route's 500).
     */
    static async processResult(b: IgcoreCallbackBody): Promise<IgcoreOutcome> {
        let settled: ResultSettled
        try {
            settled = await settleResult(b)
        } catch (err) {
            getLogger().error(
                { component: 'igcore-wallet', err, transactionId: b?.transaction_id },
                '[igcore-wallet] result failed; asking IGCORE to retry',
            )
            return retry('RESULT_FAILED')
        }

        const { credited } = settled
        if (credited) {
            emitProviderWin(credited.userId, {
                providerCode: PROVIDER_CODE, gameCode: GAME_CODE, roundId: credited.roundId, betId: credited.betId,
                amount: credited.credit.toNumber(), roundStake: credited.stake.toNumber(),
            })
            void IgcoreWalletService.pushBalance(credited.userId)
        }
        return settled.outcome
    }

    /**
     * §4.9: reverse a bet (placement failed on IGCORE's side) or a result
     * (wrong settlement; a corrected result follows). Queued and retried like
     * a result, so every failure, thrown or not, answers `retry` (the route's
     * 500), and account status never blocks it.
     */
    static async processRollback(b: IgcoreCallbackBody): Promise<IgcoreOutcome> {
        let settled: RollbackSettled
        try {
            settled = await settleRollback(b)
        } catch (err) {
            getLogger().error(
                { component: 'igcore-wallet', err, transactionId: b?.transaction_id },
                '[igcore-wallet] rollback failed; asking IGCORE to retry',
            )
            return retry('ROLLBACK_FAILED')
        }

        // After commit, so an admin is only ever pointed at a reversal that stuck.
        if (settled.shortfall) {
            getLogger().warn(
                { component: 'igcore-rollback-shortfall', ...settled.shortfall },
                '[igcore-rollback-shortfall] result rollback found too little real balance; the rest is owed and netted off the next result',
            )
        }
        if (settled.moved) void IgcoreWalletService.pushBalance(settled.moved.userId)
        return settled.outcome
    }

    /** Routes a verified, parsed callback by endpoint and action. Exceptions propagate (the route answers 500). */
    static async dispatch(endpoint: 'transaction' | 'transaction-rollback', b: IgcoreCallbackBody): Promise<IgcoreOutcome> {
        if (endpoint === 'transaction') {
            if (b.action === 'bet') return IgcoreWalletService.processBet(b)
            if (b.action === 'result') return IgcoreWalletService.processResult(b)
            if (b.action === 'freebet') return IgcoreWalletService.processFreebet(b)
        } else if (endpoint === 'transaction-rollback' && b.action === 'rollback') {
            return IgcoreWalletService.processRollback(b)
        }
        return reject(IGCORE_REJECT.UNKNOWN_ACTION)
    }

    /** Pushes the player's current balances over the socket. Post-commit and best effort: never throws. */
    static async pushBalance(userId: string): Promise<void> {
        try {
            const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { realBalance: true, bonusBalance: true } })
            if (!wallet) return
            NotificationService.pushWalletUpdate(userId, wallet.realBalance.toNumber(), wallet.bonusBalance.toNumber())
        } catch (err) {
            getLogger().warn({ component: 'igcore-wallet', err }, '[igcore-wallet] balance push failed')
        }
    }
}
