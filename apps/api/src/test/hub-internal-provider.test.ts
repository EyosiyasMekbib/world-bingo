import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { signBody } from '../gateways/hub/hub-auth.js'
import { resetDeploymentConfigForTests } from '../gateways/hub/deployment-config.js'

const getGameUrl = vi.fn(async (p: any) => ({ gameUrl: 'https://play/' + p.username, token: 'tok' }))
const terminateSession = vi.fn(async (_u: string) => {})
const getGames = vi.fn(async () => ({ games: [], currentPage: 1, totalItems: 0, totalPages: 0 }))
vi.mock('../gateways/game-provider/index.js', () => ({
  getGameProviderGateway: () => ({ providerCode: 'palace', getGameUrl, terminateSession, getGames }),
}))

const SECRET = 'sec1'
beforeEach(() => {
  process.env.DEPLOYMENT_ROLE = 'hub'
  process.env.DEPLOYMENT_CODE = 'h00'
  process.env.HUB_DEPLOYMENTS = JSON.stringify([{ code: 's01', baseUrl: 'https://s01', secret: SECRET }])
  resetDeploymentConfigForTests()
  getGameUrl.mockClear(); terminateSession.mockClear(); getGames.mockClear()
})

async function buildApp() {
  const app = Fastify()
  const { internalProviderRoute } = await import('../routes/hub/internal-provider.js')
  await app.register(internalProviderRoute, { prefix: '/v1/hub/provider' })
  return app
}

function post(app: any, payloadObj: any, secret = SECRET, dep = 's01') {
  const body = JSON.stringify(payloadObj)
  return app.inject({
    method: 'POST', url: '/v1/hub/provider',
    headers: { 'content-type': 'application/json', 'x-deployment': dep, 'x-signature': signBody(secret, body) },
    payload: body,
  })
}

describe('internal provider API', () => {
  it('namespaces the account for a launch from s01', async () => {
    const app = await buildApp()
    const res = await post(app, { providerCode: 'palace', method: 'getGameUrl', params: { username: 'a'.repeat(32), gameCode: 'g', language: 'en', platform: 'WEB', currency: 'ETB', lobbyUrl: 'https://l/', ipAddress: '1.1.1.1' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
    // Hub prepended s01 to the username before calling the real gateway.
    expect(getGameUrl).toHaveBeenCalledWith(expect.objectContaining({ username: 's01' + 'a'.repeat(32) }))
  })

  it('namespaces the username for terminateSession (passed as a string)', async () => {
    const app = await buildApp()
    const res = await post(app, { providerCode: 'palace', method: 'terminateSession', params: { username: 'b'.repeat(32) } })
    expect(res.statusCode).toBe(200)
    expect(terminateSession).toHaveBeenCalledWith('s01' + 'b'.repeat(32))
  })

  it('proxies a positional catalog method without namespacing', async () => {
    const app = await buildApp()
    const res = await post(app, { providerCode: 'palace', method: 'getGames', params: { args: ['vendorX', 1, 60, 'ETB', 'en'] } })
    expect(res.statusCode).toBe(200)
    expect(getGames).toHaveBeenCalledWith('vendorX', 1, 60, 'ETB', 'en')
  })

  it('rejects an unknown / unsigned deployment with 401', async () => {
    const app = await buildApp()
    const res = await post(app, { providerCode: 'palace', method: 'getGameUrl', params: {} }, 'wrong-secret')
    expect(res.statusCode).toBe(401)
  })

  it('returns provider errors in the body (ok:false), not as a throw', async () => {
    getGameUrl.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'PALACE_X', palaceCode: 42 }))
    const app = await buildApp()
    const res = await post(app, { providerCode: 'palace', method: 'getGameUrl', params: { username: 'c'.repeat(32) } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: false, error: { message: 'boom', code: 'PALACE_X', palaceCode: 42 } })
  })
})
