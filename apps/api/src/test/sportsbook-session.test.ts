import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

const startSession = vi.hoisted(() => vi.fn())
const siteSettingFindUnique = vi.hoisted(() => vi.fn())
const userFindUnique = vi.hoisted(() => vi.fn())

// The client module pulls in redis at import time; the class itself is stubbed
// but the real IgcoreApiError is kept so `instanceof` in the route is honest.
vi.mock('../lib/redis.js', () => ({ default: {} }))
vi.mock('../gateways/igcore/igcore.client.js', async () => {
    const actual = await vi.importActual<typeof import('../gateways/igcore/igcore.client.js')>(
        '../gateways/igcore/igcore.client.js',
    )
    return {
        ...actual,
        IgcoreClient: class {
            startSession = startSession
        },
    }
})
vi.mock('../lib/prisma.js', () => ({
    default: {
        siteSetting: { findUnique: siteSettingFindUnique },
        user: { findUnique: userFindUnique },
    },
}))

import { IgcoreApiError } from '../gateways/igcore/igcore.client.js'

const USER_ID = '8b1c0a3e-5f2d-4e7a-9c11-2d3f4a5b6c7d'
const BARE_ID = '8b1c0a3e5f2d4e7a9c112d3f4a5b6c7d'
const SESSION_URL = 'https://sports.example.com/iframe?token=abc'

async function buildApp() {
    const app = Fastify()
    // Stub auth: the real decorator lives in index.ts. It only has to put a user on the request.
    app.decorate('authenticate', async (req: any) => {
        req.user = { id: USER_ID }
    })
    const { default: sportsbookRoutes } = await import('../routes/sportsbook/index.js')
    await app.register(sportsbookRoutes, { prefix: '/sportsbook' })
    return app
}

function session(app: Awaited<ReturnType<typeof buildApp>>, body?: unknown) {
    return app.inject({
        method: 'POST',
        url: '/sportsbook/session',
        ...(body === undefined ? {} : { payload: body as any }),
    })
}

