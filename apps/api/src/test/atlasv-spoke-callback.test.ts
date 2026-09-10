import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { signBody } from '../gateways/hub/hub-auth.js'
import { resetDeploymentConfigForTests } from '../gateways/hub/deployment-config.js'

vi.mock('../services/atlasv-wallet.service.js', () => ({
    AtlasVWalletService: {
        dispatch: vi.fn(async (action: string, d: any) => ({ player_id: d.player_id, balance: 12.5 })),
    },
}))

const SECRET = 'sec1'
beforeEach(() => {
    process.env.DEPLOYMENT_ROLE = 'spoke'
    process.env.DEPLOYMENT_CODE = 's01'
    process.env.HUB_URL = 'https://hub'
    process.env.HUB_SHARED_SECRET = SECRET
    resetDeploymentConfigForTests()
})

async function buildApp() {
    const app = Fastify()
    const { atlasVSpokeCallbackRoute } = await import('../routes/hub/atlasv-spoke-callback.js')
    await app.register(atlasVSpokeCallbackRoute, { prefix: '/v1/hub/atlasv-spoke-callback' })
    return app
}

describe('atlasv-spoke-callback sink', () => {
    it('accepts a correctly signed bet callback', async () => {
        const app = await buildApp()
        const body = JSON.stringify({ action: 'bet', data: { player_id: 'a'.repeat(32) } })
        const res = await app.inject({
            method: 'POST',
            url: '/v1/hub/atlasv-spoke-callback',
            headers: { 'content-type': 'application/json', 'x-deployment': 'h00', 'x-signature': signBody(SECRET, body) },
            payload: body,
        })
        expect(res.statusCode).toBe(200)
        expect(res.json()).toMatchObject({ player_id: 'a'.repeat(32), balance: 12.5 })
    })

    it('rejects a bad signature with 401', async () => {
        const app = await buildApp()
        const body = JSON.stringify({ action: 'bet', data: { player_id: 'a'.repeat(32) } })
        const res = await app.inject({
            method: 'POST',
            url: '/v1/hub/atlasv-spoke-callback',
            headers: { 'content-type': 'application/json', 'x-deployment': 'h00', 'x-signature': 'deadbeef' },
            payload: body,
        })
        expect(res.statusCode).toBe(401)
    })
})
