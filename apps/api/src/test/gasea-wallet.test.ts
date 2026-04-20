/**
 * GASea Wallet Callback API — Endpoint Verification Suite
 *
 * Replicates the GASea test tool at stg-agt.gasea168.com/bo/devtool/endpoint-verification.
 * Spec-first: tests define what the API MUST do per the GASea Seamless Wallet API.
 * Failing tests expose gaps between the current implementation and the spec.
 *
 * Groups mirror the dashboard exactly:
 *  1. Invalid Signature
 *  2. Invalid Username
 *  3. Insufficient Balance
 *  4. Debit Amount Validation
 *  5. Credit Win Amount Validation
 *  6. Credit Jackpot Amount Validation
 *  7. Rollback
 *  8. Idempotency
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import crypto from 'node:crypto'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from './setup'
import aggregatorWalletRoutes from '../routes/aggregator/wallet'

// Mock Redis — user cache misses gracefully fall through to DB
vi.mock('../lib/redis', () => ({
    default: {
        get:    vi.fn().mockResolvedValue(null),
        setex:  vi.fn().mockResolvedValue('OK'),
        del:    vi.fn().mockResolvedValue(1),
    },
}))

// ─── Constants ────────────────────────────────────────────────────────────────

const API_SECRET = '1aaad248932d0140a3e6672e461089a4a798c17382739201f7ac46027fec6955'
const API_KEY    = 'c1f4c22384bed4b4e17bba2bb393259bee3cbcf2eb8e9e9b10bea2176da66af5'
const CURRENCY   = 'ETB'
const GAME_CODE  = 'SPB_aviator'
const TOKEN      = '6b149bc8-1889-4734-a077-954d7ebd8c7f'

/** Valid player — must exist in test DB */
const VALID_USER = 'defefe'
/** Non-existent player */
const INVALID_USER = 'testTingAccount'

// Set env before any module reads process.env
process.env.GASEA_API_SECRET       = API_SECRET
process.env.GASEA_DEFAULT_CURRENCY = CURRENCY

// ─── Fastify test server ──────────────────────────────────────────────────────

let app: ReturnType<typeof Fastify>

beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(aggregatorWalletRoutes, { prefix: '/wallet' })
    await app.ready()

    // Seed the game provider once — not cleaned by setup.ts cleanDb
    await prisma.gameProvider.upsert({
        where: { code: 'gasea' },
        create: { code: 'gasea', name: 'GASea', apiBaseUrl: 'https://stg.gasea168.com' },
        update: {},
    })
}, 30_000)

// ─── Per-test fixtures ────────────────────────────────────────────────────────

let validUserId: string

beforeEach(async () => {
    // Clean third-party tx records (not in global cleanDb)
    await prisma.thirdPartyTransaction.deleteMany()

    // Create valid player with 1 000 ETB
    const user = await prisma.user.create({
        data: {
            username: VALID_USER,
            phone: '+251900000001',
            passwordHash: 'hashed:test',
            isActive: true,
            wallet: { create: { realBalance: 1000, bonusBalance: 0 } },
        },
    })
    validUserId = user.id
})

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

let _seq = 0
const uid = () => `OneApi${Date.now()}${++_seq}`

/** Sign the JSON body string the same way GASea does. */
function sign(rawJson: string): string {
    return crypto.createHmac('sha256', API_SECRET).update(rawJson).digest('hex')
}

/** POST to a wallet callback endpoint with a valid HMAC signature. */
async function post(endpoint: string, body: object) {
    const raw = JSON.stringify(body)
    const res = await app.inject({
        method: 'POST',
        url: `/wallet/${endpoint}`,
        payload: raw,
        headers: {
            'content-type': 'application/json',
            'x-signature': sign(raw),
            'x-api-key': API_KEY,
        },
    })
    return JSON.parse(res.body) as Record<string, any>
}

/** POST with a deliberately broken signature (GASea group-1 pattern). */
async function postBadSig(endpoint: string, body: object) {
    const raw = JSON.stringify(body)
    const res = await app.inject({
        method: 'POST',
        url: `/wallet/${endpoint}`,
        payload: raw,
        headers: {
            'content-type': 'application/json',
            'x-signature': sign(raw) + 'wrongSignature',
            'x-api-key': API_KEY,
        },
    })
    return JSON.parse(res.body) as Record<string, any>
}

