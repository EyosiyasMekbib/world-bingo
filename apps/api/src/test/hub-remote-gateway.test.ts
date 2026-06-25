import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetDeploymentConfigForTests } from '../gateways/hub/deployment-config.js'

const fetchMock = vi.fn(async (_url: string, _opts?: any) => ({ ok: true, json: async () => ({ ok: true, result: { gameUrl: 'https://play', token: 't' } }) }))
vi.stubGlobal('fetch', fetchMock)

beforeEach(() => {
  process.env.DEPLOYMENT_ROLE = 'spoke'
  process.env.DEPLOYMENT_CODE = 's01'
  process.env.HUB_URL = 'https://hub'
  process.env.HUB_SHARED_SECRET = 'sec1'
  resetDeploymentConfigForTests()
  fetchMock.mockClear()
})

describe('RemoteGameProviderGateway', () => {
  it('forwards getGameUrl to the hub with an HMAC header', async () => {
    const { RemoteGameProviderGateway } = await import('../gateways/hub/remote-game-provider.gateway.js')
    const gw = new RemoteGameProviderGateway('palace')
    const out = await gw.getGameUrl({ username: 'a'.repeat(32), gameCode: 'g', language: 'en', platform: 'WEB', currency: 'ETB', lobbyUrl: 'https://l/', ipAddress: '1.1.1.1' })
    expect(out).toEqual({ gameUrl: 'https://play', token: 't' })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://hub/v1/hub/provider')
    expect((opts as any).headers['x-deployment']).toBe('s01')
    expect((opts as any).headers['x-signature']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('surfaces a hub ok:false error as a thrown error with code/palaceCode', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, error: { message: 'nope', code: 'PALACE_X', palaceCode: 42 } }) } as any)
    const { RemoteGameProviderGateway } = await import('../gateways/hub/remote-game-provider.gateway.js')
    const gw = new RemoteGameProviderGateway('palace')
    await expect(gw.terminateSession('a'.repeat(32))).rejects.toMatchObject({ message: 'nope', code: 'PALACE_X', palaceCode: 42 })
  })

  it('throws on a non-2xx transport failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) } as any)
    const { RemoteGameProviderGateway } = await import('../gateways/hub/remote-game-provider.gateway.js')
    const gw = new RemoteGameProviderGateway('palace')
    await expect(gw.getVendors('ETB', 'en')).rejects.toThrow(/502/)
  })
})
