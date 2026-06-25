import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
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

        const balanceAfter = await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)
            const winAmount = new Decimal(params.amount).abs()
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

        // Original bet reference may be absent (or sent under an unexpected key) —
        // fall back to the cancel amount rather than crashing on an incomplete key.
        const originalBet = params.cancle_trans_guid
            ? await prisma.thirdPartyTransaction.findUnique({
                  where: { providerId_transactionId: { providerId, transactionId: params.cancle_trans_guid } },
              })
            : null

        const balanceAfter = await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)

            // Per palace docs, a cancel is always a BetCancel(16): "the amount will be
            // returned" — i.e. always credit the cancel amount back to the user. Prefer
            // the original transaction's amount when we can find it, else the cancel amount.
            const delta = originalBet
                ? new Decimal(originalBet.betAmount ?? originalBet.amount).abs()
                : new Decimal(params.amount).abs()

            const newReal = realBefore.plus(delta)
            const newTotal = newReal.plus(bonusBefore)

            await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })

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

            return newTotal
        })

        return ok({ balance: Number(balanceAfter.toFixed(2)) })
    }

    /** Dispatch a provider callback command to the matching wallet handler. */
    static async dispatch(command: string | undefined, d: Record<string, any>): Promise<PalaceResponse> {
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