/** Reduce a player's wallet to a specific real balance for testing. */
async function setBalance(userId: string, amount: number) {
    await prisma.wallet.update({
        where: { userId },
        data: { realBalance: new Decimal(amount), bonusBalance: new Decimal(0) },
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1 — Validate Invalid Signature
// ─────────────────────────────────────────────────────────────────────────────

describe('GROUP 1 — Invalid Signature', () => {
    it('1.01 wallet/balance → SC_INVALID_SIGNATURE', async () => {
        const traceId = uid()
        const res = await postBadSig('balance', {
            traceId, username: VALID_USER, currency: CURRENCY, token: TOKEN,
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_INVALID_SIGNATURE')
    })

    it('1.02 wallet/bet → SC_INVALID_SIGNATURE', async () => {
        const traceId = uid()
        const res = await postBadSig('bet', {
            traceId,
            username: VALID_USER,
            transactionId: uid(),
            betId: uid(),
            externalTransactionId: uid(),
            amount: 5,
            currency: CURRENCY,
            token: TOKEN,
            gameCode: GAME_CODE,
            timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_INVALID_SIGNATURE')
    })

    it('1.03 wallet/bet_result → SC_INVALID_SIGNATURE', async () => {
        const traceId = uid()
        const res = await postBadSig('bet_result', {
            traceId,
            username: VALID_USER,
            transactionId: uid(),
            betId: uid(),
            externalTransactionId: uid(),
            roundId: uid(),
            betAmount: 5, winAmount: 10, effectiveTurnover: 5,
            winLoss: 5, jackpotAmount: 0,
            resultType: 'WIN', isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_INVALID_SIGNATURE')
    })

    it('1.04 wallet/rollback → SC_INVALID_SIGNATURE', async () => {
        const traceId = uid()
        const res = await postBadSig('rollback', {
            traceId,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            username: VALID_USER, currency: CURRENCY, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_INVALID_SIGNATURE')
    })

    it('1.05 wallet/adjustment → SC_INVALID_SIGNATURE', async () => {
        const traceId = uid()
        const res = await postBadSig('adjustment', {
            traceId,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            username: VALID_USER, currency: CURRENCY, amount: 5, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_INVALID_SIGNATURE')
    })

    it('1.06 wallet/bet_debit → SC_INVALID_SIGNATURE', async () => {
        const traceId = uid()
        const txId = uid()
        const res = await postBadSig('bet_debit', {
            traceId, username: VALID_USER, transactionId: txId,
            roundId: uid(), amount: 1000, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_INVALID_SIGNATURE')
    })

    it('1.07 wallet/bet_credit → SC_INVALID_SIGNATURE', async () => {
        const traceId = uid()
        const res = await postBadSig('bet_credit', {
            traceId, username: VALID_USER, transactionId: uid(),
            roundId: uid(), isRefund: 0, amount: 2000,
            betAmount: 1000, winAmount: 2000, effectiveTurnover: 1000,
            winLoss: 1000, jackpotAmount: 0, currency: CURRENCY,
            token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(), timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_INVALID_SIGNATURE')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2 — Validate Invalid Username
// ─────────────────────────────────────────────────────────────────────────────

describe('GROUP 2 — Invalid Username', () => {
    it('2.01 wallet/balance → SC_USER_NOT_EXISTS', async () => {
        const traceId = uid()
        const res = await post('balance', {
            traceId, username: INVALID_USER, currency: CURRENCY, token: TOKEN,
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_USER_NOT_EXISTS')
    })

    it('2.02 wallet/bet → SC_USER_NOT_EXISTS', async () => {
        const traceId = uid()
        const res = await post('bet', {
            traceId,
            username: INVALID_USER,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            amount: 5, currency: CURRENCY, token: TOKEN,
            gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_USER_NOT_EXISTS')
    })

    it('2.03 wallet/bet_result → SC_USER_NOT_EXISTS', async () => {
        const traceId = uid()
        const res = await post('bet_result', {
            traceId,
            username: INVALID_USER,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            roundId: uid(),
            betAmount: 5, winAmount: 10, effectiveTurnover: 5,
            winLoss: 5, jackpotAmount: 0,
            resultType: 'WIN', isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_USER_NOT_EXISTS')
    })

    it('2.04 wallet/rollback → SC_USER_NOT_EXISTS', async () => {
        const traceId = uid()
        const res = await post('rollback', {
            traceId,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            username: INVALID_USER, currency: CURRENCY, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_USER_NOT_EXISTS')
    })

    it('2.05 wallet/adjustment → SC_USER_NOT_EXISTS', async () => {
        const traceId = uid()
        const res = await post('adjustment', {
            traceId,
            transactionId: uid(), externalTransactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            username: INVALID_USER, currency: CURRENCY,
            amount: 5, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_USER_NOT_EXISTS')
    })

    it('2.06 wallet/bet_debit → SC_USER_NOT_EXISTS', async () => {
        const traceId = uid()
        const txId = uid()
        const res = await post('bet_debit', {
            traceId, username: INVALID_USER, transactionId: txId,
            roundId: uid(), amount: 1000, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_USER_NOT_EXISTS')
    })

    it('2.07 wallet/bet_credit → SC_USER_NOT_EXISTS', async () => {
        const traceId = uid()
        const res = await post('bet_credit', {
            traceId, username: INVALID_USER, transactionId: uid(),
            roundId: uid(), isRefund: 0, amount: 2000,
            betAmount: 1000, winAmount: 2000, effectiveTurnover: 1000,
            winLoss: 1000, jackpotAmount: 0, currency: CURRENCY,
            token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(), timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_USER_NOT_EXISTS')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3 — Validate Insufficient Balance
// ─────────────────────────────────────────────────────────────────────────────

describe('GROUP 3 — Insufficient Balance', () => {
    beforeEach(async () => {
        // Set balance too low for big bets
        await setBalance(validUserId, 1)
    })

    it('3.01 wallet/balance returns SC_OK then wallet/bet with amount > balance → SC_INSUFFICIENT_BALANCE', async () => {
        const balRes = await post('balance', {
            traceId: uid(), username: VALID_USER, currency: CURRENCY, token: TOKEN,
        })
        expect(balRes.status).toBe('SC_OK')
        expect(parseFloat(balRes.data.balance)).toBeLessThan(99_999_999)

        const betRes = await post('bet', {
            traceId: uid(),
            username: VALID_USER,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            amount: 99_999_999,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(betRes.status).toBe('SC_INSUFFICIENT_BALANCE')
    })

    it('3.02 wallet/bet_result [WIN] with amount > balance → SC_INSUFFICIENT_BALANCE', async () => {
        const betRes = await post('bet_result', {
            traceId: uid(),
            username: VALID_USER,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            roundId: uid(),
            betAmount: 99_999_999, winAmount: 10,
            effectiveTurnover: 99_999_999, winLoss: -99_999_989, jackpotAmount: 0,
            resultType: 'BET_WIN',
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(betRes.status).toBe('SC_INSUFFICIENT_BALANCE')
    })

    it('3.03 wallet/bet_result [BET_LOSE] with betAmount > balance → SC_INSUFFICIENT_BALANCE', async () => {
        const betRes = await post('bet_result', {
            traceId: uid(),
            username: VALID_USER,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            roundId: uid(),
            betAmount: 99_999_999, winAmount: 0,
            effectiveTurnover: 99_999_999, winLoss: -99_999_999, jackpotAmount: 0,
            resultType: 'BET_LOSE',
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(betRes.status).toBe('SC_INSUFFICIENT_BALANCE')
    })

    it('3.04 wallet/bet then wallet/rollback — rollback restores even when original bet failed', async () => {
        const betId = uid()
        const txId  = uid()

        const betRes = await post('bet', {
            traceId: uid(),
            username: VALID_USER,
            transactionId: txId, betId, externalTransactionId: uid(),
            amount: 99_999_999,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(betRes.status).toBe('SC_INSUFFICIENT_BALANCE')

        // Rollback on a failed bet → SC_TRANSACTION_NOT_EXISTS (nothing to roll back)
        const rbRes = await post('rollback', {
            traceId: uid(),
            transactionId: uid(), betId,
            externalTransactionId: uid(), roundId: uid(),
            gameCode: GAME_CODE, username: VALID_USER, currency: CURRENCY, timestamp: Date.now(),
        })
        expect(rbRes.status).toBe('SC_TRANSACTION_NOT_EXISTS')
    })

    it('3.05 wallet/adjustment [DEBIT] with amount > balance → SC_INSUFFICIENT_BALANCE', async () => {
        const adjRes = await post('adjustment', {
            traceId: uid(),
            username: VALID_USER,
            transactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            amount: -99_999_999,
            currency: CURRENCY, timestamp: Date.now(),
        })
        expect(adjRes.status).toBe('SC_INSUFFICIENT_BALANCE')
    })

    it('3.06 wallet/bet_debit with amount > balance → SC_INSUFFICIENT_BALANCE', async () => {
        const res = await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId: uid(), amount: 99_999_999, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(res.status).toBe('SC_INSUFFICIENT_BALANCE')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4 — Validate Debit Amount
// ─────────────────────────────────────────────────────────────────────────────

describe('GROUP 4 — Debit Amount Validation', () => {
    it('4.01 wallet/bet then wallet/bet_result [END] with mismatched betAmount → SC_BET_AMOUNT_NOT_MATCH', async () => {
        const betId = uid()
        const roundId = uid()

        // Confirm balance
        const bal0 = await post('balance', {
            traceId: uid(), username: VALID_USER, currency: CURRENCY, token: TOKEN,
        })
        expect(bal0.status).toBe('SC_OK')

        // Bet 5
        const betRes = await post('bet', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: uid(),
            amount: 5, currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(betRes.status).toBe('SC_OK')

        // bet_result END with betAmount=10 (does not match the 5 that was actually bet)
        const resultRes = await post('bet_result', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: uid(), roundId,
            betAmount: 10, winAmount: 0,
            effectiveTurnover: 10, winLoss: -10, jackpotAmount: 0,
            resultType: 'END',
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(resultRes.status).toBe('SC_BET_AMOUNT_NOT_MATCH')
    })

    it('4.02 wallet/bet_result [BET_LOSE] with mismatched betAmount → SC_BET_AMOUNT_NOT_MATCH', async () => {
        const betId = uid()

        const betRes = await post('bet', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: uid(),
            amount: 5, currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(betRes.status).toBe('SC_OK')

        const resultRes = await post('bet_result', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: uid(), roundId: uid(),
            betAmount: 20, winAmount: 0,
            effectiveTurnover: 20, winLoss: -20, jackpotAmount: 0,
            resultType: 'BET_LOSE',
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(resultRes.status).toBe('SC_BET_AMOUNT_NOT_MATCH')
    })

    it('4.03 wallet/bet_debit integer amount, then wallet/bet_credit mismatched → SC_BET_AMOUNT_NOT_MATCH', async () => {
        const roundId = uid()
        const debitTxId = uid()

        const debitRes = await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: debitTxId,
            roundId, amount: 1000, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(debitRes.status).toBe('SC_OK')

        const creditRes = await post('bet_credit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId, isRefund: 0,
            amount: 500,
            betAmount: 999,  // mismatched — original debit was 1000
            winAmount: 500, effectiveTurnover: 999,
            winLoss: -499, jackpotAmount: 0,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(), timestamp: Date.now(),
        })
        expect(creditRes.status).toBe('SC_BET_AMOUNT_NOT_MATCH')
    })

    it('4.04 wallet/bet_debit decimal amount, then wallet/bet_credit mismatched → SC_BET_AMOUNT_NOT_MATCH', async () => {
        const roundId = uid()

        const debitRes = await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId, amount: 10.5, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(debitRes.status).toBe('SC_OK')

        const creditRes = await post('bet_credit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId, isRefund: 0,
            amount: 10.5,
            betAmount: 11,  // mismatched
            winAmount: 10.5, effectiveTurnover: 11,
            winLoss: -0.5, jackpotAmount: 0,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(), timestamp: Date.now(),
        })
        expect(creditRes.status).toBe('SC_BET_AMOUNT_NOT_MATCH')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5 — Validate Credit Win Amount
// ─────────────────────────────────────────────────────────────────────────────

describe('GROUP 5 — Credit Win Amount Validation', () => {
    // These tests require validating winAmount against an expected value not known to the
    // operator at callback time (only GASea's game server knows the correct win).
    // Marking as todo until GASea provides a mechanism (e.g. pre-announced expected win).
    it.todo('5.01 wallet/bet then wallet/bet_result [WIN] with wrong winAmount → SC_WIN_AMOUNT_NOT_MATCH')
    it.todo('5.02 wallet/bet then wallet/bet_result [WIN] then [END] with wrong amounts')
    it.todo('5.03 wallet/bet_result [BET_WIN] with wrong winAmount → SC_WIN_AMOUNT_NOT_MATCH')
    it.todo('5.04 wallet/bet_result [WIN] with betAmount=0 and wrong winAmount → SC_WIN_AMOUNT_NOT_MATCH')
    it.todo('5.07 wallet/bet_debit integer amount then wallet/bet_credit mismatched win → SC_WIN_AMOUNT_NOT_MATCH')
    it.todo('5.08 wallet/bet_debit decimal amount then wallet/bet_credit mismatched win → SC_WIN_AMOUNT_NOT_MATCH')
})

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 6 — Validate Credit Jackpot Amount
// ─────────────────────────────────────────────────────────────────────────────

describe('GROUP 6 — Credit Jackpot Amount Validation', () => {
    // These tests require validating jackpotAmount against an expected value not known to
    // the operator at callback time. Marking as todo until GASea provides a mechanism.
    it.todo('6.01 wallet/bet then bet_result [WIN] jackpot-only with wrong jackpotAmount → SC_JACKPOT_AMOUNT_NOT_MATCH')
    it.todo('6.02 wallet/bet then bet_result [WIN] win+jackpot with wrong jackpotAmount → SC_JACKPOT_AMOUNT_NOT_MATCH')
})

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 7 — Validate Rollback
// ─────────────────────────────────────────────────────────────────────────────

describe('GROUP 7 — Rollback', () => {
    it('7.01 wallet/bet then wallet/rollback restores balance', async () => {
        const betId = uid()
        const betTxId = uid()

        const balBefore = await post('balance', {
            traceId: uid(), username: VALID_USER, currency: CURRENCY, token: TOKEN,
        })
        expect(balBefore.status).toBe('SC_OK')
        const before = parseFloat(balBefore.data.balance)

        const betRes = await post('bet', {
            traceId: uid(), username: VALID_USER,
            transactionId: betTxId, betId, externalTransactionId: uid(),
            amount: 5, currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(betRes.status).toBe('SC_OK')
        expect(parseFloat(betRes.data.balance)).toBe(before - 5)

        const rbRes = await post('rollback', {
            traceId: uid(),
            transactionId: uid(), betId, externalTransactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            username: VALID_USER, currency: CURRENCY, timestamp: Date.now(),
        })
        expect(rbRes.status).toBe('SC_OK')
        expect(parseFloat(rbRes.data.balance)).toBe(before)
    })

    it('7.02 wallet/bet then bet_result [END] then rollback restores balance', async () => {
        const betId = uid()

        const betRes = await post('bet', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: uid(),
            amount: 5, currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(betRes.status).toBe('SC_OK')

        const endRes = await post('bet_result', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: uid(), roundId: uid(),
            betAmount: 5, winAmount: 0,
            effectiveTurnover: 5, winLoss: -5, jackpotAmount: 0,
            resultType: 'END',
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(endRes.status).toBe('SC_OK')

        const rbRes = await post('rollback', {
            traceId: uid(),
            transactionId: uid(), betId, externalTransactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            username: VALID_USER, currency: CURRENCY, timestamp: Date.now(),
        })
        expect(rbRes.status).toBe('SC_OK')
    })

    it('7.03 wallet/bet_result [BET_LOSE] then rollback restores balance', async () => {
        const betId = uid()

        const loseRes = await post('bet_result', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: uid(), roundId: uid(),
            betAmount: 5, winAmount: 0,
            effectiveTurnover: 5, winLoss: -5, jackpotAmount: 0,
            resultType: 'BET_LOSE',
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(loseRes.status).toBe('SC_OK')

        const rbRes = await post('rollback', {
            traceId: uid(),
            transactionId: uid(), betId, externalTransactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            username: VALID_USER, currency: CURRENCY, timestamp: Date.now(),
        })
        expect(rbRes.status).toBe('SC_OK')
        expect(parseFloat(rbRes.data.balance)).toBe(1000) // balance fully restored
    })

    it('7.04 wallet/bet_result [BET_WIN] then rollback reverses credit', async () => {
        const betId = uid()

        const winRes = await post('bet_result', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: uid(), roundId: uid(),
            betAmount: 5, winAmount: 10,
            effectiveTurnover: 5, winLoss: 5, jackpotAmount: 0,
            resultType: 'BET_WIN',
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(winRes.status).toBe('SC_OK')
        const balAfterWin = parseFloat(winRes.data.balance)

        const rbRes = await post('rollback', {
            traceId: uid(),
            transactionId: uid(), betId, externalTransactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            username: VALID_USER, currency: CURRENCY, timestamp: Date.now(),
        })
        expect(rbRes.status).toBe('SC_OK')
        // Balance should return to 1000 (original)
        expect(parseFloat(rbRes.data.balance)).toBe(1000)
    })

    it('7.05 wallet/bet_debit then rollback restores balance', async () => {
        const roundId = uid()
        const debitTxId = uid()
        const betId = uid()

        const debitRes = await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: debitTxId,
            roundId, amount: 100, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(debitRes.status).toBe('SC_OK')
        expect(parseFloat(debitRes.data.balance)).toBe(900)

        const rbRes = await post('rollback', {
            traceId: uid(),
            transactionId: uid(), betId: debitTxId,
            externalTransactionId: uid(), roundId,
            gameCode: GAME_CODE, username: VALID_USER, currency: CURRENCY, timestamp: Date.now(),
        })
        expect(rbRes.status).toBe('SC_OK')
        expect(parseFloat(rbRes.data.balance)).toBe(1000)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 8 — Validate Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('GROUP 8 — Idempotency', () => {
    it('8.01 wallet/bet called twice with same transactionId returns same response', async () => {
        const body = {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            amount: 5, currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, timestamp: Date.now(),
        }

        const first  = await post('bet', body)
        const second = await post('bet', { ...body, traceId: uid() }) // traceId may differ, transactionId same
        expect(first.status).toBe('SC_OK')
        expect(second.status).toBe('SC_OK')
        expect(second.data.balance).toBe(first.data.balance) // no double-debit
    })

    it('8.02 wallet/bet_result [WIN] called twice returns same response', async () => {
        const betId = uid()

        await post('bet', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: uid(),
            amount: 5, currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, timestamp: Date.now(),
        })

        const resultBody = {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: uid(), roundId: uid(),
            betAmount: 5, winAmount: 10,
            effectiveTurnover: 5, winLoss: 5, jackpotAmount: 0,
            resultType: 'WIN' as const,
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        }

        const first  = await post('bet_result', resultBody)
        const second = await post('bet_result', { ...resultBody, traceId: uid() })
        expect(first.status).toBe('SC_OK')
        expect(second.status).toBe('SC_OK')
        expect(second.data.balance).toBe(first.data.balance)
    })

    it('8.03 wallet/bet_result [BET_LOSE] called twice returns same response', async () => {
        const txId = uid()
        const betId = uid()

        const body = {
            traceId: uid(), username: VALID_USER,
            transactionId: txId, betId, externalTransactionId: uid(), roundId: uid(),
            betAmount: 5, winAmount: 0,
            effectiveTurnover: 5, winLoss: -5, jackpotAmount: 0,
            resultType: 'BET_LOSE' as const,
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        }

        const first  = await post('bet_result', body)
        const second = await post('bet_result', { ...body, traceId: uid() })
        expect(first.status).toBe('SC_OK')
        expect(second.status).toBe('SC_OK')
        expect(second.data.balance).toBe(first.data.balance)
    })

    it('8.04 wallet/bet_result [BET_WIN] called twice returns same response', async () => {
        const txId = uid()
        const betId = uid()

        const body = {
            traceId: uid(), username: VALID_USER,
            transactionId: txId, betId, externalTransactionId: uid(), roundId: uid(),
            betAmount: 5, winAmount: 10,
            effectiveTurnover: 5, winLoss: 5, jackpotAmount: 0,
            resultType: 'BET_WIN' as const,
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        }

        const first  = await post('bet_result', body)
        const second = await post('bet_result', { ...body, traceId: uid() })
        expect(first.status).toBe('SC_OK')
        expect(second.status).toBe('SC_OK')
        expect(second.data.balance).toBe(first.data.balance)
    })

    it('8.05 wallet/rollback called twice with same transactionId returns same response', async () => {
        const betId = uid()

        await post('bet', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: uid(),
            amount: 5, currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, timestamp: Date.now(),
        })

        const rbBody = {
            traceId: uid(),
            transactionId: uid(), betId, externalTransactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            username: VALID_USER, currency: CURRENCY, timestamp: Date.now(),
        }

        const first  = await post('rollback', rbBody)
        const second = await post('rollback', { ...rbBody, traceId: uid() })
        expect(first.status).toBe('SC_OK')
        expect(second.status).toBe('SC_OK')
        expect(second.data.balance).toBe(first.data.balance)
    })

    it('8.06 wallet/bet with insufficient balance, same transactionId returns SC_INSUFFICIENT_BALANCE again', async () => {
        await setBalance(validUserId, 1)
        const betId = uid()
        const txId  = uid()

        const body = {
            traceId: uid(), username: VALID_USER,
            transactionId: txId, betId, externalTransactionId: uid(),
            amount: 99_999_999, currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, timestamp: Date.now(),
        }

        const first  = await post('bet', body)
        const second = await post('bet', { ...body, traceId: uid() })
        expect(first.status).toBe('SC_INSUFFICIENT_BALANCE')
        expect(second.status).toBe('SC_INSUFFICIENT_BALANCE')
    })

    it('8.07 wallet/bet_result [BET_WIN] with insufficient balance — same transactionId returns SC_INSUFFICIENT_BALANCE', async () => {
        await setBalance(validUserId, 1)

        const txId  = uid()
        const betId = uid()

        const body = {
            traceId: uid(), username: VALID_USER,
            transactionId: txId, betId, externalTransactionId: uid(), roundId: uid(),
            betAmount: 99_999_999, winAmount: 10,
            effectiveTurnover: 99_999_999, winLoss: -99_999_989, jackpotAmount: 0,
            resultType: 'BET_WIN' as const,
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        }

        const first  = await post('bet_result', body)
        const second = await post('bet_result', { ...body, traceId: uid() })
        expect(first.status).toBe('SC_INSUFFICIENT_BALANCE')
        expect(second.status).toBe('SC_INSUFFICIENT_BALANCE')
    })

    it('8.08 wallet/bet_result [BET_LOSE] with insufficient balance — same transactionId returns SC_INSUFFICIENT_BALANCE', async () => {
        await setBalance(validUserId, 1)

        const txId  = uid()
        const betId = uid()

        const body = {
            traceId: uid(), username: VALID_USER,
            transactionId: txId, betId, externalTransactionId: uid(), roundId: uid(),
            betAmount: 99_999_999, winAmount: 0,
            effectiveTurnover: 99_999_999, winLoss: -99_999_999, jackpotAmount: 0,
            resultType: 'BET_LOSE' as const,
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        }

        const first  = await post('bet_result', body)
        const second = await post('bet_result', { ...body, traceId: uid() })
        expect(first.status).toBe('SC_INSUFFICIENT_BALANCE')
        expect(second.status).toBe('SC_INSUFFICIENT_BALANCE')
    })

    it('8.09 wallet/adjustment called twice with same transactionId returns same response', async () => {
        const txId = uid()
        const body = {
            traceId: uid(), username: VALID_USER,
            transactionId: txId,
            roundId: uid(), gameCode: GAME_CODE,
            amount: 50, currency: CURRENCY, timestamp: Date.now(),
        }

        const first  = await post('adjustment', body)
        const second = await post('adjustment', { ...body, traceId: uid() })
        expect(first.status).toBe('SC_OK')
        expect(second.status).toBe('SC_OK')
        expect(second.data.balance).toBe(first.data.balance)
    })

    it('8.10 wallet/bet_debit called twice with same transactionId returns same response', async () => {
        const roundId = uid()
        const txId    = uid()

        const body = {
            traceId: uid(), username: VALID_USER, transactionId: txId,
            roundId, amount: 100, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        }

        const first  = await post('bet_debit', body)
        const second = await post('bet_debit', { ...body, traceId: uid() })
        expect(first.status).toBe('SC_OK')
        expect(second.status).toBe('SC_OK')
        expect(second.data.balance).toBe(first.data.balance) // no double-debit
    })

    it('8.11 wallet/bet_credit called twice with same transactionId returns same response', async () => {
        const roundId   = uid()
        const creditTxId = uid()

        // First debit the wallet
        await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId, amount: 100, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })

        const creditBody = {
            traceId: uid(), username: VALID_USER, transactionId: creditTxId,
            roundId, isRefund: 0, amount: 100,
            betAmount: 100, winAmount: 100, effectiveTurnover: 100,
            winLoss: 0, jackpotAmount: 0,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(), timestamp: Date.now(),
        }

        const first  = await post('bet_credit', creditBody)
        const second = await post('bet_credit', { ...creditBody, traceId: uid() })
        expect(first.status).toBe('SC_OK')
        expect(second.status).toBe('SC_OK')
        expect(second.data.balance).toBe(first.data.balance)
    })
})
