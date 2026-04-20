/**
 * GASea Wallet Callback API — Endpoint Verification Suite
 *
 * Replicates the GASea test tool at stg-agt.gasea168.com/bo/devtool/endpoint-verification.
 * Spec-first: tests define what the API MUST do per the GASea Seamless Wallet API v3.
 * Failing tests expose gaps between the current implementation and the spec.
 *
 * Groups mirror the dashboard exactly:
 *  1. Invalid Signature
 *  2. Invalid Username
 *  3. Insufficient Balance
 *  4. Debit Amount Validation      — SC_BET_AMOUNT_NOT_MATCH (from verification tool, not in status table)
 *  5. Credit Win Amount Validation — SC_WIN_AMOUNT_NOT_MATCH (from verification tool, not in status table)
 *  6. Credit Jackpot Validation    — SC_JACKPOT_AMOUNT_NOT_MATCH (from verification tool, not in status table)
 *  7. Rollback
 *  8. Idempotency
 *  9. User Reported Failures
 * 10. Spec Error Codes             — SC_WRONG_CURRENCY, SC_USER_DISABLED (documented in API Response Statuses)
 *
 * SC_OK response shape (per spec):
 *   { traceId, status: "SC_OK", data: { username, currency, balance, timestamp } }
 * Error response shape:
 *   { traceId, status: "SC_*" }  — no data field
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
/** Disabled player */
const DISABLED_USER = 'disabledUser'
/** Wrong currency */
const WRONG_CURRENCY = 'USD'

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

    // Create disabled player (SC_USER_DISABLED per spec)
    await prisma.user.create({
        data: {
            username: DISABLED_USER,
            phone: '+251900000002',
            passwordHash: 'hashed:test',
            isActive: false,
            wallet: { create: { realBalance: 500, bonusBalance: 0 } },
        },
    })
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
        // Error responses must not include data (spec: only { traceId, status })
        expect(res.data).toBeUndefined()
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

    it('3.01 wallet/balance returns SC_OK then wallet/bet with amount > balance → SC_INSUFFICIENT_FUNDS', async () => {
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
        expect(betRes.status).toBe('SC_INSUFFICIENT_FUNDS')
    })

    it('3.02 wallet/bet_result [WIN] with amount > balance → SC_INSUFFICIENT_FUNDS', async () => {
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
        expect(betRes.status).toBe('SC_INSUFFICIENT_FUNDS')
    })

    it('3.03 wallet/bet_result [BET_LOSE] with betAmount > balance → SC_INSUFFICIENT_FUNDS', async () => {
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
        expect(betRes.status).toBe('SC_INSUFFICIENT_FUNDS')
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
        expect(betRes.status).toBe('SC_INSUFFICIENT_FUNDS')

        // Rollback on a failed bet → SC_TRANSACTION_NOT_EXISTS (nothing to roll back)
        const rbRes = await post('rollback', {
            traceId: uid(),
            transactionId: uid(), betId,
            externalTransactionId: uid(), roundId: uid(),
            gameCode: GAME_CODE, username: VALID_USER, currency: CURRENCY, timestamp: Date.now(),
        })
        expect(rbRes.status).toBe('SC_TRANSACTION_NOT_EXISTS')
    })

    it('3.05 wallet/adjustment [DEBIT] with amount > balance → SC_INSUFFICIENT_FUNDS', async () => {
        const adjRes = await post('adjustment', {
            traceId: uid(),
            username: VALID_USER,
            transactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            amount: -99_999_999,
            currency: CURRENCY, timestamp: Date.now(),
        })
        expect(adjRes.status).toBe('SC_INSUFFICIENT_FUNDS')
    })

    it('3.06 wallet/bet_debit with amount > balance → SC_INSUFFICIENT_FUNDS', async () => {
        const res = await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId: uid(), amount: 99_999_999, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(res.status).toBe('SC_INSUFFICIENT_FUNDS')
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

    it('4.03.02 FISH integer bet_debit: string amount "195.00000000" drains balance to "0.00000000"', async () => {
        await setBalance(validUserId, 195)

        const res = await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId: uid(), amount: '195.00000000', currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(res.status).toBe('SC_OK')
        expect(res.data.balance).toBe('0.00000000')
    })

    it('4.03.03 FISH integer bet_credit: amount=10000 from zero → "10000.00000000"', async () => {
        const roundId = uid()
        // Seed matching debit (betAmount=1000) then force balance to 0 to replicate staging state
        await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId, amount: 1000, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        await setBalance(validUserId, 0)

        const res = await post('bet_credit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(), betId: uid(),
            roundId, isRefund: 0,
            amount: 10000, betAmount: 1000, winAmount: 2000,
            effectiveTurnover: 1000, winLoss: 1000, jackpotAmount: 0,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(), timestamp: Date.now(),
        })
        expect(res.status).toBe('SC_OK')
        expect(res.data.balance).toBe('10000.00000000')
    })

    it('4.04.03 FISH decimal bet_credit: amount=10000 from 9194.99765467 → "19194.99765467"', async () => {
        const roundId = uid()
        // Initial 10194.99765467; debit 1000 → 9194.99765467; credit 10000 → 19194.99765467
        await setBalance(validUserId, 10194.99765467)
        await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId, amount: 1000, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })

        const res = await post('bet_credit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(), betId: uid(),
            roundId, isRefund: 0,
            amount: 10000, betAmount: 1000, winAmount: 2000,
            effectiveTurnover: 1000, winLoss: 1000, jackpotAmount: 0,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(), timestamp: Date.now(),
        })
        expect(res.status).toBe('SC_OK')
        expect(res.data.balance).toBe('19194.99765467')
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

    // ── FISH happy-path decimal precision tests (GASea verification tool 5.07/5.08) ──

    it('5.07.02 FISH integer bet_debit: string amount "9239.99765467" drains exact balance → "0.00000000"', async () => {
        await setBalance(validUserId, 9239.99765467)

        const res = await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId: uid(), amount: '9239.99765467', currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(res.status).toBe('SC_OK')
        expect(res.data.balance).toBe('0.00000000')
    })

    it('5.08.02 FISH decimal bet_debit: amount=4619.998827335 halves balance → "4619.99882733"', async () => {
        // 9239.99765467 - 4619.998827335 = 4619.998827335 → rounded to 8dp: "4619.99882733"
        await setBalance(validUserId, 9239.99765467)

        const res = await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId: uid(), amount: 4619.998827335, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(res.status).toBe('SC_OK')
        expect(res.data.balance).toBe('4619.99882733')
    })

    it('5.08.03 FISH decimal bet_credit: amount=10000.00234533 from 4619.99882734 → "14620.00117267"', async () => {
        const roundId = uid()
        // Seed matching debit first so betAmount validation passes
        await setBalance(validUserId, 4619.99882734 + 1000)
        await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId, amount: 1000, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        // balance now: 4619.99882734

        const res = await post('bet_credit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(), betId: uid(),
            roundId, isRefund: 0,
            amount: 10000.00234533, betAmount: 1000, winAmount: 2000,
            effectiveTurnover: 1000, winLoss: 1000, jackpotAmount: 0,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(), timestamp: Date.now(),
        })
        expect(res.status).toBe('SC_OK')
        expect(res.data.balance).toBe('14620.00117267')
    })
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
        // Verify full SC_OK response shape per spec: { traceId, status, data: { username, currency, balance, timestamp } }
        expect(balBefore.status).toBe('SC_OK')
        expect(balBefore.data.username).toBe(VALID_USER)
        expect(balBefore.data.currency).toBe(CURRENCY)
        expect(typeof balBefore.data.balance).toBe('string')
        expect(typeof balBefore.data.timestamp).toBe('number')
        const before = parseFloat(balBefore.data.balance)

        const betRes = await post('bet', {
            traceId: uid(), username: VALID_USER,
            transactionId: betTxId, betId, externalTransactionId: uid(),
            amount: 5, currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(betRes.status).toBe('SC_OK')
        expect(betRes.data.username).toBe(VALID_USER)
        expect(betRes.data.currency).toBe(CURRENCY)
        expect(typeof betRes.data.timestamp).toBe('number')
        expect(parseFloat(betRes.data.balance)).toBe(before - 5)

        const rbRes = await post('rollback', {
            traceId: uid(),
            transactionId: uid(), betId, externalTransactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            username: VALID_USER, currency: CURRENCY, timestamp: Date.now(),
        })
        expect(rbRes.status).toBe('SC_OK')
        expect(rbRes.data.username).toBe(VALID_USER)
        expect(rbRes.data.currency).toBe(CURRENCY)
        expect(typeof rbRes.data.timestamp).toBe('number')
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

    it('8.06 wallet/bet with insufficient balance, same transactionId returns SC_INSUFFICIENT_FUNDS again', async () => {
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
        expect(first.status).toBe('SC_INSUFFICIENT_FUNDS')
        expect(second.status).toBe('SC_INSUFFICIENT_FUNDS')
    })

    it('8.07 wallet/bet_result [BET_WIN] with insufficient balance — same transactionId returns SC_INSUFFICIENT_FUNDS', async () => {
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
        expect(first.status).toBe('SC_INSUFFICIENT_FUNDS')
        expect(second.status).toBe('SC_INSUFFICIENT_FUNDS')
    })

    it('8.08 wallet/bet_result [BET_LOSE] with insufficient balance — same transactionId returns SC_INSUFFICIENT_FUNDS', async () => {
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
        expect(first.status).toBe('SC_INSUFFICIENT_FUNDS')
        expect(second.status).toBe('SC_INSUFFICIENT_FUNDS')
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

    it('8.12 wallet/bet_debit with string-format amount equal to full balance → SC_OK, balance "0.00000000"', async () => {
        // GASea sends amount as a decimal string (e.g. "195.00000000"), not a JS number.
        // Ensure we coerce it correctly and produce the exact balance string GASea expects.
        await setBalance(validUserId, 195)

        const res = await post('bet_debit', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(),
            roundId: uid(),
            amount: '195.00000000', // string — GASea's actual wire format
            currency: CURRENCY,
            gameCode: GAME_CODE,
            token: TOKEN,
            timestamp: Date.now(),
        })
        expect(res.status).toBe('SC_OK')
        expect(res.data.balance).toBe('0.00000000')
    })

    // 8.06.02/03 — covered by 9.04/9.05 (raw-body tests with identical amounts)

    it('8.07.02/03 bet_result [BET_WIN] with decimal string betAmount "11614.99882734100" and low balance — idempotent SC_INSUFFICIENT_FUNDS', async () => {
        await setBalance(validUserId, 1)
        const txId  = uid()
        const betId = uid()

        const body = {
            traceId: uid(), username: VALID_USER,
            transactionId: txId, betId, externalTransactionId: uid(), roundId: uid(),
            betAmount: '11614.99882734100', winAmount: 10,
            effectiveTurnover: '11614.99882734100', winLoss: -11604.998827341, jackpotAmount: 0,
            resultType: 'BET_WIN' as const,
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        }

        const first  = await post('bet_result', body)
        const second = await post('bet_result', { ...body, traceId: uid() })
        expect(first.status).toBe('SC_INSUFFICIENT_FUNDS')
        expect(second.status).toBe('SC_INSUFFICIENT_FUNDS')
    })

    it('8.08.02/03 bet_result [BET_LOSE] with decimal string betAmount "11614.99882734100" and low balance — idempotent SC_INSUFFICIENT_FUNDS', async () => {
        await setBalance(validUserId, 1)
        const txId  = uid()
        const betId = uid()

        const body = {
            traceId: uid(), username: VALID_USER,
            transactionId: txId, betId, externalTransactionId: uid(), roundId: uid(),
            betAmount: '11614.99882734100', winAmount: 0,
            effectiveTurnover: '11614.99882734100', winLoss: -11614.998827341, jackpotAmount: 0,
            resultType: 'BET_LOSE' as const,
            isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        }

        const first  = await post('bet_result', body)
        const second = await post('bet_result', { ...body, traceId: uid() })
        expect(first.status).toBe('SC_INSUFFICIENT_FUNDS')
        expect(second.status).toBe('SC_INSUFFICIENT_FUNDS')
    })

    it('8.12.02/03 FISH bet_debit with string amount "10624.99882734100" and low balance — idempotent SC_INSUFFICIENT_FUNDS', async () => {
        await setBalance(validUserId, 1)
        const txId = uid()

        const body = {
            traceId: uid(), username: VALID_USER,
            transactionId: txId, roundId: uid(),
            amount: '10624.99882734100',
            currency: CURRENCY, gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        }

        const first  = await post('bet_debit', body)
        const second = await post('bet_debit', { ...body, traceId: uid() })
        expect(first.status).toBe('SC_INSUFFICIENT_FUNDS')
        expect(second.status).toBe('SC_INSUFFICIENT_FUNDS')
    })

    it('8.14.04 FISH bet_credit isRefund=1: refund credits back the debit, restoring balance', async () => {
        const roundId = uid()
        // 10624.99882734 - 1000 (debit) + 1000 (refund) = 10624.99882734
        await setBalance(validUserId, 10624.99882734)

        await post('bet_debit', {
            traceId: uid(), username: VALID_USER, transactionId: uid(),
            roundId, amount: 1000, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })

        const res = await post('bet_credit', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId: uid(),
            roundId, isRefund: 1,
            amount: 1000, betAmount: 1000, winAmount: 0,
            effectiveTurnover: 1000, winLoss: -1000, jackpotAmount: 0,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(), timestamp: Date.now(),
        })
        expect(res.status).toBe('SC_OK')
        expect(res.data.balance).toBe('10624.99882734')
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

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 9 — User Reported Failures
// ─────────────────────────────────────────────────────────────────────────────
describe('GROUP 9 — User Reported Failures', () => {

    it('9.01 wallet/bet_credit with amount=10000, balance goes from 0 to 10000.00000000', async () => {
        await setBalance(validUserId, 0)
        const res = await post('bet_credit', {
            "traceId": "4734ca3d-1632-4964-8f7b-a43571862817",
            "username": VALID_USER,
            "transactionId": "4734ca3d-1632-4964-8f7b-a43571862817",
            "betId": "4734ca3d-1632-4964-8f7b-a43571862817", // Sent by GASea although API docs might skip it
            "roundId": "OneApi275689216257",
            "isRefund": 0,
            "amount": 10000,
            "betAmount": 1000,
            "winAmount": 2000,
            "effectiveTurnover": 1000,
            "winLoss": 1000,
            "jackpotAmount": 0,
            "currency": CURRENCY,
            "token": TOKEN,
            "gameCode": GAME_CODE,
            "betTime": 1776660524063,
            "settledTime": 1776660524063,
            "timestamp": 1776660524063
        })
        expect(res.status).toBe('SC_OK')
        expect(res.data.balance).toBe("10000.00000000")
    })

    it('9.02 wallet/bet_credit with amount=10000, balance goes from 9194.99765467 to 19194.99765467', async () => {
        await setBalance(validUserId, 9194.99765467)
        const res = await post('bet_credit', {
            "traceId": "898fe81c-3349-48b5-95ac-9c21f2aa023e",
            "username": VALID_USER,
            "transactionId": "898fe81c-3349-48b5-95ac-9c21f2aa023e",
            "betId": "898fe81c-3349-48b5-95ac-9c21f2aa023e", // Sent by GASea
            "roundId": "OneApi533257498751",
            "isRefund": 0,
            "amount": 10000,
            "betAmount": 1000,
            "winAmount": 2000,
            "effectiveTurnover": 1000,
            "winLoss": 1000,
            "jackpotAmount": 0,
            "currency": CURRENCY,
            "token": TOKEN,
            "gameCode": GAME_CODE,
            "betTime": 1776660525149,
            "settledTime": 1776660525149,
            "timestamp": 1776660525149
        })
        expect(res.status).toBe('SC_OK')
        expect(res.data.balance).toBe("19194.99765467")
    })

    it('9.03 wallet/bet_debit with string amount="9239.99765467", balance goes to 0', async () => {
        // Set exact balance before debit
        await setBalance(validUserId, 9239.99765467)
        const res = await post('bet_debit', {
            "traceId": "deb87a7f-9301-46e4-9973-fd76c7fefba2",
            "username": VALID_USER,
            "transactionId": "deb87a7f-9301-46e4-9973-fd76c7fefba2",
            "roundId": "OneApi964270397841",
            "amount": "9239.99765467", // string from payload
            "currency": CURRENCY,
            "gameCode": GAME_CODE,
            "token": TOKEN,
            "timestamp": 1776660532272
        })
        expect(res.status).toBe('SC_OK')
        expect(res.data.balance).toBe("0.00000000")
    })

    it('9.04 8.06.02 wallet/bet raw body failure check', async () => {
        await setBalance(validUserId, 1)

        const rawBody = `{"traceId":"409a68b9-9761-4378-ba3c-dfc9816087fa","username":"defefe","transactionId":"OneApi48ed6672-929f-41f4-a97a-b5b6e700dcab","betId":"OneApieacd2237-02c6-4c11-945b-a675951316f2","externalTransactionId":"OneApi9399317847001","amount":"11614.99882734100","currency":"ETB","token":"6b149bc8-1889-4734-a077-954d7ebd8c7f","gameCode":"SPB_aviator","roundId":"OneApi4752706831075","timestamp":1776659947769}`;
        
        const res = await app.inject({
            method: 'POST',
            url: `/wallet/bet`,
            payload: rawBody,
            headers: {
                'content-type': 'application/json',
                'x-signature': '6f729530ebaf2a135dd0e035f495bc5fd71b608ec9a0ac0bded47172e5d56680',
                'x-api-key': API_KEY,
            },
        })
        const body = JSON.parse(res.body)

        expect(body.traceId).toBe("409a68b9-9761-4378-ba3c-dfc9816087fa")
        expect(body.status).toBe("SC_INSUFFICIENT_FUNDS")
    })

    it('9.gasea.01 Adjustment flow: bet 5 → bet_result END → adjustment +5 → balance restored', async () => {
        await setBalance(validUserId, 11624.99882734)
        const betId   = uid()
        const extTxId = uid()
        const roundId = uid()

        // 9.01.02 — bet 5
        const betRes = await post('bet', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: extTxId,
            amount: 5, currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, roundId, timestamp: Date.now(),
        })
        expect(betRes.status).toBe('SC_OK')
        expect(parseFloat(betRes.data.balance)).toBeCloseTo(11619.99882734, 5)

        // 9.01.03 — bet_result END (win=0, bet already deducted)
        const endRes = await post('bet_result', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: extTxId, roundId,
            betAmount: 5, winAmount: 0, effectiveTurnover: 5, winLoss: -5, jackpotAmount: 0,
            resultType: 'END', isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(endRes.status).toBe('SC_OK')
        expect(parseFloat(endRes.data.balance)).toBeCloseTo(11619.99882734, 5)

        // 9.01.04 — adjustment +5 (restores the bet)
        const adjRes = await post('adjustment', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), externalTransactionId: extTxId, roundId,
            amount: 5, currency: CURRENCY, gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(adjRes.status).toBe('SC_OK')
        expect(parseFloat(adjRes.data.balance)).toBeCloseTo(11624.99882734, 5)
    })

    it('9.gasea.02 Adjustment [WIN] then [END]: bet 5 → WIN +10 → END (idempotent) → adjustment +5', async () => {
        await setBalance(validUserId, 11624.99882734)
        const betId   = uid()
        const extTxId = uid()
        const roundId = uid()

        // 9.02.02 — bet 5
        const betRes = await post('bet', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: extTxId,
            amount: 5, currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE, roundId, timestamp: Date.now(),
        })
        expect(betRes.status).toBe('SC_OK')
        expect(parseFloat(betRes.data.balance)).toBeCloseTo(11619.99882734, 5)

        // 9.02.03 — bet_result WIN (betAmount=0 free-spin style, win=10, isEndRound=0)
        const winRes = await post('bet_result', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: extTxId, roundId,
            betAmount: 0, winAmount: 10, effectiveTurnover: 0, winLoss: 0, jackpotAmount: 0,
            resultType: 'WIN', isFreespin: 0, isEndRound: 0,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(winRes.status).toBe('SC_OK')
        expect(parseFloat(winRes.data.balance)).toBeCloseTo(11629.99882734, 5)

        // 9.02.04 — bet_result END (final settlement; WIN already applied so balance unchanged)
        const endRes = await post('bet_result', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), betId, externalTransactionId: extTxId, roundId,
            betAmount: 5, winAmount: 10, effectiveTurnover: 5, winLoss: 5, jackpotAmount: 0,
            resultType: 'END', isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(endRes.status).toBe('SC_OK')
        expect(parseFloat(endRes.data.balance)).toBeCloseTo(11629.99882734, 5)

        // 9.02.05 — adjustment +5
        const adjRes = await post('adjustment', {
            traceId: uid(), username: VALID_USER,
            transactionId: uid(), externalTransactionId: extTxId, roundId,
            amount: 5, currency: CURRENCY, gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(adjRes.status).toBe('SC_OK')
        expect(parseFloat(adjRes.data.balance)).toBeCloseTo(11634.99882734, 5)
    })

    it('9.05 8.06.03 wallet/bet raw body failure check', async () => {
        await setBalance(validUserId, 1)

        const rawBody = `{"traceId":"0c04f1f3-32ee-41a4-a7d3-80500507c374","username":"defefe","transactionId":"OneApi48ed6672-929f-41f4-a97a-b5b6e700dcab","betId":"OneApieacd2237-02c6-4c11-945b-a675951316f2","externalTransactionId":"OneApi9399317847001","amount":"11614.99882734100","currency":"ETB","token":"6b149bc8-1889-4734-a077-954d7ebd8c7f","gameCode":"SPB_aviator","roundId":"OneApi4752706831075","timestamp":1776659948149}`;

        const res = await app.inject({
            method: 'POST',
            url: `/wallet/bet`,
            payload: rawBody,
            headers: {
                'content-type': 'application/json',
                'x-signature': '48f83fc050820b5c814a86f39cfa58d30b169873beef0ef5ced9128bcec18b37',
                'x-api-key': API_KEY,
            },
        })
        const body = JSON.parse(res.body)

        expect(body.traceId).toBe("0c04f1f3-32ee-41a4-a7d3-80500507c374")
        expect(body.status).toBe("SC_INSUFFICIENT_FUNDS")
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 10 — Spec Error Codes (documented in API Response Statuses table)
// These are statuses defined in the official GASea Seamless Wallet API spec
// that are not covered by the verification tool dashboard groups above.
// ─────────────────────────────────────────────────────────────────────────────

describe('GROUP 10 — Spec Error Codes', () => {
    // ── SC_WRONG_CURRENCY ──────────────────────────────────────────────────────
    // Spec: "Transaction's currency is different from user's wallet currency."

    it('10.01 wallet/balance with wrong currency → SC_WRONG_CURRENCY', async () => {
        const traceId = uid()
        const res = await post('balance', {
            traceId, username: VALID_USER, currency: WRONG_CURRENCY, token: TOKEN,
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_WRONG_CURRENCY')
        expect(res.data).toBeUndefined()
    })

    it('10.02 wallet/bet with wrong currency → SC_WRONG_CURRENCY', async () => {
        const traceId = uid()
        const res = await post('bet', {
            traceId, username: VALID_USER,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            amount: 5, currency: WRONG_CURRENCY, token: TOKEN,
            gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_WRONG_CURRENCY')
        expect(res.data).toBeUndefined()
    })

    it('10.03 wallet/bet_result with wrong currency → SC_WRONG_CURRENCY', async () => {
        const traceId = uid()
        const res = await post('bet_result', {
            traceId, username: VALID_USER,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(), roundId: uid(),
            betAmount: 5, winAmount: 10, effectiveTurnover: 5, winLoss: 5, jackpotAmount: 0,
            resultType: 'WIN', isFreespin: 0, isEndRound: 1,
            currency: WRONG_CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_WRONG_CURRENCY')
        expect(res.data).toBeUndefined()
    })

    it('10.04 wallet/rollback with wrong currency → SC_WRONG_CURRENCY', async () => {
        const traceId = uid()
        const res = await post('rollback', {
            traceId,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            username: VALID_USER, currency: WRONG_CURRENCY, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_WRONG_CURRENCY')
        expect(res.data).toBeUndefined()
    })

    it('10.05 wallet/adjustment with wrong currency → SC_WRONG_CURRENCY', async () => {
        const traceId = uid()
        const res = await post('adjustment', {
            traceId, username: VALID_USER, transactionId: uid(),
            roundId: uid(), gameCode: GAME_CODE,
            amount: 10, currency: WRONG_CURRENCY, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_WRONG_CURRENCY')
        expect(res.data).toBeUndefined()
    })

    it('10.06 wallet/bet_debit with wrong currency → SC_WRONG_CURRENCY', async () => {
        const traceId = uid()
        const res = await post('bet_debit', {
            traceId, username: VALID_USER, transactionId: uid(),
            roundId: uid(), amount: 10, currency: WRONG_CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_WRONG_CURRENCY')
        expect(res.data).toBeUndefined()
    })

    it('10.07 wallet/bet_credit with wrong currency → SC_WRONG_CURRENCY', async () => {
        const traceId = uid()
        const res = await post('bet_credit', {
            traceId, username: VALID_USER, transactionId: uid(),
            roundId: uid(), isRefund: 0, amount: 10,
            betAmount: 10, winAmount: 10, effectiveTurnover: 10,
            winLoss: 0, jackpotAmount: 0, currency: WRONG_CURRENCY,
            token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(), timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_WRONG_CURRENCY')
        expect(res.data).toBeUndefined()
    })

    // ── SC_USER_DISABLED ───────────────────────────────────────────────────────
    // Spec: "User is disabled and not allowed to place bets."

    it('10.08 wallet/balance for disabled user → SC_USER_DISABLED', async () => {
        const traceId = uid()
        const res = await post('balance', {
            traceId, username: DISABLED_USER, currency: CURRENCY, token: TOKEN,
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_USER_DISABLED')
        expect(res.data).toBeUndefined()
    })

    it('10.09 wallet/bet for disabled user → SC_USER_DISABLED', async () => {
        const traceId = uid()
        const res = await post('bet', {
            traceId, username: DISABLED_USER,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(),
            amount: 5, currency: CURRENCY, token: TOKEN,
            gameCode: GAME_CODE, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_USER_DISABLED')
        expect(res.data).toBeUndefined()
    })

    it('10.10 wallet/bet_debit for disabled user → SC_USER_DISABLED', async () => {
        const traceId = uid()
        const res = await post('bet_debit', {
            traceId, username: DISABLED_USER, transactionId: uid(),
            roundId: uid(), amount: 5, currency: CURRENCY,
            gameCode: GAME_CODE, token: TOKEN, timestamp: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        expect(res.status).toBe('SC_USER_DISABLED')
        expect(res.data).toBeUndefined()
    })

    // ── 10.01 — Bet Not Found ──────────────────────────────────────────────────
    // bet_result for a betId that was never placed. GASea verification tool 10.01.01.

    it('10.01.01 wallet/bet_result with unknown betId → SC_TRANSACTION_NOT_EXISTS', async () => {
        const traceId = uid()
        const res = await post('bet_result', {
            traceId, username: VALID_USER,
            transactionId: uid(), betId: uid(), externalTransactionId: uid(), roundId: uid(),
            betAmount: 5, winAmount: 0, effectiveTurnover: 5, winLoss: -5, jackpotAmount: 0,
            resultType: 'LOSE', isFreespin: 0, isEndRound: 1,
            currency: CURRENCY, token: TOKEN, gameCode: GAME_CODE,
            betTime: Date.now(), settledTime: Date.now(),
        })
        expect(res.traceId).toBe(traceId)
        // Spec: bet_result referencing an unknown bet should be rejected
        expect(res.status).toBe('SC_TRANSACTION_NOT_EXISTS')
        expect(res.data).toBeUndefined()
    })
})

