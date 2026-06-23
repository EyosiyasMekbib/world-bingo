import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.stubEnv('PALACE_API_BASE_URL', 'https://palace.test')
vi.stubEnv('PALACE_API_TOKEN', 'test-token')

function jsonOk(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ code: 0, message: 'OK', data }) }
}

describe('PalaceGateway', () => {
  beforeEach(() => { mockFetch.mockReset() })

  it('getVendors maps provider list to Vendor[]', async () => {
    mockFetch.mockResolvedValue(jsonOk([
      { provider_id: 1, provider_name: 'Pragmatic Play', locale_name: 'Pragmatic Play', status: 1 },
    ]))
    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    const gw = new PalaceGateway()
    const vendors = await gw.getVendors('ETB', 'en')
    expect(vendors).toEqual([
      { code: 'palace:1', name: 'Pragmatic Play', currencyCodes: ['ETB'], categoryCodes: ['SLOTS'] },
    ])
    expect(mockFetch).toHaveBeenCalledWith(
      'https://palace.test/v4/game/providers',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    )
  })

  it('getVendors filters out inactive providers (status !== 1)', async () => {
    mockFetch.mockResolvedValue(jsonOk([
      { provider_id: 1, provider_name: 'Active', status: 1 },
      { provider_id: 2, provider_name: 'Inactive', status: 0 },
    ]))
    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    const gw = new PalaceGateway()
    const vendors = await gw.getVendors('ETB', 'en')
    expect(vendors).toHaveLength(1)
    expect(vendors[0].code).toBe('palace:1')
  })

  it('getGames extracts provider_id from vendor code and returns GameListResult', async () => {
    mockFetch.mockResolvedValue(jsonOk([
      { provider_id: 1, game_code: 'vswaysdogs', game_name: 'Dog House', game_image: 'https://img', launch_enable: true, category: 'Slots' },
      { provider_id: 1, game_code: 'disabled', game_name: 'Disabled Game', game_image: null, launch_enable: false, category: 'Slots' },
    ]))
    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    const gw = new PalaceGateway()
    const result = await gw.getGames('palace:1', 1, 100, 'ETB', 'en')
    expect(result.games).toHaveLength(1)
    expect(result.games[0]).toMatchObject({ gameCode: 'vswaysdogs', gameName: 'Dog House', categoryCode: 'SLOTS' })
    expect(result.totalPages).toBe(1)
    expect(result.totalItems).toBe(1)
  })

  it('throws on non-zero response code', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 2002, message: 'USER_NOT_FOUND', data: null }) })
    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    const gw = new PalaceGateway()
    await expect(gw.getVendors('ETB', 'en')).rejects.toThrow('Palace error: 2002')
  })

  it('throws on non-ok HTTP status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 })
    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    const gw = new PalaceGateway()
    await expect(gw.getVendors('ETB', 'en')).rejects.toThrow('Palace /v4/game/providers responded 503')
  })
})
