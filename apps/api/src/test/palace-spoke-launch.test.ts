import { describe, it, expect, vi, beforeEach } from 'vitest'

// A Palace game launched from a SPOKE arrives at the hub namespaced with the
// spoke's 3-char deployment code (e.g. "btb<uuid-hex>"). That player lives only
// in the spoke's DB, never the hub's — so getUserCode must NOT resolve a local
// user; it provisions/caches the Palace user_code keyed by the account string.

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)
vi.stubEnv('PALACE_API_BASE_URL', 'https://palace.test')
vi.stubEnv('PALACE_API_TOKEN', 'test-token')

// Configure this deployment as a HUB that knows spoke "btb".
vi.stubEnv('DEPLOYMENT_ROLE', 'hub')
vi.stubEnv('DEPLOYMENT_CODE', 'h00')
vi.stubEnv('HUB_DEPLOYMENTS', JSON.stringify([{ code: 'btb', baseUrl: 'http://spoke', secret: 's' }]))

const prismaMock = {
  gameProvider: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  providerUserAccount: { findUnique: vi.fn(), create: vi.fn() },
  providerGame: { findUnique: vi.fn() },
}
vi.mock('../lib/prisma.js', () => ({ default: prismaMock }))

const redisMock = { get: vi.fn(), set: vi.fn() }
vi.mock('../lib/redis.js', () => ({ default: redisMock }))

function jsonOk(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ code: 0, message: 'OK', data }) }
}

const SPOKE_ACCT = 'btb' + 'a'.repeat(32) // 35 chars: spoke code + 32 hex
const LAUNCH = {
  gameCode: 'g1',
  language: 'en',
  platform: 'WEB' as const,
  currency: 'ETB',
  lobbyUrl: 'https://lobby/',
  ipAddress: '127.0.0.1',
}

describe('PalaceGateway spoke-forwarded launch', () => {
  beforeEach(async () => {
    mockFetch.mockReset()
    for (const model of Object.values(prismaMock)) {
      for (const fn of Object.values(model)) fn.mockReset()
    }
    redisMock.get.mockReset()
    redisMock.set.mockReset()
    prismaMock.gameProvider.findUnique.mockResolvedValue({ id: 'prov1', code: 'palace' })
    prismaMock.providerGame.findUnique.mockResolvedValue({ vendor: { code: 'palace:1' } })
    const { resetDeploymentConfigForTests } = await import('../gateways/hub/deployment-config.js')
    resetDeploymentConfigForTests()
  })

  it('provisions user_code by account string with NO local user lookup (cache miss)', async () => {
    redisMock.get.mockResolvedValue(null)
    mockFetch
      .mockResolvedValueOnce(jsonOk({ user_code: 777 })) // /v4/user/create
      .mockResolvedValueOnce(jsonOk({ game_url: 'https://play/game' })) // /v4/game/game-url

    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    const res = await new PalaceGateway().getGameUrl({ username: SPOKE_ACCT, ...LAUNCH })

    expect(res.gameUrl).toBe('https://play/game')
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://palace.test/v4/user/create',
      expect.objectContaining({ body: JSON.stringify({ name: SPOKE_ACCT }) }),
    )
    expect(redisMock.set).toHaveBeenCalledWith(`palace:usercode:${SPOKE_ACCT}`, '777')
  })

  it('uses the Redis-cached user_code on a hit (no /v4/user/create)', async () => {
    redisMock.get.mockResolvedValue('777')
    mockFetch.mockResolvedValueOnce(jsonOk({ game_url: 'https://play/game' }))

    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    const res = await new PalaceGateway().getGameUrl({ username: SPOKE_ACCT, ...LAUNCH })

    expect(res.gameUrl).toBe('https://play/game')
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith('https://palace.test/v4/game/game-url', expect.anything())
  })

  it("hub-own namespaced account still resolves a LOCAL user (unchanged path)", async () => {
    const HUB_ACCT = 'h00' + 'b'.repeat(32)
    redisMock.get.mockResolvedValue(null)
    prismaMock.user.findUnique.mockResolvedValue({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })
    prismaMock.providerUserAccount.findUnique.mockResolvedValue({ externalUserCode: '999' })
    mockFetch.mockResolvedValueOnce(jsonOk({ game_url: 'https://play/game' }))

    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    await new PalaceGateway().getGameUrl({ username: HUB_ACCT, ...LAUNCH })

    expect(prismaMock.user.findUnique).toHaveBeenCalled()
    expect(redisMock.set).not.toHaveBeenCalled()
  })
})
