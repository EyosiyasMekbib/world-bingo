import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
import { getLogger } from '../lib/log-context.js'
import { maskAccount } from '../lib/logger.js'
import { TransactionType, PaymentStatus, ThirdPartyTxType, ThirdPartyTxStatus } from '@world-bingo/shared-types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PalaceResponse {
    result: number
    status: string
    data: object | null
}

interface BetParams {
    trans_guid: string
    account: string
    gplay_id: string
    round_id: string
    game_code: string
    amount: number
}

interface WinParams extends BetParams {
    type: number
}

interface CancelParams extends BetParams {
    cancle_trans_guid: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROVIDER_CODE = 'palace'
export const CURRENCY = process.env.PALACE_CURRENCY ?? 'ETB'
const USER_CACHE_TTL = 3600

// ─── Win-credit guards (see fix R1) ─────────────────────────────────────────────
// Palace does not sign callback bodies, so a leaked callback token lets an attacker
// POST an arbitrary `win` amount. We cannot fully validate the outcome without a
// provider signature (that + reconciliation is tracked separately), but we CAN:
//   1. tie every win to a real prior BET for the same round (blocks standalone forges), and
//   2. reject absurd wins via configurable caps (blocks the impossible without
//      breaking legitimate high-multiple jackpots).
// Caps default to generous ceilings; set the env vars lower to tighten. Set the
// require-bet flag to reject (rather than only flag) wins with no matching bet.
const MAX_WIN_AMOUNT = Number(process.env.PALACE_MAX_WIN_AMOUNT ?? 1_000_000)
const MAX_WIN_MULTIPLE = Number(process.env.PALACE_MAX_WIN_MULTIPLE ?? 20_000)
const REQUIRE_BET_FOR_WIN = process.env.PALACE_REQUIRE_BET_FOR_WIN === 'true'

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _providerId: string | null = null

async function getPalaceProviderId(): Promise<string> {
    if (_providerId) return _providerId
    const provider = await prisma.gameProvider.findUnique({ where: { code: PROVIDER_CODE } })
    if (!provider) throw new Error(`Provider '${PROVIDER_CODE}' not seeded in DB`)
    _providerId = provider.id
    return _providerId
}

function ok(data: object): PalaceResponse {
    return { result: 0, status: 'OK', data }
}

function palaceErr(code: number, status: string): PalaceResponse {
    return { result: code, status, data: null }
}

async function resolveUser(account: string): Promise<{ id: string; isActive: boolean } | null> {
    const cacheKey = `tp:user:${account}`
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    let user: { id: string; isActive: boolean } | null = null

    if (/^[0-9a-f]{32}$/i.test(account)) {
        const id = `${account.slice(0, 8)}-${account.slice(8, 12)}-${account.slice(12, 16)}-${account.slice(16, 20)}-${account.slice(20)}`
        user = await prisma.user.findUnique({ where: { id }, select: { id: true, isActive: true } })
    } else {
        user = await prisma.user.findUnique({ where: { username: account }, select: { id: true, isActive: true } })
    }

    if (user) await redis.setex(cacheKey, USER_CACHE_TTL, JSON.stringify(user))
    getLogger().info(
        { component: 'resolve-user', account: maskAccount(account), matched: !!user },
        '[resolve-user] account resolution',
    )
    return user
}

type WalletRow = { id: string; realBalance: Decimal; bonusBalance: Decimal }

async function lockWallet(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    userId: string,
): Promise<WalletRow> {
    const rows = await tx.$queryRaw<WalletRow[]>`
        SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `
    if (!rows[0]) throw { code: 'USER_NOT_FOUND' }
    return rows[0]
}

async function findExisting(transactionId: string | undefined | null) {
    // A missing transactionId would make findUnique throw (composite key incomplete).
    // Treat it as "no existing record" so callers can decide how to handle it.
    if (!transactionId) return null
    const providerId = await getPalaceProviderId()
    return prisma.thirdPartyTransaction.findUnique({
        where: { providerId_transactionId: { providerId, transactionId } },
    })
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class PalaceWalletService {
    // Palace's authenticate callback expects data: { account, balance }.
    static async authenticate(account: string): Promise<PalaceResponse> {
        const user = await resolveUser(account)
        if (!user) return palaceErr(21, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(22, 'USER_INACTIVE')

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        const balance = wallet
            ? new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))
            : new Decimal(0)
        return ok({ account, balance: Number(balance.toFixed(2)) })
    }

    static async getBalance(account: string): Promise<PalaceResponse> {
        const user = await resolveUser(account)
        if (!user) return palaceErr(21, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(22, 'USER_INACTIVE')

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        if (!wallet) return palaceErr(21, 'USER_NOT_FOUND')

        const balance = new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))
        return ok({ balance: Number(balance.toFixed(2)) })
    }

