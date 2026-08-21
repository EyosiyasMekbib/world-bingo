import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
import { TransactionType, PaymentStatus, ThirdPartyTxType, ThirdPartyTxStatus } from '@world-bingo/shared-types'
import { BonusService } from './bonus.service'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalletCallbackResponse {
    traceId: string
    status: string
    data?: {
        username: string
        currency: string
        balance: number
        timestamp: number
    }
}

interface BaseCallbackParams {
    traceId: string
    username: string
    currency: string
    token?: string
}

export interface BetParams extends BaseCallbackParams {
    transactionId: string
    betId: string
    externalTransactionId?: string
    amount: number
    gameCode: string
    roundId: string
    timestamp: number
}

export interface BetResultParams extends BaseCallbackParams {
    transactionId: string
    betId: string
    externalTransactionId?: string
    roundId: string
    betAmount: number
    winAmount: number
    effectiveTurnover: number
    winLoss: number
    jackpotAmount: number
    resultType: 'WIN' | 'BET_WIN' | 'BET_LOSE' | 'LOSE' | 'END'
    isFreespin: number
    isEndRound: number
    gameCode: string
    betTime: number
    settledTime: number
}

export interface RollbackParams {
    traceId: string
    transactionId: string
    betId: string
    externalTransactionId?: string
    roundId: string
    gameCode: string
    username: string
    currency: string
    timestamp: number
}

export interface AdjustmentParams extends BaseCallbackParams {
    transactionId: string
    externalTransactionId?: string
    roundId: string
    amount: number
    gameCode: string
    timestamp: number
}

export interface BetDebitParams extends BaseCallbackParams {
    transactionId: string
    roundId: string
    takeAll: number
    amount: number
    gameCode: string
    timestamp: number
}

export interface BetCreditParams extends BaseCallbackParams {
    transactionId: string
    betId?: string
    roundId: string
    isRefund: number
    amount: number
    betAmount: number
    winAmount: number
    effectiveTurnover: number
    winLoss: number
    jackpotAmount: number
    gameCode: string
    betTime: number
    settledTime: number
    timestamp: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PROVIDER_CODE = 'gasea'
const CURRENCY = process.env.GASEA_DEFAULT_CURRENCY ?? 'ETB'
const USER_CACHE_TTL = 3600 // 1 hour

/** Cached provider UUID (fetched once on first callback). */
let _providerId: string | null = null

async function getProviderId(): Promise<string> {
    if (_providerId) return _providerId
    const provider = await prisma.gameProvider.findUnique({ where: { code: PROVIDER_CODE } })
    if (!provider) throw new Error(`Provider '${PROVIDER_CODE}' not found in DB. Run the seed.`)
    _providerId = provider.id
    return _providerId
}

function ok(traceId: string, username: string, balance: Decimal): WalletCallbackResponse {
    return {
        traceId,
        status: 'SC_OK',
        data: {
            username,
            currency: CURRENCY,
            balance: Number(balance.toFixed(8, Decimal.ROUND_HALF_UP)),
            timestamp: Date.now(),
        },
    }
}

function err(traceId: string, status: string): WalletCallbackResponse {
    return { traceId, status }
}

/** Resolve username → userId, with Redis caching.
 *  GASea usernames are the user UUID with dashes removed (32 hex chars).
 *  Fall back to looking up by the username field for any other format.
 */
async function resolveUser(username: string): Promise<{ id: string; isActive: boolean } | null> {
    const cacheKey = `tp:user:${username}`
    const cached = await redis.get(cacheKey)
    if (cached) {
        return JSON.parse(cached)
    }

    let user: { id: string; isActive: boolean } | null = null

    if (/^[0-9a-f]{32}$/i.test(username)) {
        // Restore UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
        const id = `${username.slice(0, 8)}-${username.slice(8, 12)}-${username.slice(12, 16)}-${username.slice(16, 20)}-${username.slice(20)}`
        user = await prisma.user.findUnique({
            where: { id },
            select: { id: true, isActive: true },
        })
    } else {
        user = await prisma.user.findUnique({
            where: { username },
            select: { id: true, isActive: true },
        })
    }

    if (user) {
        await redis.setex(cacheKey, USER_CACHE_TTL, JSON.stringify(user))
    }

    return user
}

/** Lock wallet row with SELECT FOR UPDATE, returning balance snapshot. */
type WalletRow = { id: string; realBalance: Decimal; bonusBalance: Decimal; spendAccount: 'REAL' | 'BONUS' }

async function lockWallet(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], userId: string): Promise<WalletRow> {
    const rows = await tx.$queryRaw<WalletRow[]>`
        SELECT id, "realBalance", "bonusBalance", "spendAccount" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `
    if (!rows[0]) throw { code: 'SC_USER_NOT_EXISTS' }
    return rows[0]
}

/** Check for an existing idempotent record. */
async function findExisting(transactionId: string) {
    const providerId = await getProviderId()
    return prisma.thirdPartyTransaction.findUnique({
        where: { providerId_transactionId: { providerId, transactionId } },
    })
}

