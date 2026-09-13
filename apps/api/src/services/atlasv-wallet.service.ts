import { Decimal } from '@prisma/client/runtime/library'
import { emitProviderBet, emitProviderWin } from '../lib/posthog-events.js'
import type { AccountStatus as AccountStatusValue } from '@prisma/client'
import { AccountStatus, TransactionType, PaymentStatus, ThirdPartyTxType, ThirdPartyTxStatus } from '@world-bingo/shared-types'
import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
import { getLogger } from '../lib/log-context.js'
import { maskAccount } from '../lib/logger.js'
import { BonusService } from './bonus.service'

// ─── Types ────────────────────────────────────────────────────────────────────

const PROVIDER_CODE = 'atlasv'
const USER_CACHE_TTL = 3600
const MAX_WIN_AMOUNT = Number(process.env.ATLASV_MAX_WIN_AMOUNT ?? 1_000_000)
const MAX_WIN_MULTIPLE = Number(process.env.ATLASV_MAX_WIN_MULTIPLE ?? 20_000)

export type AtlasVAction = 'account' | 'bet' | 'betwin' | 'result' | 'rollback' | 'freespin' | 'jackpot'
export type AtlasVResponse =
    | { player_id: string; balance: number; error?: null }
    | { success: boolean; error?: string | null }
    | { error: string }

/**
 * Atlas-V's documented error vocabulary for /bet, /betwin, /result, /rollback
 * (their spec calls out these exact strings — e.g. "Only errors with the
 * value 'Service Error' will be retried"). "Rate Limit Increase" is omitted:
 * nothing in this service rate-limits a wallet operation, so no code path
 * ever produces it.
 */
const ATLASV_ERROR = {
    SERVICE_ERROR: 'Service Error',
    INSUFFICIENT_FUNDS: 'Insufficient Funds',
    PLAYER_BLOCKED: 'Player Blocked',
    // Not listed in the /result section of the spec (only /rollback's is),
    // but "no matching bet" is unambiguously this case and neither
    // "Service Error" (implies retry, which won't help) nor "Player Blocked"
    // (wrong subject) fits — reusing /rollback's code is the closest honest match.
    BET_NOT_FOUND: 'Bet not found',
} as const

interface AccountParams { player_id: string }
interface BetParams { player_id: string; round_id?: string; game_code?: string; transaction_id: string; amount: number }
interface BetWinParams { player_id: string; round_id?: string; game_code?: string; transaction_id: string; betAmount: number; winAmount: number }
interface ResultParams { player_id: string; round_id?: string; game_code?: string; transaction_id: string; bet_transaction_id: string; amount: number }
interface RollbackParams { player_id: string; round_id?: string; game_code?: string; bet_transaction_id: string }
interface FreespinResultParams { player_id: string; round_id?: string; game_code?: string; transaction_id: string; amount: number }
interface JackpotParams { player_id: string; round_id?: string; game_code?: string; transaction_id: string; amount: number }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fail(): AtlasVResponse {
    return { success: false }
}

/** Error-shaped failure for /bet, /betwin, /result, /rollback — spec's error responses carry ONLY this field. */
function errFail(code: string): AtlasVResponse {
    return { error: code }
}

let _providerId: string | null = null
async function getAtlasVProviderId(): Promise<string> {
    if (_providerId) return _providerId
    const provider = await prisma.gameProvider.findUnique({ where: { code: PROVIDER_CODE } })
    if (!provider) throw new Error(`Provider '${PROVIDER_CODE}' not seeded in DB`)
    _providerId = provider.id
    return _providerId
}

async function resolveUser(playerId: string): Promise<{ id: string; accountStatus: AccountStatusValue } | null> {
    const cacheKey = `tp:user:${playerId}`
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    let user: { id: string; accountStatus: AccountStatusValue } | null = null
    if (/^[0-9a-f]{32}$/i.test(playerId)) {
        const id = `${playerId.slice(0, 8)}-${playerId.slice(8, 12)}-${playerId.slice(12, 16)}-${playerId.slice(16, 20)}-${playerId.slice(20)}`
        user = await prisma.user.findUnique({ where: { id }, select: { id: true, accountStatus: true } })
    } else {
        user = await prisma.user.findUnique({ where: { username: playerId }, select: { id: true, accountStatus: true } })
    }
    if (user) await redis.setex(cacheKey, USER_CACHE_TTL, JSON.stringify(user))
    getLogger().info(
        { component: 'atlasv-resolve-user', playerId: maskAccount(playerId), matched: !!user },
        '[atlasv-resolve-user] account resolution',
    )
    return user
}