describe('POST /sportsbook/session', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv('IGCORE_API_URL', 'https://igcore.example.com')
        vi.stubEnv('IGCORE_USERNAME', 'u')
        vi.stubEnv('IGCORE_PASSWORD', 'p')
        vi.stubEnv('IGCORE_SECURITY_HASH', 's')
        vi.stubEnv('IGCORE_CURRENCY', 'ETB')
        vi.stubEnv('IGCORE_DEFAULT_LANG', 'en')
        siteSettingFindUnique.mockResolvedValue({ key: 'feature_sportsbook', value: 'true' })
        userFindUnique.mockResolvedValue({ id: USER_ID, accountStatus: 'ACTIVE' })
        startSession.mockResolvedValue({ url: SESSION_URL })
    })
    afterEach(() => vi.unstubAllEnvs())

    it('returns the session url', async () => {
        const app = await buildApp()

        const res = await session(app, { lang: 'en' })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ url: SESSION_URL })
        expect(siteSettingFindUnique).toHaveBeenCalledWith({ where: { key: 'feature_sportsbook' } })
        expect(startSession).toHaveBeenCalledTimes(1)
        expect(startSession).toHaveBeenCalledWith({ userId: BARE_ID, currency: 'ETB', lang: 'en' })
    })

    it('works without a request body and uses the default language', async () => {
        const app = await buildApp()

        const res = await session(app)

        expect(res.statusCode).toBe(200)
        expect(startSession).toHaveBeenCalledWith({ userId: BARE_ID, currency: 'ETB', lang: 'en' })
    })

    it('passes a supported non-default language through', async () => {
        const app = await buildApp()

        const res = await session(app, { lang: 'am' })

        expect(res.statusCode).toBe(200)
        expect(startSession).toHaveBeenCalledWith({ userId: BARE_ID, currency: 'ETB', lang: 'am' })
    })

    it('replaces an unsupported language with the default', async () => {
        const app = await buildApp()

        const res = await session(app, { lang: 'fr' })

        expect(res.statusCode).toBe(200)
        expect(startSession).toHaveBeenCalledTimes(1)
        expect(startSession).toHaveBeenCalledWith({ userId: BARE_ID, currency: 'ETB', lang: 'en' })
    })

    it('replaces a non-string language with the default', async () => {
        const app = await buildApp()

        const res = await session(app, { lang: { $ne: 'x' } })

        expect(res.statusCode).toBe(200)
        expect(startSession).toHaveBeenCalledWith({ userId: BARE_ID, currency: 'ETB', lang: 'en' })
    })

    it('503 when the flag is off', async () => {
        siteSettingFindUnique.mockResolvedValue({ key: 'feature_sportsbook', value: 'false' })
        const app = await buildApp()

        const res = await session(app, { lang: 'en' })

        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({ code: 'SPORTSBOOK_UNAVAILABLE' })
        expect(startSession).not.toHaveBeenCalled()
    })

    it('503 when the flag row does not exist', async () => {
        siteSettingFindUnique.mockResolvedValue(null)
        const app = await buildApp()

        const res = await session(app, { lang: 'en' })

        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({ code: 'SPORTSBOOK_UNAVAILABLE' })
        expect(startSession).not.toHaveBeenCalled()
    })

    it('503 when unconfigured', async () => {
        vi.stubEnv('IGCORE_API_URL', '')
        const app = await buildApp()

        const res = await session(app, { lang: 'en' })

        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({ code: 'SPORTSBOOK_UNAVAILABLE' })
        expect(startSession).not.toHaveBeenCalled()
    })

    it('503 when IGCORE errors', async () => {
        startSession.mockRejectedValue(new IgcoreApiError('NETWORK'))
        const app = await buildApp()

        const res = await session(app, { lang: 'en' })

        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({ code: 'SPORTSBOOK_UNAVAILABLE' })
    })

    it('503 when the client fails with a plain error such as a redis outage', async () => {
        startSession.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379'))
        const app = await buildApp()

        const res = await session(app, { lang: 'en' })

        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({ code: 'SPORTSBOOK_UNAVAILABLE' })
    })

    it('403 for a restricted account', async () => {
        userFindUnique.mockResolvedValue({ id: USER_ID, accountStatus: 'RESTRICTED' })
        const app = await buildApp()

        const res = await session(app, { lang: 'en' })

        expect(res.statusCode).toBe(403)
        expect(res.json()).toEqual({ code: 'ACCOUNT_RESTRICTED' })
        expect(startSession).not.toHaveBeenCalled()
    })

    it('403 when the user no longer exists', async () => {
        userFindUnique.mockResolvedValue(null)
        const app = await buildApp()

        const res = await session(app, { lang: 'en' })

        expect(res.statusCode).toBe(403)
        expect(res.json()).toEqual({ code: 'ACCOUNT_RESTRICTED' })
        expect(startSession).not.toHaveBeenCalled()
    })

    it('falls back to the default language', async () => {
        startSession.mockRejectedValueOnce(new IgcoreApiError('invalid params')).mockResolvedValueOnce({ url: SESSION_URL })
        const app = await buildApp()

        const res = await session(app, { lang: 'am' })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ url: SESSION_URL })
        expect(startSession).toHaveBeenCalledTimes(2)
        expect(startSession).toHaveBeenNthCalledWith(1, { userId: BARE_ID, currency: 'ETB', lang: 'am' })
        expect(startSession).toHaveBeenNthCalledWith(2, { userId: BARE_ID, currency: 'ETB', lang: 'en' })
    })

    it('503 when the default-language retry fails as well', async () => {
        startSession.mockRejectedValue(new IgcoreApiError('invalid params'))
        const app = await buildApp()

        const res = await session(app, { lang: 'am' })

        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({ code: 'SPORTSBOOK_UNAVAILABLE' })
        expect(startSession).toHaveBeenCalledTimes(2)
    })

    it('does not retry invalid params when the language already is the default', async () => {
        startSession.mockRejectedValue(new IgcoreApiError('invalid params'))
        const app = await buildApp()

        const res = await session(app, { lang: 'en' })

        expect(res.statusCode).toBe(503)
        expect(startSession).toHaveBeenCalledTimes(1)
    })

    it('does not retry other IGCORE errors', async () => {
        startSession.mockRejectedValue(new IgcoreApiError('currency is not allowed'))
        const app = await buildApp()

        const res = await session(app, { lang: 'am' })

        expect(res.statusCode).toBe(503)
        expect(startSession).toHaveBeenCalledTimes(1)
    })
})
