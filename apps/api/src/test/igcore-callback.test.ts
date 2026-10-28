import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../services/igcore-wallet.service.js', () => ({
    IgcoreWalletService: { dispatch: vi.fn() },
}))

import { signIgcoreBody } from '../gateways/igcore/igcore-signature.js'
import { IgcoreWalletService } from '../services/igcore-wallet.service.js'

const dispatch = IgcoreWalletService.dispatch as unknown as ReturnType<typeof vi.fn>

async function buildApp() {
    const app = Fastify()
    const { igcoreCallbackRoutes } = await import('../routes/igcore/callback.js')
    await app.register(igcoreCallbackRoutes, { prefix: '/v1/igcore' })
    return app
}

/** Signs the exact string and posts those exact bytes, the way IGCORE does. */
function post(app: Awaited<ReturnType<typeof buildApp>>, url: string, raw: string, hash?: string | null) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (hash !== null) headers['x-security-hash'] = hash ?? signIgcoreBody(raw, 's')
    return app.inject({ method: 'POST', url, headers, payload: raw })
}

const BET = JSON.stringify({ transaction_id: 'c-1', action: 'bet', user_id: 'u', currency: 'ETB', amount: 25 })

describe('IGCORE callback routes', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv('IGCORE_SECURITY_HASH', 's')
        vi.stubEnv('IGCORE_CALLBACK_DEBUG', 'false')
    })
    afterEach(() => vi.unstubAllEnvs())

    it('accepts a signed bet and answers the client id', async () => {
        dispatch.mockResolvedValue({ kind: 'ok', transactionId: 'c-1', userId: 'u' })
        const app = await buildApp()

        const res = await post(app, '/v1/igcore/transaction', BET)

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ error: null, transaction_id: 'c-1' })
        expect(dispatch).toHaveBeenCalledWith('transaction', expect.objectContaining({ transaction_id: 'c-1', action: 'bet' }))
    })

    it('accepts a content-type that carries a charset', async () => {
        dispatch.mockResolvedValue({ kind: 'ok', transactionId: 'c-1', userId: 'u' })
        const app = await buildApp()

        const res = await app.inject({
            method: 'POST',
            url: '/v1/igcore/transaction',
            headers: { 'content-type': 'application/json; charset=utf-8', 'x-security-hash': signIgcoreBody(BET, 's') },
            payload: BET,
        })

        expect(res.statusCode).toBe(200)
        expect(dispatch).toHaveBeenCalledTimes(1)
    })

    it('rejects a wrong hash with 400 and never dispatches', async () => {
        const app = await buildApp()

        const res = await post(app, '/v1/igcore/transaction', BET, 'f'.repeat(64))

        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual({ error: 'INVALID_SIGNATURE' })
        expect(dispatch).not.toHaveBeenCalled()
    })

    it('rejects a missing hash with 400 and never dispatches', async () => {
        const app = await buildApp()

        const res = await post(app, '/v1/igcore/transaction', BET, null)

        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual({ error: 'INVALID_SIGNATURE' })
        expect(dispatch).not.toHaveBeenCalled()
    })

    it('rejects everything when the secret is not configured', async () => {
        vi.stubEnv('IGCORE_SECURITY_HASH', '')
        const app = await buildApp()

        const res = await post(app, '/v1/igcore/transaction', BET, signIgcoreBody(BET, ''))

        expect(res.statusCode).toBe(400)
        expect(dispatch).not.toHaveBeenCalled()
    })

    it('rejects an empty body with 400 INVALID_SIGNATURE instead of crashing', async () => {
        const app = await buildApp()

        for (const hash of [null, 'f'.repeat(64)]) {
            const res = await post(app, '/v1/igcore/transaction', '', hash)
            expect(res.statusCode, String(hash)).toBe(400)
            expect(res.json(), String(hash)).toEqual({ error: 'INVALID_SIGNATURE' })
        }
        expect(dispatch).not.toHaveBeenCalled()
    })

    it('an empty body that carries a valid digest of nothing is still a 400, as INVALID_JSON', async () => {
        const app = await buildApp()

        const res = await post(app, '/v1/igcore/transaction', '')

        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual({ error: 'INVALID_JSON' })
        expect(dispatch).not.toHaveBeenCalled()
    })

    it('verifies the raw bytes', async () => {
        // Whitespace and `25.0` do not survive JSON.parse + JSON.stringify, so a
        // route that re-serialised the body would compute a different digest.
        dispatch.mockResolvedValue({ kind: 'ok', transactionId: 't', userId: 'u' })
        const app = await buildApp()
        const raw = '{"transaction_id":"t", "action":"bet","amount":25.0}'

        const res = await post(app, '/v1/igcore/transaction', raw)

        expect(res.statusCode).toBe(200)
        expect(dispatch).toHaveBeenCalledWith('transaction', { transaction_id: 't', action: 'bet', amount: 25 })
    })

    it('maps reject to 200 with the error', async () => {
        dispatch.mockResolvedValue({ kind: 'reject', error: 'INSUFFICIENT_FUNDS' })
        const app = await buildApp()

        const res = await post(app, '/v1/igcore/transaction', BET)

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ error: 'INSUFFICIENT_FUNDS' })
    })

    it('maps retry to 500', async () => {
        dispatch.mockResolvedValue({ kind: 'retry', reason: 'transaction_id belongs to another player' })
        const app = await buildApp()

        const res = await post(app, '/v1/igcore/transaction', BET)

        expect(res.statusCode).toBe(500)
        expect(res.json()).toEqual({ error: 'RETRY' })
    })

    it('maps a thrown error to 500', async () => {
        dispatch.mockRejectedValue(new Error('db down'))
        const app = await buildApp()

        const res = await post(app, '/v1/igcore/transaction', BET)

        expect(res.statusCode).toBe(500)
        expect(res.json()).toEqual({ error: 'RETRY' })
    })

    it('rollback endpoint dispatches as transaction-rollback', async () => {
        dispatch.mockResolvedValue({ kind: 'ok', transactionId: 'rb-1', userId: 'u' })
        const app = await buildApp()
        const raw = JSON.stringify({ transaction_id: 'r-1', action: 'rollback', user_id: 'u', rollback_transaction_id: 'c-1', rollback_transaction_action: 'bet' })

        const res = await post(app, '/v1/igcore/transaction-rollback', raw)

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ error: null, transaction_id: 'rb-1' })
        expect(dispatch).toHaveBeenCalledWith('transaction-rollback', expect.objectContaining({ action: 'rollback' }))
    })

    it('bad JSON with a valid signature → 400 INVALID_JSON', async () => {
        const app = await buildApp()

        const res = await post(app, '/v1/igcore/transaction', '{"transaction_id": ')

        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual({ error: 'INVALID_JSON' })
        expect(dispatch).not.toHaveBeenCalled()
    })

    it('a signed body that is not a JSON object → 400 INVALID_JSON', async () => {
        const app = await buildApp()

        for (const raw of ['null', '[1]', '"x"', '7']) {
            const res = await post(app, '/v1/igcore/transaction', raw)
            expect(res.statusCode, raw).toBe(400)
            expect(res.json(), raw).toEqual({ error: 'INVALID_JSON' })
        }
        expect(dispatch).not.toHaveBeenCalled()
    })

    it('logs the raw body and expected hash at warn only when callbackDebug is on', async () => {
        const seen: any[] = []
        const app = Fastify({
            logger: { level: 'warn', stream: { write: (line: string) => { seen.push(JSON.parse(line)) } } },
        })
        const { igcoreCallbackRoutes } = await import('../routes/igcore/callback.js')
        await app.register(igcoreCallbackRoutes, { prefix: '/v1/igcore' })
        const expected = signIgcoreBody(BET, 's')

        await post(app as any, '/v1/igcore/transaction', BET, 'f'.repeat(64))
        expect(JSON.stringify(seen)).not.toContain(expected)

        vi.stubEnv('IGCORE_CALLBACK_DEBUG', 'true')
        seen.length = 0
        await post(app as any, '/v1/igcore/transaction', BET, 'f'.repeat(64))
        const dump = JSON.stringify(seen)
        expect(dump).toContain(expected)
        expect(dump).toContain('c-1')
    })
})
