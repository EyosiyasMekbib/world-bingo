import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { signBody } from '../gateways/hub/hub-auth.js'
import { resetDeploymentConfigForTests } from '../gateways/hub/deployment-config.js'

vi.mock('../services/palace-wallet.service.js', () => ({
  PalaceWalletService: {
    dispatch: vi.fn(async (command: string, d: any) => ({ result: 0, status: 'OK', data: { account: d.account, balance: 12.5 } })),
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
  const { spokeCallbackRoute } = await import('../routes/hub/spoke-callback.js')
  await app.register(spokeCallbackRoute, { prefix: '/v1/hub/spoke-callback' })
  return app
}

describe('spoke-callback sink', () => {
  it('accepts a correctly signed balance callback', async () => {
    const app = await buildApp()
    const body = JSON.stringify({ command: 'balance', data: { account: 'a'.repeat(32) } })
    const res = await app.inject({
      method: 'POST', url: '/v1/hub/spoke-callback',
      headers: { 'content-type': 'application/json', 'x-deployment': 'h00', 'x-signature': signBody(SECRET, body) },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ result: 0, status: 'OK' })
  })

  it('rejects a bad signature with 401', async () => {
    const app = await buildApp()
    const body = JSON.stringify({ command: 'balance', data: { account: 'a'.repeat(32) } })
    const res = await app.inject({
      method: 'POST', url: '/v1/hub/spoke-callback',
      headers: { 'content-type': 'application/json', 'x-deployment': 'h00', 'x-signature': 'deadbeef' },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
  })
})