    static async processBet(params: BetParams): Promise<PalaceResponse> {
        const user = await resolveUser(params.account)
        if (!user) return palaceErr(21, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(22, 'USER_INACTIVE')

        const existing = await findExisting(params.trans_guid)
        if (existing) {
            if (existing.status === ThirdPartyTxStatus.FAILED) return palaceErr(31, 'BALANCE_NOT_ENOUGH')
            return ok({ balance: Number(new Decimal(existing.balanceAfter).toFixed(2)) })
        }

        try {
            const balanceAfter = await prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, user.id)
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const totalBefore = realBefore.plus(bonusBefore)
                const betAmount = new Decimal(params.amount).abs()

                if (totalBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }

                let newReal = realBefore
                let newBonus = bonusBefore
                if (realBefore.greaterThanOrEqualTo(betAmount)) {
                    newReal = realBefore.minus(betAmount)
                } else {
                    newReal = new Decimal(0)
                    newBonus = bonusBefore.minus(betAmount.minus(realBefore))
                }
                const newTotal = newReal.plus(newBonus)

                await tx.wallet.update({
                    where: { userId: user.id },
                    data: { realBalance: newReal, bonusBalance: newBonus },
                })

                const providerId = await getPalaceProviderId()
                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId,
                        userId: user.id,
                        transactionId: params.trans_guid,
                        betId: params.gplay_id,
                        roundId: params.round_id,
                        gameCode: params.game_code,
                        type: ThirdPartyTxType.BET,
                        status: ThirdPartyTxStatus.COMPLETED,
                        betAmount,
                        amount: betAmount.negated(),
                        balanceBefore: totalBefore,
                        balanceAfter: newTotal,
                        rawRequest: params as any,
                    },
                })

                await tx.transaction.create({
                    data: {
                        userId: user.id,
                        type: TransactionType.TP_BET,
                        amount: betAmount,
                        status: PaymentStatus.APPROVED,
                        note: `Palace bet: ${params.game_code} round ${params.round_id}`,
                        referenceId: params.trans_guid,
                        balanceBefore: totalBefore,
                        balanceAfter: newTotal,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: newBonus,
                    },
                })

                return newTotal
            })

            return ok({ balance: Number(balanceAfter.toFixed(2)) })
        } catch (e: any) {
            if (e?.code === 'BALANCE_NOT_ENOUGH') {
                const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
                const current = wallet
                    ? new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))
                    : new Decimal(0)
                try {
                    const providerId = await getPalaceProviderId()
                    await prisma.thirdPartyTransaction.create({
                        data: {
                            providerId,
                            userId: user.id,
                            transactionId: params.trans_guid,
                            betId: params.gplay_id,
                            roundId: params.round_id,
                            gameCode: params.game_code,
                            type: ThirdPartyTxType.BET,
                            status: ThirdPartyTxStatus.FAILED,
                            betAmount: new Decimal(params.amount).abs(),
                            amount: new Decimal(0),
                            balanceBefore: current,
                            balanceAfter: current,
                        },
                    })
                } catch { /* ignore duplicate */ }
                return { result: 31, status: 'BALANCE_NOT_ENOUGH', data: { balance: Number(current.toFixed(2)) } }
            }
            if (e?.code) return palaceErr(1001, 'INTERNAL_SERVER_ERROR')
            throw e
        }
    }

    static async processWin(params: WinParams): Promise<PalaceResponse> {
        const user = await resolveUser(params.account)
        if (!user) return palaceErr(21, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(22, 'USER_INACTIVE')

        const existing = await findExisting(params.trans_guid)
        if (existing) return ok({ balance: Number(new Decimal(existing.balanceAfter).toFixed(2)) })

        const winAmount = new Decimal(params.amount).abs()

        // ── R1 guard: tie the win to a real prior bet and reject absurd amounts ──
        const providerIdForCheck = await getPalaceProviderId()
        const priorBets = await prisma.thirdPartyTransaction.aggregate({
            where: {
                providerId: providerIdForCheck,
                userId: user.id,
                roundId: params.round_id,
                type: ThirdPartyTxType.BET,
                status: ThirdPartyTxStatus.COMPLETED,
            },
            _sum: { betAmount: true },
            _count: true,
        })
        const roundStake = new Decimal(priorBets._sum.betAmount ?? 0)
        const hasBet = priorBets._count > 0

        const overAbsolute = MAX_WIN_AMOUNT > 0 && winAmount.greaterThan(MAX_WIN_AMOUNT)
        const overMultiple =
            MAX_WIN_MULTIPLE > 0 && roundStake.greaterThan(0) && winAmount.greaterThan(roundStake.times(MAX_WIN_MULTIPLE))

        if (!hasBet || overAbsolute || overMultiple) {
            getLogger().warn(
                {
                    component: 'palace-fraud-flag',
                    account: maskAccount(params.account),
                    round: params.round_id,
                    game: params.game_code,
                    winAmount: winAmount.toNumber(),
                    roundStake: roundStake.toNumber(),
                    hasBet,
                    overAbsolute,
                    overMultiple,
                    transGuid: params.trans_guid,
                },
                '[palace-fraud-flag] win failed validation guard',
            )
            // Absurd amounts are always rejected. A missing prior bet is rejected only
            // when REQUIRE_BET_FOR_WIN is enabled, so operators can turn it on once
            // they have confirmed bet-recording is reliable, without risking payout
            // desync in the meantime.
            if (overAbsolute || overMultiple || (!hasBet && REQUIRE_BET_FOR_WIN)) {
                return palaceErr(42, 'TRANS_ID_NOT_FOUND')
            }
        }

        const balanceAfter = await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)
            const newReal = realBefore.plus(winAmount)
            const newTotal = newReal.plus(bonusBefore)

            await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })

            const providerId = await getPalaceProviderId()
            await tx.thirdPartyTransaction.create({
                data: {
                    providerId,
                    userId: user.id,
                    transactionId: params.trans_guid,
                    betId: params.gplay_id,
                    roundId: params.round_id,
                    gameCode: params.game_code,
                    type: ThirdPartyTxType.BET_RESULT,
                    status: ThirdPartyTxStatus.COMPLETED,
                    winAmount,
                    amount: winAmount,
                    balanceBefore: totalBefore,
                    balanceAfter: newTotal,
                    rawRequest: params as any,
                },
            })

            await tx.transaction.create({
                data: {
                    userId: user.id,
                    type: TransactionType.TP_WIN,
                    amount: winAmount,
                    status: PaymentStatus.APPROVED,
                    note: `Palace win: ${params.game_code} round ${params.round_id}`,
                    referenceId: params.trans_guid,
                    balanceBefore: totalBefore,
                    balanceAfter: newTotal,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusBefore,
                },
            })

            return newTotal
        })

        return ok({ balance: Number(balanceAfter.toFixed(2)) })
    }

    static async processCancel(params: CancelParams): Promise<PalaceResponse> {
        const user = await resolveUser(params.account)
        if (!user) return palaceErr(21, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(22, 'USER_INACTIVE')

        // Idempotency key for this rollback. Prefer the cancel's own trans_guid;
        // if Palace omits it, derive a stable key from the original bet ref so the
        // ledger row can still be written and retries stay idempotent. Only reject
        // if no identifier is present at all.
        const cancelTxId =
            params.trans_guid ||
            (params.cancle_trans_guid ? `rollback:${params.cancle_trans_guid}` : null)
        if (!cancelTxId) return palaceErr(1002, 'INVALID_REQUEST')

        const existing = await findExisting(cancelTxId)
        if (existing) return ok({ balance: Number(new Decimal(existing.balanceAfter).toFixed(2)) })

        const providerId = await getPalaceProviderId()

        // ── R5 guard: only ever refund a bet we actually recorded and debited. ──
        // The old code credited `params.amount` (attacker-controlled) when the original
        // bet could not be found, minting money; and never marked the bet rolled-back,
        // so fresh cancel guids could refund the same stake repeatedly. Now: require a
        // real prior BET, refund exactly its recorded stake, and settle it once.
        const balanceAfter = await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)

            // Re-read the original bet under the wallet lock so two concurrent cancels
            // cannot both refund it (TOCTOU-safe).
            const originalBet = params.cancle_trans_guid
                ? await tx.thirdPartyTransaction.findUnique({
                      where: { providerId_transactionId: { providerId, transactionId: params.cancle_trans_guid } },
                  })
                : null

            const refundable =
                !!originalBet &&
                originalBet.type === ThirdPartyTxType.BET &&
                originalBet.status === ThirdPartyTxStatus.COMPLETED

            // No verified debit to reverse → credit nothing. Record a zero-amount
            // rollback row so retries short-circuit via findExisting, and never mint.
            const delta = refundable ? new Decimal(originalBet!.betAmount ?? originalBet!.amount).abs() : new Decimal(0)

            if (!refundable) {
                getLogger().warn(
                    {
                        component: 'palace-fraud-flag',
                        account: maskAccount(params.account),
                        round: params.round_id,
                        cancelRef: params.cancle_trans_guid,
                        found: !!originalBet,
                        status: originalBet?.status,
                        requestedAmount: new Decimal(params.amount).abs().toNumber(),
                    },
                    '[palace-fraud-flag] cancel with no matching completed bet — not crediting',
                )
            }

            const newReal = realBefore.plus(delta)
            const newTotal = newReal.plus(bonusBefore)

            if (delta.greaterThan(0)) {
                await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                // Settle the original bet so it cannot be cancelled again.
                await tx.thirdPartyTransaction.update({
                    where: { id: originalBet!.id },
                    data: { status: ThirdPartyTxStatus.ROLLED_BACK },
                })
            }

            await tx.thirdPartyTransaction.create({
                data: {
                    providerId,
                    userId: user.id,
                    transactionId: cancelTxId,
                    betId: params.gplay_id,
                    roundId: params.round_id,
                    gameCode: params.game_code,
                    type: ThirdPartyTxType.ROLLBACK,
                    status: ThirdPartyTxStatus.COMPLETED,
                    amount: delta,
                    balanceBefore: totalBefore,
                    balanceAfter: newTotal,
                    rawRequest: params as any,
                },
            })

            if (delta.greaterThan(0)) {
                await tx.transaction.create({
                    data: {
                        userId: user.id,
                        type: TransactionType.TP_ROLLBACK,
                        amount: delta,
                        status: PaymentStatus.APPROVED,
                        note: `Palace cancel: ${params.game_code} round ${params.round_id}`,
                        referenceId: cancelTxId,
                        balanceBefore: totalBefore,
                        balanceAfter: newTotal,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: bonusBefore,
                    },
                })
            }

            return newTotal
        })

        return ok({ balance: Number(balanceAfter.toFixed(2)) })
    }

    /** Dispatch a provider callback command to the matching wallet handler. */
    static async dispatch(command: string | undefined, d: Record<string, any>): Promise<PalaceResponse> {
        const startedAt = Date.now()
        const res = await PalaceWalletService.route(command, d)
        getLogger().info(
            {
                component: 'palace-wallet',
                command,
                account: maskAccount(d?.account),
                resultCode: res.result,
                status: res.status,
                latencyMs: Date.now() - startedAt,
            },
            '[palace-wallet] command handled',
        )
        return res
    }

    private static async route(command: string | undefined, d: Record<string, any>): Promise<PalaceResponse> {
        switch (command) {
            case 'authenticate':
                return PalaceWalletService.authenticate(d.account)
            case 'balance':
                return PalaceWalletService.getBalance(d.account)
            case 'bet':
                return PalaceWalletService.processBet({
                    trans_guid: d.trans_guid,
                    account: d.account,
                    gplay_id: d.gplay_id,
                    round_id: d.round_id,
                    game_code: d.game_code,
                    amount: d.amount,
                })
            case 'win':
                return PalaceWalletService.processWin({
                    trans_guid: d.trans_guid,
                    account: d.account,
                    gplay_id: d.gplay_id,
                    round_id: d.round_id,
                    game_code: d.game_code,
                    amount: d.amount,
                    type: d.type ?? 2,
                })
            case 'cancel':
                return PalaceWalletService.processCancel({
                    trans_guid: d.trans_guid,
                    account: d.account,
                    gplay_id: d.gplay_id,
                    round_id: d.round_id,
                    game_code: d.game_code,
                    amount: d.amount ?? 0,
                    cancle_trans_guid: d.cancel_trans_guid ?? d.cancle_trans_guid,
                })
            case 'status':
                return PalaceWalletService.getStatus(d.account, d.trans_guid ?? d.trans_id ?? '')
            default:
                return { result: 1006, status: 'COMMAND_NOT_FOUND', data: null }
        }
    }

    static async getStatus(account: string, transGuid: string): Promise<PalaceResponse> {
        // Check 21: user must exist
        const user = await resolveUser(account)
        if (!user) return palaceErr(21, 'USER_NOT_FOUND')

        const providerId = await getPalaceProviderId()
        // Check 42: transaction must exist
        const tx = transGuid
            ? await prisma.thirdPartyTransaction.findUnique({
                  where: { providerId_transactionId: { providerId, transactionId: transGuid } },
              })
            : null
        if (!tx) return palaceErr(42, 'TRANS_ID_NOT_FOUND')

        // The palace doc conflicts on the status response shape: the spec table says
        // data:{ balance } while the saved example shows { account, trans_guid,
        // trans_status }. Return both so either check passes.
        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        const balance = wallet
            ? new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))
            : new Decimal(0)

        return ok({
            account,
            trans_guid: transGuid,
            trans_status: 'OK',
            balance: Number(balance.toFixed(2)),
        })
    }
}