type WalletRow = { id: string; realBalance: Decimal; bonusBalance: Decimal; spendAccount: 'REAL' | 'BONUS' }
async function lockWallet(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    userId: string,
): Promise<WalletRow> {
    const rows = await tx.$queryRaw<WalletRow[]>`
        SELECT id, "realBalance", "bonusBalance", "spendAccount" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `
    if (!rows[0]) throw { code: 'USER_NOT_FOUND' }
    return rows[0]
}

async function findExisting(transactionId: string | undefined | null) {
    if (!transactionId) return null
    const providerId = await getAtlasVProviderId()
    return prisma.thirdPartyTransaction.findUnique({
        where: { providerId_transactionId: { providerId, transactionId } },
    })
}

async function currentBalance(userId: string): Promise<Decimal> {
    const wallet = await prisma.wallet.findUnique({ where: { userId } })
    if (!wallet) return new Decimal(0)
    return wallet.spendAccount === 'BONUS' ? new Decimal(wallet.bonusBalance) : new Decimal(wallet.realBalance)
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class AtlasVWalletService {
    static async getAccount(params: AccountParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return fail()
        const balance = await currentBalance(user.id)
        return { player_id: params.player_id, balance: Number(balance.toFixed(2)) }
    }

    static async processBet(params: BetParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return errFail(ATLASV_ERROR.PLAYER_BLOCKED)

        const existing = await findExisting(params.transaction_id)
        if (existing) {
            if (existing.status === ThirdPartyTxStatus.FAILED) return errFail(ATLASV_ERROR.INSUFFICIENT_FUNDS)
            const balance = await currentBalance(user.id)
            return { player_id: params.player_id, balance: Number(balance.toFixed(2)), error: null }
        }

        try {
            const balanceAfter = await prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, user.id)
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const totalBefore = realBefore.plus(bonusBefore)
                const betAmount = new Decimal(params.amount).abs()

                let newReal = realBefore
                let newBonus = bonusBefore
                let bonusExpiresAtSpend: Date | null = null

                if (wallet.spendAccount === 'BONUS') {
                    if (bonusBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }
                    const spendResult = await BonusService.spend(tx, user.id, betAmount)
                    newBonus = spendResult.bonusBalanceAfter
                    bonusExpiresAtSpend = spendResult.soonestExpiryConsumed
                } else {
                    if (realBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }
                    newReal = realBefore.minus(betAmount)
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                }
                const newTotal = newReal.plus(newBonus)

                const providerId = await getAtlasVProviderId()
                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId, userId: user.id, transactionId: params.transaction_id,
                        roundId: params.round_id, gameCode: params.game_code,
                        type: ThirdPartyTxType.BET, status: ThirdPartyTxStatus.COMPLETED,
                        betAmount, amount: betAmount.negated(),
                        balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                    },
                })
                await tx.transaction.create({
                    data: {
                        userId: user.id, type: TransactionType.TP_BET, amount: betAmount,
                        status: PaymentStatus.APPROVED,
                        note: `Atlas-V bet: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                        referenceId: params.transaction_id,
                        balanceBefore: totalBefore, balanceAfter: newTotal,
                        bonusBalanceBefore: bonusBefore, bonusBalanceAfter: newBonus, bonusExpiresAtSpend,
                    },
                })
                return wallet.spendAccount === 'BONUS' ? newBonus : newReal
            })

            emitProviderBet(user.id, {
                providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null,
                betId: params.transaction_id, amount: Number(params.amount), spendAccount: 'REAL',
            })
            return { player_id: params.player_id, balance: Number(balanceAfter.toFixed(2)), error: null }
        } catch (e: any) {
            if (e?.code === 'BALANCE_NOT_ENOUGH' || e?.name === 'InsufficientBonusBalanceError') {
                try {
                    const providerId = await getAtlasVProviderId()
                    const current = await currentBalance(user.id)
                    await prisma.thirdPartyTransaction.create({
                        data: {
                            providerId, userId: user.id, transactionId: params.transaction_id,
                            roundId: params.round_id, gameCode: params.game_code,
                            type: ThirdPartyTxType.BET, status: ThirdPartyTxStatus.FAILED,
                            betAmount: new Decimal(params.amount).abs(), amount: new Decimal(0),
                            balanceBefore: current, balanceAfter: current,
                        },
                    })
                } catch { /* ignore duplicate */ }
                return errFail(ATLASV_ERROR.INSUFFICIENT_FUNDS)
            }
            if (e?.code) return errFail(ATLASV_ERROR.SERVICE_ERROR)
            throw e
        }
    }

    static async processRollback(params: RollbackParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return errFail(ATLASV_ERROR.PLAYER_BLOCKED)

        const cancelTxId = `rollback:${params.bet_transaction_id}`
        // Note: a replayed request always reports success here, even if the
        // original attempt found no matching bet (that attempt still writes an
        // audit row under cancelTxId with amount 0) — a narrow, known gap, not
        // worth extra state to close given how rarely a not-found rollback gets
        // retried verbatim.
        const existing = await findExisting(cancelTxId)
        if (existing) return { success: true, error: null }

        const providerId = await getAtlasVProviderId()

        const wasRefunded = await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)

            const originalBet = await tx.thirdPartyTransaction.findUnique({
                where: { providerId_transactionId: { providerId, transactionId: params.bet_transaction_id } },
            })

            const refundable =
                !!originalBet &&
                originalBet.type === ThirdPartyTxType.BET &&
                originalBet.status === ThirdPartyTxStatus.COMPLETED &&
                originalBet.rawResponse == null

            if (!refundable) {
                getLogger().warn(
                    {
                        component: 'atlasv-fraud-flag', playerId: maskAccount(params.player_id),
                        round: params.round_id, betRef: params.bet_transaction_id,
                        found: !!originalBet, status: originalBet?.status,
                    },
                    '[atlasv-fraud-flag] rollback with no matching completed bet — not crediting',
                )
            }

            const delta = refundable ? new Decimal(originalBet!.betAmount ?? originalBet!.amount).abs() : new Decimal(0)

            let realDelta = delta
            let bonusDelta = new Decimal(0)
            let restoreExpiry: Date | null = null
            if (refundable && delta.greaterThan(0)) {
                const betTxn = await tx.transaction.findFirst({
                    where: { userId: user.id, type: TransactionType.TP_BET, referenceId: originalBet!.transactionId },
                    select: { bonusBalanceBefore: true, bonusBalanceAfter: true, bonusExpiresAtSpend: true },
                })
                if (betTxn) {
                    const bonusSpent = new Decimal(betTxn.bonusBalanceBefore ?? 0).minus(new Decimal(betTxn.bonusBalanceAfter ?? 0))
                    if (bonusSpent.greaterThan(0)) {
                        bonusDelta = Decimal.min(bonusSpent, delta)
                        realDelta = delta.minus(bonusDelta)
                        restoreExpiry = betTxn.bonusExpiresAtSpend ?? null
                    }
                }
            }

            const newReal = realBefore.plus(realDelta)
            let newBonus = bonusBefore

            if (delta.greaterThan(0)) {
                if (realDelta.greaterThan(0)) {
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                }
                if (bonusDelta.greaterThan(0)) {
                    const restoreResult = await BonusService.restore(tx, user.id, bonusDelta, restoreExpiry)
                    newBonus = restoreResult.bonusBalanceAfter
                }
                await tx.thirdPartyTransaction.update({
                    where: { id: originalBet!.id },
                    data: { status: ThirdPartyTxStatus.ROLLED_BACK },
                })
            }

            const newTotal = newReal.plus(newBonus)

            await tx.thirdPartyTransaction.create({
                data: {
                    providerId, userId: user.id, transactionId: cancelTxId,
                    roundId: params.round_id, gameCode: params.game_code,
                    type: ThirdPartyTxType.ROLLBACK, status: ThirdPartyTxStatus.COMPLETED,
                    amount: delta, balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                },
            })

            if (delta.greaterThan(0)) {
                await tx.transaction.create({
                    data: {
                        userId: user.id, type: TransactionType.TP_ROLLBACK, amount: delta,
                        status: PaymentStatus.APPROVED,
                        note: `Atlas-V rollback: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                        referenceId: cancelTxId, balanceBefore: totalBefore, balanceAfter: newTotal,
                        bonusBalanceBefore: bonusBefore, bonusBalanceAfter: newBonus,
                    },
                })
            }

            return refundable
        })

        if (!wasRefunded) return errFail(ATLASV_ERROR.BET_NOT_FOUND)
        return { success: true, error: null }
    }

    static async processBetWin(params: BetWinParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return errFail(ATLASV_ERROR.PLAYER_BLOCKED)

        const existing = await findExisting(params.transaction_id)
        if (existing) {
            const balance = await currentBalance(user.id)
            return { player_id: params.player_id, balance: Number(balance.toFixed(2)), error: null }
        }

        const betAmount = new Decimal(params.betAmount).abs()
        const winAmount = new Decimal(params.winAmount).abs()

        const overAbsolute = MAX_WIN_AMOUNT > 0 && winAmount.greaterThan(MAX_WIN_AMOUNT)
        const overMultiple = MAX_WIN_MULTIPLE > 0 && betAmount.greaterThan(0) && winAmount.greaterThan(betAmount.times(MAX_WIN_MULTIPLE))
        if (overAbsolute || overMultiple) {
            getLogger().warn(
                {
                    component: 'atlasv-fraud-flag', playerId: maskAccount(params.player_id),
                    round: params.round_id, betAmount: betAmount.toNumber(), winAmount: winAmount.toNumber(),
                },
                '[atlasv-fraud-flag] betwin failed validation guard',
            )
            return errFail(ATLASV_ERROR.SERVICE_ERROR)
        }

        try {
            const balanceAfter = await prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, user.id)
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const totalBefore = realBefore.plus(bonusBefore)

                let newBonus = bonusBefore
                let bonusExpiresAtSpend: Date | null = null

                // A win always credits REAL balance — bonus wagers convert to
                // withdrawable real money on a win, they don't replenish the
                // bonus pot. Only the bet leg draws from BONUS when selected.
                if (wallet.spendAccount === 'BONUS') {
                    if (bonusBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }
                    const spendResult = await BonusService.spend(tx, user.id, betAmount)
                    newBonus = spendResult.bonusBalanceAfter
                    bonusExpiresAtSpend = spendResult.soonestExpiryConsumed
                } else {
                    if (realBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }
                }
                const newReal = (wallet.spendAccount === 'BONUS' ? realBefore : realBefore.minus(betAmount)).plus(winAmount)
                await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })

                const newTotal = newReal.plus(newBonus)
                const providerId = await getAtlasVProviderId()
                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId, userId: user.id, transactionId: params.transaction_id,
                        roundId: params.round_id, gameCode: params.game_code,
                        type: ThirdPartyTxType.BET_RESULT, status: ThirdPartyTxStatus.COMPLETED,
                        betAmount, winAmount, amount: winAmount.minus(betAmount),
                        balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                    },
                })
                await tx.transaction.create({
                    data: {
                        userId: user.id, type: TransactionType.TP_WIN, amount: winAmount.minus(betAmount),
                        status: PaymentStatus.APPROVED,
                        note: `Atlas-V betwin: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                        referenceId: params.transaction_id,
                        balanceBefore: totalBefore, balanceAfter: newTotal,
                        bonusBalanceBefore: bonusBefore, bonusBalanceAfter: newBonus, bonusExpiresAtSpend,
                    },
                })
                return wallet.spendAccount === 'BONUS' ? newBonus : newReal
            })

            emitProviderBet(user.id, { providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null, betId: params.transaction_id, amount: betAmount.toNumber(), spendAccount: 'REAL' })
            emitProviderWin(user.id, { providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null, betId: params.transaction_id, amount: winAmount.toNumber(), roundStake: betAmount.toNumber() })

            return { player_id: params.player_id, balance: Number(balanceAfter.toFixed(2)), error: null }
        } catch (e: any) {
            if (e?.code === 'BALANCE_NOT_ENOUGH' || e?.name === 'InsufficientBonusBalanceError') return errFail(ATLASV_ERROR.INSUFFICIENT_FUNDS)
            if (e?.code) return errFail(ATLASV_ERROR.SERVICE_ERROR)
            throw e
        }
    }

    static async processResult(params: ResultParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return errFail(ATLASV_ERROR.PLAYER_BLOCKED)

        const existing = await findExisting(params.transaction_id)
        if (existing) return { success: true, error: null }

        const providerId = await getAtlasVProviderId()

        const outcome = await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)

            // Re-read the original bet under the wallet lock so a concurrent
            // rollback (or a second result call) cannot race past this check —
            // same TOCTOU-safety as processRollback's originalBet re-read.
            const priorBet = await tx.thirdPartyTransaction.findUnique({
                where: { providerId_transactionId: { providerId, transactionId: params.bet_transaction_id } },
            })
            const creditable =
                !!priorBet &&
                priorBet.type === ThirdPartyTxType.BET &&
                priorBet.status === ThirdPartyTxStatus.COMPLETED &&
                priorBet.rawResponse == null

            if (!creditable) {
                getLogger().warn(
                    { component: 'atlasv-fraud-flag', playerId: maskAccount(params.player_id), round: params.round_id, betRef: params.bet_transaction_id },
                    '[atlasv-fraud-flag] result with no matching completed bet — not crediting',
                )
                return { errorCode: ATLASV_ERROR.BET_NOT_FOUND } as const
            }

            const winAmount = new Decimal(params.amount).abs()
            const betAmount = new Decimal(priorBet!.betAmount ?? priorBet!.amount).abs()

            const overAbsolute = MAX_WIN_AMOUNT > 0 && winAmount.greaterThan(MAX_WIN_AMOUNT)
            const overMultiple = MAX_WIN_MULTIPLE > 0 && betAmount.greaterThan(0) && winAmount.greaterThan(betAmount.times(MAX_WIN_MULTIPLE))
            if (overAbsolute || overMultiple) {
                getLogger().warn(
                    { component: 'atlasv-fraud-flag', playerId: maskAccount(params.player_id), round: params.round_id, winAmount: winAmount.toNumber(), betAmount: betAmount.toNumber() },
                    '[atlasv-fraud-flag] result failed validation guard',
                )
                return { errorCode: ATLASV_ERROR.SERVICE_ERROR } as const
            }

            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)
            const newReal = realBefore.plus(winAmount)
            const newTotal = newReal.plus(bonusBefore)

            await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
            await tx.thirdPartyTransaction.update({
                where: { id: priorBet!.id },
                data: { rawResponse: { settledBy: params.transaction_id } },
            })
            await tx.thirdPartyTransaction.create({
                data: {
                    providerId, userId: user.id, transactionId: params.transaction_id,
                    roundId: params.round_id, gameCode: params.game_code,
                    type: ThirdPartyTxType.BET_RESULT, status: ThirdPartyTxStatus.COMPLETED,
                    winAmount, amount: winAmount,
                    balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                },
            })
            await tx.transaction.create({
                data: {
                    userId: user.id, type: TransactionType.TP_WIN, amount: winAmount,
                    status: PaymentStatus.APPROVED,
                    note: `Atlas-V result: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                    referenceId: params.transaction_id,
                    balanceBefore: totalBefore, balanceAfter: newTotal,
                    bonusBalanceBefore: bonusBefore, bonusBalanceAfter: bonusBefore,
                },
            })

            return { errorCode: null, winAmount: winAmount.toNumber(), betAmount: betAmount.toNumber() } as const
        })

        if (outcome.errorCode) return errFail(outcome.errorCode)

        emitProviderWin(user.id, {
            providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null,
            betId: params.bet_transaction_id, amount: outcome.winAmount, roundStake: outcome.betAmount,
        })
        return { success: true, error: null }
    }

    static async processFreespinResult(params: FreespinResultParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return fail()

        const existing = await findExisting(params.transaction_id)
        if (existing) return { success: true }

        const winAmount = new Decimal(params.amount).abs()
        if (MAX_WIN_AMOUNT > 0 && winAmount.greaterThan(MAX_WIN_AMOUNT)) {
            getLogger().warn(
                { component: 'atlasv-fraud-flag', playerId: maskAccount(params.player_id), round: params.round_id, winAmount: winAmount.toNumber() },
                '[atlasv-fraud-flag] freespin result exceeds MAX_WIN_AMOUNT',
            )
            return fail()
        }

        const providerId = await getAtlasVProviderId()
        await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)
            const newReal = realBefore.plus(winAmount)
            const newTotal = newReal.plus(bonusBefore)

            await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
            await tx.thirdPartyTransaction.create({
                data: {
                    providerId, userId: user.id, transactionId: params.transaction_id,
                    roundId: params.round_id, gameCode: params.game_code,
                    type: ThirdPartyTxType.BET_RESULT, status: ThirdPartyTxStatus.COMPLETED,
                    winAmount, amount: winAmount,
                    balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                },
            })
            await tx.transaction.create({
                data: {
                    userId: user.id, type: TransactionType.TP_WIN, amount: winAmount,
                    status: PaymentStatus.APPROVED,
                    note: `Atlas-V freespin win: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                    referenceId: params.transaction_id,
                    balanceBefore: totalBefore, balanceAfter: newTotal,
                    bonusBalanceBefore: bonusBefore, bonusBalanceAfter: bonusBefore,
                },
            })
        })

        emitProviderWin(user.id, { providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null, betId: params.transaction_id, amount: winAmount.toNumber(), roundStake: 0 })
        return { success: true }
    }

    // No MAX_WIN_AMOUNT cap here, deliberately — jackpots are inherently large
    // by design; the cap exists to catch forged/absurd bet-tied wins, not to
    // second-guess a legitimate jackpot payout.
    static async processJackpot(params: JackpotParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return fail()

        const existing = await findExisting(params.transaction_id)
        if (existing) return { success: true }

        const winAmount = new Decimal(params.amount).abs()
        const providerId = await getAtlasVProviderId()
        await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)
            const newReal = realBefore.plus(winAmount)
            const newTotal = newReal.plus(bonusBefore)

            await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
            await tx.thirdPartyTransaction.create({
                data: {
                    providerId, userId: user.id, transactionId: params.transaction_id,
                    roundId: params.round_id, gameCode: params.game_code,
                    type: ThirdPartyTxType.BET_RESULT, status: ThirdPartyTxStatus.COMPLETED,
                    winAmount, amount: winAmount,
                    balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                },
            })
            await tx.transaction.create({
                data: {
                    userId: user.id, type: TransactionType.TP_WIN, amount: winAmount,
                    status: PaymentStatus.APPROVED,
                    note: `Atlas-V jackpot: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                    referenceId: params.transaction_id,
                    balanceBefore: totalBefore, balanceAfter: newTotal,
                    bonusBalanceBefore: bonusBefore, bonusBalanceAfter: bonusBefore,
                },
            })
        })

        emitProviderWin(user.id, { providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null, betId: params.transaction_id, amount: winAmount.toNumber(), roundStake: 0 })
        return { success: true }
    }

    /** Dispatch a callback action to the matching wallet handler. */
    static async dispatch(action: AtlasVAction | undefined, d: Record<string, any>): Promise<AtlasVResponse> {
        const startedAt = Date.now()
        const res = await AtlasVWalletService.route(action, d)
        getLogger().info(
            { component: 'atlasv-wallet', action, playerId: maskAccount(d?.player_id), result: res, latencyMs: Date.now() - startedAt },
            '[atlasv-wallet] action handled',
        )
        return res
    }

    private static async route(action: AtlasVAction | undefined, d: Record<string, any>): Promise<AtlasVResponse> {
        switch (action) {
            case 'account':
                return AtlasVWalletService.getAccount({ player_id: d.player_id })
            case 'bet':
                return AtlasVWalletService.processBet({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    transaction_id: d.transaction_id, amount: d.amount,
                })
            case 'betwin':
                return AtlasVWalletService.processBetWin({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    transaction_id: d.transaction_id, betAmount: d.betAmount, winAmount: d.winAmount,
                })
            case 'result':
                return AtlasVWalletService.processResult({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    transaction_id: d.transaction_id, bet_transaction_id: d.bet_transaction_id, amount: d.amount,
                })
            case 'rollback':
                return AtlasVWalletService.processRollback({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    bet_transaction_id: d.bet_transaction_id,
                })
            case 'freespin':
                return AtlasVWalletService.processFreespinResult({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    transaction_id: d.transaction_id, amount: d.amount,
                })
            case 'jackpot':
                return AtlasVWalletService.processJackpot({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    transaction_id: d.transaction_id, amount: d.amount,
                })
            default:
                return fail()
        }
    }
}
