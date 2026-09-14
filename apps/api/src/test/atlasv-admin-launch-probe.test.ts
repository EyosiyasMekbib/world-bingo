import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../lib/prisma.js', () => ({ default: { user: { findUnique: vi.fn() } } }))
const { getGameUrl } = vi.hoisted(() => ({ getGameUrl: vi.fn() }))
vi.mock('../gateways/game-provider/index.js', () => ({ getGameProviderGateway: vi.fn(() => ({ getGameUrl })) }))

const ADMIN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

async function buildApp(userId: string | null = ADMIN_ID) {
    const app = Fastify()
    app.addHook('onRequest', async (req: any) => {
        if (userId) req.user = { id: userId }
    })
    const { default: atlasVAdminRoutes } = await import('../routes/admin/atlasv.js')
    await app.register(atlasVAdminRoutes, { prefix: '/admin/game-providers/atlasv' })
    return app
}

const probe = (app: Awaited<ReturnType<typeof buildApp>>, payload: object) =>
    app.inject({ method: 'POST', url: '/admin/game-providers/atlasv/launch-probe', payload })

describe('POST /admin/game-providers/atlasv/launch-probe', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv('ATLASV_SERVER_URL', 'https://atlasv.test')
        vi.stubEnv('ATLASV_CASINO_ID', 'casino1')
        vi.stubEnv('ATLASV_PRIVATE_KEY', 'key')
    })

    it('reports a working launch with the URL host only', async () => {
        getGameUrl.mockResolvedValue({ gameUrl: 'https://play.atlasv.test/session/secret-token', token: '' })
        const res = await probe(await buildApp(), { gameCode: 'penalty' })
        expect(res.statusCode).toBe(200)
        expect(res.json()).toMatchObject({
            ok: true,
            gameUrlHost: 'play.atlasv.test',
            config: { serverUrlSet: true, casinoIdSet: true, privateKeySet: true },
        })
        expect(res.body).not.toContain('secret-token')
        expect(getGameUrl).toHaveBeenCalledWith(
            expect.objectContaining({ username: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', gameCode: 'penalty', platform: 'WEB' }),
        )
    })

    it('flags a non-https game URL as ok: false without a gameUrlHost', async () => {
        getGameUrl.mockResolvedValue({ gameUrl: 'http://play.atlasv.test/session/secret-token', token: '' })
        const res = await probe(await buildApp(), { gameCode: 'penalty' })
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body).toEqual({
            ok: false,
            latencyMs: expect.any(Number),
            code: 'ATLASV_INSECURE_GAME_URL',
            message: expect.any(String),
            config: { serverUrlSet: true, casinoIdSet: true, privateKeySet: true },
        })
        expect(body.message).toContain('http:')
        expect(res.body).not.toContain('play.atlasv.test')
        expect(res.body).not.toContain('secret-token')
    })

    it('flags an unparseable game URL as ok: false without leaking it', async () => {
        getGameUrl.mockResolvedValue({ gameUrl: 'not-a-url-secret-token', token: '' })
        const res = await probe(await buildApp(), { gameCode: 'penalty' })
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body).toEqual({
            ok: false,
            latencyMs: expect.any(Number),
            code: 'ATLASV_INSECURE_GAME_URL',
            message: expect.any(String),
            config: { serverUrlSet: true, casinoIdSet: true, privateKeySet: true },
        })
        expect(res.body).not.toContain('not-a-url-secret-token')
    })

    it('returns the upstream error instead of throwing', async () => {
        getGameUrl.mockRejectedValue(
            Object.assign(new Error('Atlas-V upstream returned HTTP 500: {"error":"bad casino"}'), { code: 'ATLASV_UPSTREAM_HTTP_ERROR' }),
        )
        const res = await probe(await buildApp(), { gameCode: 'keno' })
        expect(res.statusCode).toBe(200)
        expect(res.json()).toMatchObject({
            ok: false,
            code: 'ATLASV_UPSTREAM_HTTP_ERROR',
            message: 'Atlas-V upstream returned HTTP 500: {"error":"bad casino"}',
        })
    })

    it('reports missing configuration as booleans', async () => {
        vi.stubEnv('ATLASV_CASINO_ID', '')
        getGameUrl.mockRejectedValue(
            Object.assign(new Error('Atlas-V is not configured: ATLASV_CASINO_ID is empty in this container'), { code: 'ATLASV_NOT_CONFIGURED' }),
        )
        const res = await probe(await buildApp(), { gameCode: 'keno' })
        expect(res.json()).toMatchObject({ ok: false, code: 'ATLASV_NOT_CONFIGURED', config: { casinoIdSet: false } })
    })

    it('400s without a gameCode', async () => {
        const res = await probe(await buildApp(), {})
        expect(res.statusCode).toBe(400)
    })

    it('401s without an authenticated user', async () => {
        const res = await probe(await buildApp(null), { gameCode: 'keno' })
        expect(res.statusCode).toBe(401)
    })
})