/** Validate currency matches operator currency. */
function validateCurrency(currency: string, traceId: string): WalletCallbackResponse | null {
    if (currency.toUpperCase() !== CURRENCY) {
        return err(traceId, 'SC_WRONG_CURRENCY')
    }
    return null
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ThirdPartyWalletService {
    /**
     * GET BALANCE
     * Called by GASea to retrieve the user's current wallet balance.
     */
    static async getBalance(params: BaseCallbackParams): Promise<WalletCallbackResponse> {
        const currErr = validateCurrency(params.currency, params.traceId)
        if (currErr) return currErr

        const user = await resolveUser(params.username)
        if (!user) return err(params.traceId, 'SC_USER_NOT_EXISTS')
        if (!user.isActive) return err(params.traceId, 'SC_USER_DISABLED')

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        if (!wallet) return err(params.traceId, 'SC_USER_NOT_EXISTS')

        const total = new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))
        return ok(params.traceId, params.username, total)
    }

    /**
     * BET
     * Deducts bet amount from the player's wallet.
     */
    static async processBet(params: BetParams): Promise<WalletCallbackResponse> {
        const currErr = validateCurrency(params.currency, params.traceId)
        if (currErr) return currErr

        const user = await resolveUser(params.username)
        if (!user) return err(params.traceId, 'SC_USER_NOT_EXISTS')
        if (!user.isActive) return err(params.traceId, 'SC_USER_DISABLED')

        // Idempotency check
        const existing = await findExisting(params.transactionId)
        if (existing) {
            if (existing.status === ThirdPartyTxStatus.FAILED) {
                return err(params.traceId, 'SC_INSUFFICIENT_FUNDS')
            }
            return ok(params.traceId, params.username, new Decimal(existing.balanceAfter))
        }

        try {
            const result = await prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, user.id)
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const totalBefore = realBefore.plus(bonusBefore)
                const betAmount = new Decimal(params.amount).abs()

                // Spend entirely from the player's selected account — never fall back
                // to the other one. Ledger rows below still record the combined total
                // for audit purposes (unchanged, out of this task's scope).
                let newReal = realBefore
                let newBonus = bonusBefore
                let bonusExpiresAtSpend: Date | null = null

                if (wallet.spendAccount === 'BONUS') {
                    if (bonusBefore.lessThan(betAmount)) throw { code: 'SC_INSUFFICIENT_FUNDS' }
                    const spendResult = await BonusService.spend(tx, user.id, betAmount)
                    newBonus = spendResult.bonusBalanceAfter
                    bonusExpiresAtSpend = spendResult.soonestExpiryConsumed
                } else {
                    if (realBefore.lessThan(betAmount)) throw { code: 'SC_INSUFFICIENT_FUNDS' }
                    newReal = realBefore.minus(betAmount)
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                }

                const balanceAfter = newReal.plus(newBonus)

                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId: await getProviderId(),
                        userId: user.id,
                        transactionId: params.transactionId,
                        betId: params.betId,
                        externalTransactionId: params.externalTransactionId,
                        roundId: params.roundId,
                        gameCode: params.gameCode,
                        type: ThirdPartyTxType.BET,
                        status: ThirdPartyTxStatus.COMPLETED,
                        betAmount: betAmount,
                        amount: betAmount.negated(),
                        balanceBefore: totalBefore,
                        balanceAfter,
                        rawRequest: params as any,
                    },
                })

                await tx.transaction.create({
                    data: {
                        userId: user.id,
                        type: TransactionType.TP_BET,
                        amount: betAmount,
                        status: PaymentStatus.APPROVED,
                        note: `TP bet: ${params.gameCode} round ${params.roundId}`,
                        referenceId: params.transactionId,
                        balanceBefore: totalBefore,
                        balanceAfter,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: newBonus,
                        bonusExpiresAtSpend,
                    },
                })

                return balanceAfter
            })

            return ok(params.traceId, params.username, result)
        } catch (e: any) {
            if (e?.code === 'SC_INSUFFICIENT_FUNDS') {
                // Persist a FAILED record so rollback can identify this betId as insufficient-funds
                try {
                    const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
                    const currentBalance = wallet
                        ? new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))
                        : new Decimal(0)
                    await prisma.thirdPartyTransaction.create({
                        data: {
                            providerId: await getProviderId(),
                            userId: user.id,
                            transactionId: params.transactionId,
                            betId: params.betId,
                            externalTransactionId: params.externalTransactionId,
                            roundId: params.roundId,
                            gameCode: params.gameCode,
                            type: ThirdPartyTxType.BET,
                            status: ThirdPartyTxStatus.FAILED,
                            betAmount: new Decimal(params.amount).abs(),
                            amount: new Decimal(0),
                            balanceBefore: currentBalance,
                            balanceAfter: currentBalance,
                            rawRequest: params as any,
                        },
                    })
                } catch {
                    // ignore duplicate key on retry — idempotency
                }
                return err(params.traceId, e.code)
            }
            if (e?.code) return err(params.traceId, e.code)
            throw e
        }
    }

    /**
     * BET_RESULT
     * Combined bet + result in a single call. Handles WIN, BET_WIN, BET_LOSE, LOSE, END.
     */
    static async processBetResult(params: BetResultParams): Promise<WalletCallbackResponse> {
        const currErr = validateCurrency(params.currency, params.traceId)
        if (currErr) return currErr

        const user = await resolveUser(params.username)
        if (!user) return err(params.traceId, 'SC_USER_NOT_EXISTS')
        if (!user.isActive) return err(params.traceId, 'SC_USER_DISABLED')

        // Idempotency check
        const existing = await findExisting(params.transactionId)
        if (existing) {
            if (existing.status === ThirdPartyTxStatus.FAILED) {
                return err(params.traceId, 'SC_INSUFFICIENT_FUNDS')
            }
            return ok(params.traceId, params.username, new Decimal(existing.balanceAfter))
        }

        // Look up prior bet/debit by betId for betAmount validation and existence check
        const priorBet = params.betId ? await prisma.thirdPartyTransaction.findFirst({
            where: {
                providerId: await getProviderId(),
                userId: user.id,
                betId: params.betId,
                type: { in: [ThirdPartyTxType.BET, ThirdPartyTxType.BET_DEBIT] },
                status: ThirdPartyTxStatus.COMPLETED,
            },
            orderBy: { createdAt: 'asc' },
        }) : null

        // Validate betAmount matches original bet (when betAmount > 0 and prior bet exists)
        if (priorBet && params.betAmount > 0) {
            const expectedBetAmt = priorBet.betAmount!.abs()
            if (!expectedBetAmt.equals(new Decimal(params.betAmount))) {
                return err(params.traceId, 'SC_BET_AMOUNT_NOT_MATCH')
            }
        }

        // WIN/LOSE: require a prior BET/BET_DEBIT to exist, UNLESS betAmount is 0
        // (betAmount 0 occurs on out-of-band promotional wins, jackpots, or zero-cost features)
        if (params.resultType === 'WIN' || params.resultType === 'LOSE') {
            if (!priorBet && params.betAmount > 0) return err(params.traceId, 'SC_TRANSACTION_NOT_EXISTS')
        }

        // END: GASea sends this as a round-close notification after a BET_WIN/BET_LOSE result.
        // The prior context may be a BET_RESULT (not just BET/BET_DEBIT), so search by roundId too.
        if (params.resultType === 'END') {
            const priorRoundActivity = priorBet ?? await prisma.thirdPartyTransaction.findFirst({
                where: {
                    providerId: await getProviderId(),
                    userId: user.id,
                    roundId: params.roundId,
                    type: ThirdPartyTxType.BET_RESULT,
                    status: ThirdPartyTxStatus.COMPLETED,
                },
                orderBy: { createdAt: 'asc' },
            })
            if (!priorRoundActivity) return err(params.traceId, 'SC_TRANSACTION_NOT_EXISTS')
        }

        // END result = no wallet operation needed
        if (params.resultType === 'END') {
            const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
            if (!wallet) return err(params.traceId, 'SC_USER_NOT_EXISTS')
            const total = new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))

            // Record for idempotency even though no balance change
            await prisma.thirdPartyTransaction.create({
                data: {
                    providerId: await getProviderId(),
                    userId: user.id,
                    transactionId: params.transactionId,
                    betId: params.betId,
                    externalTransactionId: params.externalTransactionId,
                    roundId: params.roundId,
                    gameCode: params.gameCode,
                    type: ThirdPartyTxType.BET_RESULT,
                    status: ThirdPartyTxStatus.COMPLETED,
                    betAmount: new Decimal(params.betAmount),
                    winAmount: new Decimal(params.winAmount),
                    amount: new Decimal(0),
                    balanceBefore: total,
                    balanceAfter: total,
                    rawRequest: params as any,
                },
            })
            return ok(params.traceId, params.username, total)
        }

        // LOSE result = round ended, no win — record idempotency only
        if (params.resultType === 'LOSE') {
            const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
            if (!wallet) return err(params.traceId, 'SC_USER_NOT_EXISTS')
            const total = new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))

            await prisma.thirdPartyTransaction.create({
                data: {
                    providerId: await getProviderId(),
                    userId: user.id,
                    transactionId: params.transactionId,
                    betId: params.betId,
                    externalTransactionId: params.externalTransactionId,
                    roundId: params.roundId,
                    gameCode: params.gameCode,
                    type: ThirdPartyTxType.BET_RESULT,
                    status: ThirdPartyTxStatus.COMPLETED,
                    betAmount: new Decimal(params.betAmount),
                    winAmount: new Decimal(0),
                    amount: new Decimal(0),
                    balanceBefore: total,
                    balanceAfter: total,
                    rawRequest: params as any,
                },
            })
            return ok(params.traceId, params.username, total)
        }

        // Calculate net wallet change
        const betAmt = new Decimal(params.betAmount)
        const winAmt = new Decimal(params.winAmount).plus(new Decimal(params.jackpotAmount))
        let netChange: Decimal
        let txType: TransactionType

        switch (params.resultType) {
            case 'BET_WIN':
                netChange = winAmt.minus(betAmt)
                txType = netChange.greaterThanOrEqualTo(0) ? TransactionType.TP_WIN : TransactionType.TP_BET
                break
            case 'BET_LOSE':
                netChange = betAmt.negated()
                txType = TransactionType.TP_BET
                break
            case 'WIN':
                netChange = winAmt
                txType = TransactionType.TP_WIN
                break
            default:
                netChange = new Decimal(0)
                txType = TransactionType.TP_BET
        }

        let balanceAttempt: Decimal | null = null

        try {
            const result = await prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, user.id)
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const totalBefore = realBefore.plus(bonusBefore)
                balanceAttempt = totalBefore

                // BET_WIN / BET_LOSE combine bet deduction + result in one call.
                // The bet portion must always be covered by the player's balance,
                // even when net change is positive (win > bet).
                if (params.resultType === 'BET_WIN' || params.resultType === 'BET_LOSE') {
                    if (totalBefore.lessThan(betAmt)) throw { code: 'SC_INSUFFICIENT_FUNDS' }
                }

                // For net debits, also check sufficient funds
                if (netChange.lessThan(0)) {
                    const debit = netChange.abs()
                    if (totalBefore.lessThan(debit)) throw { code: 'SC_INSUFFICIENT_FUNDS' }
                }

                let newReal = realBefore.plus(netChange.greaterThan(0) ? netChange : 0)
                let newBonus = bonusBefore

                if (netChange.lessThan(0)) {
                    const debit = netChange.abs()
                    if (realBefore.greaterThanOrEqualTo(debit)) {
                        newReal = realBefore.minus(debit)
                    } else {
                        const fromBonus = debit.minus(realBefore)
                        newReal = new Decimal(0)
                        newBonus = bonusBefore.minus(fromBonus)
                    }
                }

                const balanceAfter = newReal.plus(newBonus)

                await tx.wallet.update({
                    where: { userId: user.id },
                    data: { realBalance: newReal, bonusBalance: newBonus },
                })

                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId: await getProviderId(),
                        userId: user.id,
                        transactionId: params.transactionId,
                        betId: params.betId,
                        externalTransactionId: params.externalTransactionId,
                        roundId: params.roundId,
                        gameCode: params.gameCode,
                        type: ThirdPartyTxType.BET_RESULT,
                        status: ThirdPartyTxStatus.COMPLETED,
                        betAmount: betAmt,
                        winAmount: winAmt,
                        amount: netChange,
                        balanceBefore: totalBefore,
                        balanceAfter,
                        rawRequest: params as any,
                    },
                })

                await tx.transaction.create({
                    data: {
                        userId: user.id,
                        type: txType,
                        amount: netChange.abs(),
                        status: PaymentStatus.APPROVED,
                        note: `TP ${params.resultType}: ${params.gameCode} round ${params.roundId}`,
                        referenceId: params.transactionId,
                        balanceBefore: totalBefore,
                        balanceAfter,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: newBonus,
                    },
                })

                return balanceAfter
            })

            return ok(params.traceId, params.username, result)
        } catch (e: any) {
            if (e?.code === 'SC_INSUFFICIENT_FUNDS' && balanceAttempt !== null) {
                // Record the failed attempt so rollback can identify it and return SC_INSUFFICIENT_FUNDS
                try {
                    await prisma.thirdPartyTransaction.create({
                        data: {
                            providerId: await getProviderId(),
                            userId: user.id,
                            transactionId: params.transactionId,
                            betId: params.betId,
                            externalTransactionId: params.externalTransactionId,
                            roundId: params.roundId,
                            gameCode: params.gameCode,
                            type: ThirdPartyTxType.BET_RESULT,
                            status: ThirdPartyTxStatus.FAILED,
                            betAmount: betAmt,
                            winAmount: winAmt,
                            amount: new Decimal(0),
                            balanceBefore: balanceAttempt,
                            balanceAfter: balanceAttempt,
                            rawRequest: params as any,
                        },
                    })
                } catch {
                    // ignore duplicate key on retry — idempotency
                }
                return err(params.traceId, e.code)
            }
            if (e?.code) return err(params.traceId, e.code)
            throw e
        }
    }

    /**
     * ROLLBACK
     * Reverses a previous bet transaction, crediting the bet amount back.
     */
    static async processRollback(params: RollbackParams): Promise<WalletCallbackResponse> {
        const currErr = validateCurrency(params.currency, params.traceId)
        if (currErr) return currErr

        const user = await resolveUser(params.username)
        if (!user) return err(params.traceId, 'SC_USER_NOT_EXISTS')
        if (!user.isActive) return err(params.traceId, 'SC_USER_DISABLED')

        // Idempotency: check if this rollback transactionId already processed
        const existing = await findExisting(params.transactionId)
        if (existing) {
            return ok(params.traceId, params.username, new Decimal(existing.balanceAfter))
        }

        // Find the original bet to know how much to refund.
        // bet_debit records have no betId, so also match by transactionId = params.betId.
        const originalBet = await prisma.thirdPartyTransaction.findFirst({
            where: {
                providerId: await getProviderId(),
                userId: user.id,
                type: { in: [ThirdPartyTxType.BET, ThirdPartyTxType.BET_RESULT, ThirdPartyTxType.BET_DEBIT] },
                status: ThirdPartyTxStatus.COMPLETED,
                OR: [
                    { betId: params.betId },
                    { transactionId: params.betId },
                ],
            },
            orderBy: { createdAt: 'asc' },
        })

        if (!originalBet) {
            return err(params.traceId, 'SC_TRANSACTION_NOT_EXISTS')
        }

        // Negate the original amount to undo its effect:
        //   BET/BET_DEBIT had amount < 0 (debit) → rollbackDelta > 0 (credit back)
        //   BET_RESULT BET_WIN had amount > 0 (net credit) → rollbackDelta < 0 (debit back)
        const rollbackDelta = originalBet.amount.negated()

        try {
        const result = await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)

            let newReal = realBefore
            let newBonus = bonusBefore

            if (rollbackDelta.greaterThanOrEqualTo(0)) {
                // Credit back: undoing a prior debit (BET/BET_DEBIT, or a net-debit
                // BET_RESULT). Restore proportionally to whichever account(s) actually
                // funded that debit, using the paired `Transaction` row the original
                // write site created alongside its `ThirdPartyTransaction` row (every
                // debit site in this file writes one, keyed by referenceId = its own
                // transactionId — the same value `originalBet.transactionId` holds).
                // Falls back to crediting real only when no paired row is found (e.g.
                // pre-dates this split), so behavior is unchanged for old data.
                if (rollbackDelta.greaterThan(0)) {
                    let realDelta = rollbackDelta
                    let bonusDelta = new Decimal(0)
                    let restoreExpiry: Date | null = null

                    const debitTxn = await tx.transaction.findFirst({
                        where: { userId: user.id, referenceId: originalBet.transactionId },
                        select: { bonusBalanceBefore: true, bonusBalanceAfter: true, bonusExpiresAtSpend: true },
                    })
                    if (debitTxn) {
                        const bonusSpent = new Decimal(debitTxn.bonusBalanceBefore ?? 0).minus(
                            new Decimal(debitTxn.bonusBalanceAfter ?? 0),
                        )
                        if (bonusSpent.greaterThan(0)) {
                            bonusDelta = Decimal.min(bonusSpent, rollbackDelta)
                            realDelta = rollbackDelta.minus(bonusDelta)
                            restoreExpiry = debitTxn.bonusExpiresAtSpend ?? null
                        }
                    }

                    if (realDelta.greaterThan(0)) {
                        newReal = realBefore.plus(realDelta)
                        await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                    }
                    if (bonusDelta.greaterThan(0)) {
                        // Restore into a lot carrying the ORIGINAL expiry captured on the
                        // debit's Transaction row (never a fresh window), falling back to
                        // never-expiring only when that debit predates this migration.
                        const restoreResult = await BonusService.restore(tx, user.id, bonusDelta, restoreExpiry)
                        newBonus = restoreResult.bonusBalanceAfter
                    }
                }
            } else {
                // Debit back: undoing a prior credit (e.g. reversing a BET_WIN's net
                // gain). Every credit path in this file (processBetResult's netChange > 0
                // branch, processBetCredit's isRefund=0 case) credits realBalance only,
                // unconditionally — so the money being reversed here is KNOWN to be 100%
                // real. This must NOT consult spendAccount: doing so would let a
                // BONUS-toggled player debit their bonus instead of the real balance the
                // win actually landed in, leaving the win's real credit un-reversed while
                // draining unrelated bonus funds.
                const debit = rollbackDelta.abs()
                if (realBefore.lessThan(debit)) throw { code: 'SC_INSUFFICIENT_FUNDS' }
                newReal = realBefore.minus(debit)
                await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
            }
            const balanceAfter = newReal.plus(newBonus)

            // Mark original as rolled back
            await tx.thirdPartyTransaction.update({
                where: { id: originalBet.id },
                data: { status: ThirdPartyTxStatus.ROLLED_BACK },
            })

            await tx.thirdPartyTransaction.create({
                data: {
                    providerId: await getProviderId(),
                    userId: user.id,
                    transactionId: params.transactionId,
                    betId: params.betId,
                    externalTransactionId: params.externalTransactionId,
                    roundId: params.roundId,
                    gameCode: params.gameCode,
                    type: ThirdPartyTxType.ROLLBACK,
                    status: ThirdPartyTxStatus.COMPLETED,
                    amount: rollbackDelta,
                    balanceBefore: totalBefore,
                    balanceAfter,
                    rawRequest: params as any,
                },
            })

            await tx.transaction.create({
                data: {
                    userId: user.id,
                    type: TransactionType.TP_ROLLBACK,
                    amount: rollbackDelta.abs(),
                    status: PaymentStatus.APPROVED,
                    note: `TP rollback: ${params.gameCode} round ${params.roundId}`,
                    referenceId: params.transactionId,
                    balanceBefore: totalBefore,
                    balanceAfter,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: newBonus,
                    // Neither branch above performs a genuine bonus spend: the credit-back
                    // branch restores bonus (via BonusService.restore, which owns its own
                    // new grant's expiry), and the debit-back branch is real-only. This
                    // ledger row never has an original spend-expiry of its own to stamp.
                    bonusExpiresAtSpend: null,
                },
            })

            return balanceAfter
        })

        return ok(params.traceId, params.username, result)
        } catch (e: any) {
            if (e?.code) return err(params.traceId, e.code)
            console.error('[GASea] Unexpected error in processRollback:', e)
            return err(params.traceId, 'SC_INTERNAL_ERROR')
        }
    }

    /**
     * ADJUSTMENT
     * Positive amount = credit. Negative amount = debit.
     */
    static async processAdjustment(params: AdjustmentParams): Promise<WalletCallbackResponse> {
        const currErr = validateCurrency(params.currency, params.traceId)
        if (currErr) return currErr

        const user = await resolveUser(params.username)
        if (!user) return err(params.traceId, 'SC_USER_NOT_EXISTS')
        if (!user.isActive) return err(params.traceId, 'SC_USER_DISABLED')

        const existing = await findExisting(params.transactionId)
        if (existing) {
            return ok(params.traceId, params.username, new Decimal(existing.balanceAfter))
        }

        if (params.externalTransactionId) {
            const providerId = await getProviderId()
            const priorBet = await prisma.thirdPartyTransaction.findFirst({
                where: {
                    providerId,
                    userId: user.id,
                    type: { in: [ThirdPartyTxType.BET, ThirdPartyTxType.BET_DEBIT] },
                    OR: [
                        { transactionId: params.externalTransactionId },
                        { externalTransactionId: params.externalTransactionId },
                    ],
                },
            })
            if (!priorBet) return err(params.traceId, 'SC_TRANSACTION_NOT_EXISTS')
        }

        const adjustAmount = new Decimal(params.amount)

        try {
            const result = await prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, user.id)
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const totalBefore = realBefore.plus(bonusBefore)

                let newReal = realBefore
                let newBonus = bonusBefore
                let bonusExpiresAtSpend: Date | null = null

                if (adjustAmount.lessThan(0)) {
                    // Negative adjustment = a fresh, operator-triggered debit (not tied to
                    // any specific prior spend to restore) — spend entirely from the
                    // player's selected account, never fall back to the other one.
                    const debit = adjustAmount.abs()
                    if (wallet.spendAccount === 'BONUS') {
                        if (bonusBefore.lessThan(debit)) throw { code: 'SC_INSUFFICIENT_FUNDS' }
                        const spendResult = await BonusService.spend(tx, user.id, debit)
                        newBonus = spendResult.bonusBalanceAfter
                        bonusExpiresAtSpend = spendResult.soonestExpiryConsumed
                    } else {
                        if (realBefore.lessThan(debit)) throw { code: 'SC_INSUFFICIENT_FUNDS' }
                        newReal = realBefore.minus(debit)
                        await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                    }
                } else {
                    // Positive adjustment = a fresh credit (e.g. operator-granted top-up),
                    // matching how wins credit realBalance only, never bonus.
                    newReal = realBefore.plus(adjustAmount)
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                }

                const balanceAfter = newReal.plus(newBonus)

                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId: await getProviderId(),
                        userId: user.id,
                        transactionId: params.transactionId,
                        externalTransactionId: params.externalTransactionId,
                        roundId: params.roundId,
                        gameCode: params.gameCode,
                        type: ThirdPartyTxType.ADJUSTMENT,
                        status: ThirdPartyTxStatus.COMPLETED,
                        amount: adjustAmount,
                        balanceBefore: totalBefore,
                        balanceAfter,
                        rawRequest: params as any,
                    },
                })

                await tx.transaction.create({
                    data: {
                        userId: user.id,
                        type: TransactionType.TP_ADJUSTMENT,
                        amount: adjustAmount.abs(),
                        status: PaymentStatus.APPROVED,
                        note: `TP adjustment: ${params.gameCode} (${adjustAmount.greaterThan(0) ? '+' : ''}${adjustAmount})`,
                        referenceId: params.transactionId,
                        balanceBefore: totalBefore,
                        balanceAfter,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: newBonus,
                        bonusExpiresAtSpend,
                    },
                })

                return balanceAfter
            })

            return ok(params.traceId, params.username, result)
        } catch (e: any) {
            if (e?.code) return err(params.traceId, e.code)
            console.error('[GASea] Unexpected error in processAdjustment:', e)
            return err(params.traceId, 'SC_INTERNAL_ERROR')
        }
    }

    /**
     * BET_DEBIT
     * Deducts balance for a game room entry (e.g. live dealer tables).
     * takeAll=1 means deduct entire balance.
     */
    static async processBetDebit(params: BetDebitParams): Promise<WalletCallbackResponse> {
        const currErr = validateCurrency(params.currency, params.traceId)
        if (currErr) return currErr

        const user = await resolveUser(params.username)
        if (!user) return err(params.traceId, 'SC_USER_NOT_EXISTS')
        if (!user.isActive) return err(params.traceId, 'SC_USER_DISABLED')

        const existing = await findExisting(params.transactionId)
        if (existing) {
            if (existing.status === ThirdPartyTxStatus.FAILED) {
                return err(params.traceId, 'SC_INSUFFICIENT_FUNDS')
            }
            return ok(params.traceId, params.username, new Decimal(existing.balanceAfter))
        }

        try {
            const result = await prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, user.id)
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const totalBefore = realBefore.plus(bonusBefore)

                // takeAll=1 drains the entire SELECTED account, not the combined total —
                // draining the combined total here would silently reach into the other
                // account, exactly the fallback behavior this migration removes below.
                const accountBefore = wallet.spendAccount === 'BONUS' ? bonusBefore : realBefore
                const debitAmount = params.takeAll === 1 ? accountBefore : new Decimal(params.amount)

                // Spend entirely from the player's selected account — never fall back
                // to the other one.
                let newReal = realBefore
                let newBonus = bonusBefore
                let bonusExpiresAtSpend: Date | null = null

                if (wallet.spendAccount === 'BONUS') {
                    if (bonusBefore.lessThan(debitAmount)) throw { code: 'SC_INSUFFICIENT_FUNDS' }
                    const spendResult = await BonusService.spend(tx, user.id, debitAmount)
                    newBonus = spendResult.bonusBalanceAfter
                    bonusExpiresAtSpend = spendResult.soonestExpiryConsumed
                } else {
                    if (realBefore.lessThan(debitAmount)) throw { code: 'SC_INSUFFICIENT_FUNDS' }
                    newReal = realBefore.minus(debitAmount)
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                }

                const balanceAfter = newReal.plus(newBonus)

                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId: await getProviderId(),
                        userId: user.id,
                        transactionId: params.transactionId,
                        roundId: params.roundId,
                        gameCode: params.gameCode,
                        type: ThirdPartyTxType.BET_DEBIT,
                        status: ThirdPartyTxStatus.COMPLETED,
                        betAmount: debitAmount,
                        amount: debitAmount.negated(),
                        balanceBefore: totalBefore,
                        balanceAfter,
                        rawRequest: params as any,
                    },
                })

                await tx.transaction.create({
                    data: {
                        userId: user.id,
                        type: TransactionType.TP_BET,
                        amount: debitAmount,
                        status: PaymentStatus.APPROVED,
                        note: `TP room entry: ${params.gameCode} round ${params.roundId}`,
                        referenceId: params.transactionId,
                        balanceBefore: totalBefore,
                        balanceAfter,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: newBonus,
                        bonusExpiresAtSpend,
                    },
                })

                return balanceAfter
            })

            return ok(params.traceId, params.username, result)
        } catch (e: any) {
            if (e?.code === 'SC_INSUFFICIENT_FUNDS') {
                // Persist FAILED record for idempotency — retries return SC_INSUFFICIENT_FUNDS
                // instead of re-executing (mirrors processBet behaviour)
                try {
                    const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
                    const currentBalance = wallet
                        ? new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))
                        : new Decimal(0)
                    await prisma.thirdPartyTransaction.create({
                        data: {
                            providerId: await getProviderId(),
                            userId: user.id,
                            transactionId: params.transactionId,
                            roundId: params.roundId,
                            gameCode: params.gameCode,
                            type: ThirdPartyTxType.BET_DEBIT,
                            status: ThirdPartyTxStatus.FAILED,
                            betAmount: new Decimal(params.amount),
                            amount: new Decimal(0),
                            balanceBefore: currentBalance,
                            balanceAfter: currentBalance,
                            rawRequest: params as any,
                        },
                    })
                } catch {
                    // ignore duplicate key on retry — idempotency
                }
                return err(params.traceId, e.code)
            }
            if (e?.code) return err(params.traceId, e.code)
            console.error('[GASea] Unexpected error in processBetDebit:', e)
            return err(params.traceId, 'SC_INTERNAL_ERROR')
        }
    }

    /**
     * BET_CREDIT
     * Settles a game room round — credits the remaining/win amount back.
     * isRefund=1 means refund a prior debit.
     */
    static async processBetCredit(params: BetCreditParams): Promise<WalletCallbackResponse> {
        const currErr = validateCurrency(params.currency, params.traceId)
        if (currErr) return currErr

        const user = await resolveUser(params.username)
        if (!user) return err(params.traceId, 'SC_USER_NOT_EXISTS')
        if (!user.isActive) return err(params.traceId, 'SC_USER_DISABLED')

        const existing = await findExisting(params.transactionId)
        if (existing) {
            return ok(params.traceId, params.username, new Decimal(existing.balanceAfter))
        }

        // Validate betAmount matches the original bet/bet_debit for this round.
        // bet_debit ↔ bet_credit are paired by roundId (no betId in that flow),
        // so look up the round's debit. GASea cert: a credit whose betAmount
        // disagrees with the round's debit must return SC_BET_AMOUNT_NOT_MATCH.
        const priorDebit = params.roundId ? await prisma.thirdPartyTransaction.findFirst({
            where: {
                providerId: await getProviderId(),
                userId: user.id,
                roundId: params.roundId,
                type: { in: [ThirdPartyTxType.BET, ThirdPartyTxType.BET_DEBIT] },
                status: ThirdPartyTxStatus.COMPLETED,
            },
            orderBy: { createdAt: 'asc' },
        }) : null
        if (priorDebit && params.betAmount > 0) {
            const expectedBetAmt = priorDebit.betAmount!.abs()
            if (!expectedBetAmt.equals(new Decimal(params.betAmount))) {
                return err(params.traceId, 'SC_BET_AMOUNT_NOT_MATCH')
            }
        }

        try {
            // Credit amount = remaining balance from game room + any winnings
            const creditAmount = new Decimal(params.amount ?? 0).plus(new Decimal(params.jackpotAmount ?? 0))

            const result = await prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, user.id)
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const totalBefore = realBefore.plus(bonusBefore)

                // isRefund=1 refunds a specific prior debit (bet_debit, or a bet) —
                // restore proportionally to whichever account(s) actually funded it,
                // via the paired `Transaction` row that debit's write site created
                // (referenceId = the debit's own transactionId, which `priorDebit`
                // above already resolved). Any other credit (isRefund=0/absent — a
                // room settlement's remaining balance + winnings) is a fresh credit
                // and lands on realBalance only, matching how wins credit real only
                // elsewhere in this file. Falls back to crediting real only when no
                // paired row is found (e.g. pre-dates this split, or no roundId/no
                // matching debit), so behavior is unchanged for that case.
                let realDelta = creditAmount
                let bonusDelta = new Decimal(0)
                let restoreExpiry: Date | null = null

                if (params.isRefund === 1 && priorDebit && creditAmount.greaterThan(0)) {
                    const debitTxn = await tx.transaction.findFirst({
                        where: { userId: user.id, referenceId: priorDebit.transactionId },
                        select: { bonusBalanceBefore: true, bonusBalanceAfter: true, bonusExpiresAtSpend: true },
                    })
                    if (debitTxn) {
                        const bonusSpent = new Decimal(debitTxn.bonusBalanceBefore ?? 0).minus(
                            new Decimal(debitTxn.bonusBalanceAfter ?? 0),
                        )
                        if (bonusSpent.greaterThan(0)) {
                            bonusDelta = Decimal.min(bonusSpent, creditAmount)
                            realDelta = creditAmount.minus(bonusDelta)
                            restoreExpiry = debitTxn.bonusExpiresAtSpend ?? null
                        }
                    }
                }

                let newReal = realBefore
                let newBonus = bonusBefore

                if (realDelta.greaterThan(0)) {
                    newReal = realBefore.plus(realDelta)
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                }
                if (bonusDelta.greaterThan(0)) {
                    // Restore into a lot carrying the ORIGINAL expiry captured on the
                    // debit's Transaction row (never a fresh window).
                    const restoreResult = await BonusService.restore(tx, user.id, bonusDelta, restoreExpiry)
                    newBonus = restoreResult.bonusBalanceAfter
                }

                const balanceAfter = newReal.plus(newBonus)

                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId: await getProviderId(),
                        userId: user.id,
                        transactionId: params.transactionId,
                        betId: params.betId,
                        roundId: params.roundId,
                        gameCode: params.gameCode,
                        type: ThirdPartyTxType.BET_CREDIT,
                        status: ThirdPartyTxStatus.COMPLETED,
                        betAmount: new Decimal(params.betAmount),
                        winAmount: new Decimal(params.winAmount),
                        amount: creditAmount,
                        balanceBefore: totalBefore,
                        balanceAfter,
                        rawRequest: params as any,
                    },
                })

                await tx.transaction.create({
                    data: {
                        userId: user.id,
                        type: TransactionType.TP_WIN,
                        amount: creditAmount,
                        status: PaymentStatus.APPROVED,
                        note: `TP credit${params.isRefund ? ' (refund)' : ''}: ${params.gameCode} round ${params.roundId}`,
                        referenceId: params.transactionId,
                        balanceBefore: totalBefore,
                        balanceAfter,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: newBonus,
                    },
                })

                return balanceAfter
            })

            return ok(params.traceId, params.username, result)
        } catch (e: any) {
            if (e?.code) return err(params.traceId, e.code)
            console.error('[GASea] Unexpected error in processBetCredit:', e)
            return err(params.traceId, 'SC_INTERNAL_ERROR')
        }
    }
}
