import { Prisma } from '@prisma/client'
import type { AccountStatus as AccountStatusValue, ThirdPartyTransaction } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { AccountStatus, TransactionType, PaymentStatus, ThirdPartyTxType, ThirdPartyTxStatus } from '@world-bingo/shared-types'
import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
import { getLogger } from '../lib/log-context.js'
import { maskAccount } from '../lib/logger.js'
import { emitProviderBet } from '../lib/posthog-events.js'
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

// TODO(Task 4): replaced by resolveTicketRoot, which follows partial-cashout lineage.
function roundIdOf(b: IgcoreCallbackBody): string {
    return String(b.info?.ticketId ?? b.transaction_id)
}

/** A stake must be a finite positive amount. Anything else is malformed and fails loudly (500). */
function stakeOf(b: IgcoreCallbackBody): Decimal {
    const raw: unknown = b.amount
    const stake = new Decimal(typeof raw === 'number' || typeof raw === 'string' ? raw : NaN)
    if (!stake.isFinite() || stake.lte(0)) throw new Error('IGCORE stake must be a positive amount')
    return stake
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
    if (typeof playerId !== 'string' || !/^[0-9a-f]{32}$/i.test(playerId)) return null
    const hex = playerId.toLowerCase()
    const cacheKey = `${USER_CACHE_PREFIX}${hex}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
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

type BetResult = { outcome: IgcoreOutcome; spendAccount?: 'REAL' | 'BONUS' }

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
        const roundId = roundIdOf(b)
        const onDuplicate = (row: ThirdPartyTransaction): BetResult => ({ outcome: answerBetDuplicate(row, user.id) })

        let result: BetResult
        try {
            result = await lockedOnce<BetResult>(user.id, transactionId, async (tx, wallet, existing) => {
                if (existing) return onDuplicate(existing)

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
                return { outcome: ok(row), spendAccount: wallet.spendAccount }
            }, onDuplicate)
        } catch (e) {
            if (!isInsufficient(e)) throw e
            // The debit transaction aborted with nothing moved. Record the
            // refusal under this transaction_id, so a replay repeats it.
            result = await lockedOnce<BetResult>(user.id, transactionId, async (tx, wallet, existing) => {
                if (existing) return onDuplicate(existing)
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

        if (result.spendAccount) {
            emitProviderBet(user.id, {
                providerCode: PROVIDER_CODE, gameCode: GAME_CODE, roundId, betId,
                amount: stake.toNumber(), spendAccount: result.spendAccount,
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

    // TODO(Task 4): results. Until then a result is never refused with a 200
    // (IGCORE would drop the payout for good); a 500 makes them retry it.
    static async processResult(_b: IgcoreCallbackBody): Promise<IgcoreOutcome> {
        return retry('RESULT_NOT_IMPLEMENTED')
    }

    // TODO(Task 5): rollbacks. Retried for the same reason as results.
    static async processRollback(_b: IgcoreCallbackBody): Promise<IgcoreOutcome> {
        return retry('ROLLBACK_NOT_IMPLEMENTED')
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
