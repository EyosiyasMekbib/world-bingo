import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)
vi.stubEnv('ATLASV_SERVER_URL', 'https://atlasv.test')
vi.stubEnv('ATLASV_GAME_SERVER_URL', 'https://atlasv.test')
vi.stubEnv('ATLASV_PRIVATE_KEY', 'test-key')
vi.stubEnv('ATLASV_CASINO_ID', 'casino1')
vi.stubEnv('ATLASV_PARTNER_ID', '1')

function jsonOk(data: unknown) {
    return { ok: true, status: 200, json: async () => data }
}

describe('AtlasVGateway', () => {
    beforeEach(() => { mockFetch.mockReset() })

    it('getGameUrl calls /init and maps the url', async () => {
        mockFetch.mockResolvedValue(jsonOk({ url: 'https://play.atlasv.test/session/abc' }))
        const { AtlasVGateway } = await import('../gateways/game-provider/atlasv.gateway.js')
        const gw = new AtlasVGateway()
        const res = await gw.getGameUrl({
            username: 'p1'.padEnd(32, '0'), gameCode: 'penalty', language: 'en',
            platform: 'WEB', currency: 'ETB', lobbyUrl: 'https://lobby/', ipAddress: '127.0.0.1',
        })
        expect(res).toEqual({ gameUrl: 'https://play.atlasv.test/session/abc', token: '' })
        expect(mockFetch).toHaveBeenCalledWith('https://atlasv.test/init', expect.objectContaining({ method: 'POST' }))
        const sentBody = JSON.parse((mockFetch.mock.calls[0][1] as any).body)
        expect(sentBody).toMatchObject({ game: 'penalty', casino_id: 'casino1', partner_id: '1', player_id: 'p1'.padEnd(32, '0') })
        expect(sentBody.hash).toMatch(/^[0-9a-f]{40}$/)
    })

    it('throws AtlasVApiError when /init returns no url', async () => {
        mockFetch.mockResolvedValue(jsonOk({}))
        const { AtlasVGateway, AtlasVApiError } = await import('../gateways/game-provider/atlasv.gateway.js')
        const gw = new AtlasVGateway()
        await expect(gw.getGameUrl({
            username: 'p1', gameCode: 'penalty', language: 'en', platform: 'WEB',
            currency: 'ETB', lobbyUrl: 'https://lobby/', ipAddress: '127.0.0.1',
        })).rejects.toMatchObject({ constructor: AtlasVApiError, code: 'ATLASV_EMPTY_RESPONSE' })
    })

    it('throws AtlasVApiError on non-ok HTTP status', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 503 })
        const { AtlasVGateway, AtlasVApiError } = await import('../gateways/game-provider/atlasv.gateway.js')
        const gw = new AtlasVGateway()
        await expect(gw.getGameUrl({
            username: 'p1', gameCode: 'penalty', language: 'en', platform: 'WEB',
            currency: 'ETB', lobbyUrl: 'https://lobby/', ipAddress: '127.0.0.1',
        })).rejects.toMatchObject({ constructor: AtlasVApiError, code: 'ATLASV_UPSTREAM_HTTP_ERROR', statusCode: 502 })
    })

    it('createFreeSpins posts to /freespin with a signed body', async () => {
        mockFetch.mockResolvedValue(jsonOk({ success: true }))
        const { AtlasVGateway } = await import('../gateways/game-provider/atlasv.gateway.js')
        const gw = new AtlasVGateway()
        await gw.createFreeSpins('p1'.padEnd(32, '0'), '2026-12-14T11:55:00+00:00', 5)
        expect(mockFetch).toHaveBeenCalledWith('https://atlasv.test/freespin', expect.objectContaining({ method: 'POST' }))
        const sentBody = JSON.parse((mockFetch.mock.calls[0][1] as any).body)
        expect(sentBody).toMatchObject({ casino_id: 'casino1', player_id: 'p1'.padEnd(32, '0'), freespins_count: 5 })
    })

    it('getVendors throws — Atlas-V has no listing API', async () => {
        const { AtlasVGateway, AtlasVApiError } = await import('../gateways/game-provider/atlasv.gateway.js')
        const gw = new AtlasVGateway()
        await expect(gw.getVendors('ETB', 'en')).rejects.toMatchObject({ constructor: AtlasVApiError, code: 'ATLASV_NOT_SUPPORTED' })
    })
})
