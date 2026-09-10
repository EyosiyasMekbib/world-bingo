import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../services/atlasv-wallet.service.js', () => ({
    AtlasVWalletService: { dispatch: vi.fn(async (action: string, d: any) => ({ player_id: d.player_id, balance: 42 })) },
}))

vi.stubEnv('ATLASV_PRIVATE_KEY', 'test-key')

import { signAtlasVBody } from '../gateways/game-provider/atlasv-signature.js'
import { AtlasVWalletService } from '../services/atlasv-wallet.service.js'

beforeEach(() => {
    process.env.DEPLOYMENT_ROLE = 'standalone'
})

async function buildApp() {
    const app = Fastify()
    const { atlasVCallbackRoutes } = await import('../routes/atlasv/callback.js')
    await app.register(atlasVCallbackRoutes, { prefix: '/v1/atlasv/callback' })
    return app
}

describe('Atlas-V callback routes', () => {
    beforeEach(() => vi.clearAllMocks())

    it('accepts a correctly signed /bet callback and dispatches it', async () => {
        const app = await buildApp()
        const body = signAtlasVBody({
            game: 'penalty', casino_id: 'c1', player_id: 'p1'.padEnd(32, '0'),
            session_id: 's1', amount: 10, currency: 'ETB', round_id: 'r1',
            transaction_id: 't1', details: '',
        })

        const res = await app.inject({
            method: 'POST',
            url: '/v1/atlasv/callback/bet',
            headers: { 'content-type': 'text/javascript' },
            payload: body,
        })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ player_id: body.player_id, balance: 42 })
        expect(AtlasVWalletService.dispatch).toHaveBeenCalledWith('bet', expect.objectContaining({ player_id: body.player_id }))
    })

    it('rejects a tampered payload without dispatching', async () => {
        const app = await buildApp()
        const body = signAtlasVBody({ game: 'penalty', casino_id: 'c1', player_id: 'p1', session_id: 's1' })
        const tampered = { ...body, player_id: 'someone-else' }

        const res = await app.inject({
            method: 'POST',
            url: '/v1/atlasv/callback/account',
            headers: { 'content-type': 'text/javascript' },
            payload: tampered,
        })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ success: false })
        expect(AtlasVWalletService.dispatch).not.toHaveBeenCalled()
    })
})
