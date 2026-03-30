import type { FastifyPluginAsync } from 'fastify'
import { verifyGaseaSignature } from '../../gateways/game-provider/signature.middleware.js'
import { ThirdPartyWalletService } from '../../services/third-party-wallet.service.js'

/**
 * GASea wallet callback routes.
 * All mounted under /v1/aggregator/wallet (configured in index.ts).
 * All return HTTP 200 — GASea interprets non-200 as a network failure.
 * No JWT auth — validated via HMAC-SHA256 X-Signature header instead.
 */
const aggregatorWalletRoutes: FastifyPluginAsync = async (fastify) => {
    // ── Balance ────────────────────────────────────────────────────────────────
    fastify.post('/balance', {
        preHandler: [verifyGaseaSignature],
        handler: async (req) => {
            const body = req.body as {
                traceId: string
                username: string
                currency: string
                token?: string
            }
            return ThirdPartyWalletService.getBalance({
                traceId: body.traceId,
                username: body.username,
                currency: body.currency,
                token: body.token,
            })
        },
    })

    // ── Bet ────────────────────────────────────────────────────────────────────
    fastify.post('/bet', {
        preHandler: [verifyGaseaSignature],
        handler: async (req) => {
            const body = req.body as {
                traceId: string
                username: string
                transactionId: string
                betId: string
                externalTransactionId?: string
                amount: number
                currency: string
                token?: string
                gameCode: string
                roundId: string
                timestamp: number
            }
            return ThirdPartyWalletService.processBet({
                traceId: body.traceId,
                username: body.username,
                transactionId: body.transactionId,
                betId: body.betId,
                externalTransactionId: body.externalTransactionId,
                amount: body.amount,
                currency: body.currency,
                token: body.token,
                gameCode: body.gameCode,
                roundId: body.roundId,
                timestamp: body.timestamp,
            })
        },
    })

    // ── Bet Result ─────────────────────────────────────────────────────────────
    fastify.post('/bet_result', {
        preHandler: [verifyGaseaSignature],
        handler: async (req) => {
            const body = req.body as {
                traceId: string
                username: string
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
                currency: string
                token?: string
                gameCode: string
                betTime: number
                settledTime: number
            }
            return ThirdPartyWalletService.processBetResult({
                traceId: body.traceId,
                username: body.username,
                transactionId: body.transactionId,
                betId: body.betId,
                externalTransactionId: body.externalTransactionId,
                roundId: body.roundId,
                betAmount: body.betAmount,
                winAmount: body.winAmount,
                effectiveTurnover: body.effectiveTurnover,
                winLoss: body.winLoss,
                jackpotAmount: body.jackpotAmount,
                resultType: body.resultType,
                isFreespin: body.isFreespin,
                isEndRound: body.isEndRound,
                currency: body.currency,
                token: body.token,
                gameCode: body.gameCode,
                betTime: body.betTime,
                settledTime: body.settledTime,
            })
        },
    })

    // ── Rollback ───────────────────────────────────────────────────────────────
    fastify.post('/rollback', {
        preHandler: [verifyGaseaSignature],
        handler: async (req) => {
            const body = req.body as {
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
            return ThirdPartyWalletService.processRollback({
                traceId: body.traceId,
                transactionId: body.transactionId,
                betId: body.betId,
                externalTransactionId: body.externalTransactionId,
                roundId: body.roundId,
                gameCode: body.gameCode,
                username: body.username,
                currency: body.currency,
                timestamp: body.timestamp,
            })
        },
    })

    // ── Adjustment ─────────────────────────────────────────────────────────────
    fastify.post('/adjustment', {
        preHandler: [verifyGaseaSignature],
        handler: async (req) => {
            const body = req.body as {
                traceId: string
                username: string
                transactionId: string
                externalTransactionId?: string
                roundId: string
                amount: number
                currency: string
                gameCode: string
                timestamp: number
            }
            return ThirdPartyWalletService.processAdjustment({
                traceId: body.traceId,
                username: body.username,
                transactionId: body.transactionId,
                externalTransactionId: body.externalTransactionId,
                roundId: body.roundId,
                amount: body.amount,
                currency: body.currency,
                gameCode: body.gameCode,
                timestamp: body.timestamp,
            })
        },
    })

    // ── Bet Debit ──────────────────────────────────────────────────────────────
    fastify.post('/bet_debit', {
        preHandler: [verifyGaseaSignature],
        handler: async (req) => {
            const body = req.body as {
                traceId: string
                username: string
                transactionId: string
                roundId: string
                takeAll: number
                amount: number
                currency: string
                gameCode: string
                timestamp: number
            }
            return ThirdPartyWalletService.processBetDebit({
                traceId: body.traceId,
                username: body.username,
                transactionId: body.transactionId,
                roundId: body.roundId,
                takeAll: body.takeAll,
                amount: body.amount,
                currency: body.currency,
                gameCode: body.gameCode,
                timestamp: body.timestamp,
            })
        },
    })

    // ── Bet Credit ─────────────────────────────────────────────────────────────
    fastify.post('/bet_credit', {
        preHandler: [verifyGaseaSignature],
        handler: async (req) => {
            const body = req.body as {
                traceId: string
                username: string
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
                currency: string
                token?: string
                gameCode: string
                betTime: number
                settledTime: number
                timestamp: number
            }
            return ThirdPartyWalletService.processBetCredit({
                traceId: body.traceId,
                username: body.username,
                transactionId: body.transactionId,
                betId: body.betId,
                roundId: body.roundId,
                isRefund: body.isRefund,
                amount: body.amount,
                betAmount: body.betAmount,
                winAmount: body.winAmount,
                effectiveTurnover: body.effectiveTurnover,
                winLoss: body.winLoss,
                jackpotAmount: body.jackpotAmount,
                currency: body.currency,
                token: body.token,
                gameCode: body.gameCode,
                betTime: body.betTime,
                settledTime: body.settledTime,
                timestamp: body.timestamp,
            })
        },
    })
}

export default aggregatorWalletRoutes
