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

async function findExisting(transactionId: string) {
    const providerId = await getPalaceProviderId()
    return prisma.thirdPartyTransaction.findUnique({
        where: { providerId_transactionId: { providerId, transactionId } },
    })
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class PalaceWalletService {
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
        if (!user) return palaceErr(2002, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(2002, 'USER_NOT_FOUND')

        const existing = await findExisting(params.trans_guid)
        if (existing) return ok({ balance: Number(new Decimal(existing.balanceAfter).toFixed(2)) })

        const providerId = await getPalaceProviderId()

        const originalBet = await prisma.thirdPartyTransaction.findUnique({
            where: { providerId_transactionId: { providerId, transactionId: params.cancle_trans_guid } },
        })

        const balanceAfter = await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)

            const refundAmount = originalBet
                ? new Decimal(originalBet.betAmount ?? params.amount).abs()
                : new Decimal(params.amount).abs()

            const newReal = realBefore.plus(refundAmount)
            const newTotal = newReal.plus(bonusBefore)

            await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })

            await tx.thirdPartyTransaction.create({
                data: {
                    providerId,
                    userId: user.id,
                    transactionId: params.trans_guid,
                    betId: params.gplay_id,
                    roundId: params.round_id,
                    gameCode: params.game_code,
                    type: ThirdPartyTxType.ROLLBACK,
                    status: ThirdPartyTxStatus.COMPLETED,
                    amount: refundAmount,
                    balanceBefore: totalBefore,
                    balanceAfter: newTotal,
                    rawRequest: params as any,
                },
            })

            await tx.transaction.create({
                data: {
                    userId: user.id,
                    type: TransactionType.TP_ROLLBACK,
                    amount: refundAmount,
                    status: PaymentStatus.APPROVED,
                    note: `Palace cancel: ${params.game_code} round ${params.round_id}`,
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

    static async getStatus(account: string, transGuid: string): Promise<PalaceResponse> {
        const providerId = await getPalaceProviderId()
        const tx = await prisma.thirdPartyTransaction.findUnique({
            where: { providerId_transactionId: { providerId, transactionId: transGuid } },
        })

        return ok({
            account,
            trans_guid: transGuid,
            trans_status: tx ? 'OK' : 'NOT_FOUND',
        })
    }
}
