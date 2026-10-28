import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, string>())
const redisMock = vi.hoisted(() => ({
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
        store.set(k, v)
        return 'OK'
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
}))
vi.mock('../lib/redis.js', () => ({ default: redisMock }))

import { IgcoreClient, IgcoreApiError } from '../gateways/igcore/igcore.client.js'

const mockFetch = vi.fn()

function reply(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }
}

/** Answer /auth and /start-session from queues, in order. */
function script(opts: { auth?: unknown[]; start?: unknown[] }) {
    const auth = [...(opts.auth ?? [])]
    const start = [...(opts.start ?? [])]
    mockFetch.mockImplementation(async (url: string) => {
        const queue = String(url).endsWith('/auth') ? auth : start
        if (!queue.length) throw new Error(`unscripted call to ${url}`)
        return queue.shift()
    })
}

function callsTo(suffix: string) {
    return mockFetch.mock.calls.filter(([url]) => String(url).endsWith(suffix))
}

const TOK1 = reply({ token: 'tok1', expires_in: 21600 })
const OK_URL = reply({ url: 'https://sb/x' })
const PARAMS = { userId: 'a'.repeat(32), currency: 'ETB', lang: 'en' }

describe('IgcoreClient', () => {
    beforeEach(() => {
        store.clear()
        redisMock.get.mockClear()
        redisMock.setex.mockClear()
        redisMock.del.mockClear()
        mockFetch.mockReset()
        vi.stubGlobal('fetch', mockFetch)
        vi.stubEnv('IGCORE_API_URL', 'https://igcore.test')
        vi.stubEnv('IGCORE_API_VERSION', '')
        vi.stubEnv('IGCORE_USERNAME', 'wb-user')
        vi.stubEnv('IGCORE_PASSWORD', 'wb-pass')
        vi.stubEnv('IGCORE_SECURITY_HASH', 'secret')
    })

    afterEach(() => {
        vi.unstubAllEnvs()
        vi.unstubAllGlobals()
    })

    it('caches the token', async () => {
        script({ auth: [TOK1], start: [OK_URL, OK_URL] })
        const client = new IgcoreClient()
        await client.startSession(PARAMS)
        await client.startSession(PARAMS)
        expect(callsTo('/1.0.0/auth')).toHaveLength(1)
        expect(redisMock.setex).toHaveBeenCalledWith('igcore:token', 21300, 'tok1')
    })

    it('re-auths once on Unauthorized', async () => {
        script({
            auth: [TOK1, reply({ token: 'tok2', expires_in: 21600 })],
            start: [reply({ error: 'Unauthorized' }), OK_URL],
        })
        const res = await new IgcoreClient().startSession(PARAMS)
        expect(res).toEqual({ url: 'https://sb/x' })
        expect(callsTo('/1.0.0/auth')).toHaveLength(2)
        expect(redisMock.del).toHaveBeenCalledWith('igcore:token')
        const retry = callsTo('/1.0.0/start-session')[1][1]
        expect(retry.headers.Authorization).toBe('Bearer tok2')
    })

    it('gives up after a second Unauthorized', async () => {
        script({
            auth: [TOK1, reply({ token: 'tok2', expires_in: 21600 })],
            start: [reply({ error: 'Unauthorized' }), reply({ error: 'Unauthorized' })],
        })
        await expect(new IgcoreClient().startSession(PARAMS)).rejects.toMatchObject({
            constructor: IgcoreApiError,
            code: 'Unauthorized',
        })
        expect(callsTo('/1.0.0/auth')).toHaveLength(2)
        expect(callsTo('/1.0.0/start-session')).toHaveLength(2)
    })

    it('surfaces operator errors', async () => {
        script({ auth: [TOK1], start: [reply({ error: 'currency is not allowed' })] })
        await expect(new IgcoreClient().startSession(PARAMS)).rejects.toMatchObject({
            constructor: IgcoreApiError,
            code: 'currency is not allowed',
        })
        expect(callsTo('/1.0.0/auth')).toHaveLength(1)
    })

    it('sends the documented body', async () => {
        script({ auth: [TOK1], start: [OK_URL] })
        await new IgcoreClient().startSession(PARAMS)

        const [authUrl, authInit] = callsTo('/1.0.0/auth')[0]
        expect(authUrl).toBe('https://igcore.test/1.0.0/auth')
        expect(authInit.method).toBe('POST')
        expect(authInit.headers['Content-Type']).toBe('application/json')
        expect(authInit.headers.Authorization).toBeUndefined()
        expect(JSON.parse(authInit.body)).toEqual({ username: 'wb-user', password: 'wb-pass' })

        const [url, init] = callsTo('/1.0.0/start-session')[0]
        expect(url).toBe('https://igcore.test/1.0.0/start-session')
        expect(init.method).toBe('POST')
        expect(init.headers['Content-Type']).toBe('application/json')
        expect(init.headers.Authorization).toBe('Bearer tok1')
        expect(JSON.parse(init.body)).toEqual({ user_id: 'a'.repeat(32), currency: 'ETB', lang: 'en' })
        expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('refuses when unconfigured', async () => {
        vi.stubEnv('IGCORE_API_URL', '')
        vi.stubEnv('IGCORE_USERNAME', '')
        vi.stubEnv('IGCORE_PASSWORD', '')
        vi.stubEnv('IGCORE_SECURITY_HASH', '')
        const client = new IgcoreClient()
        await expect(client.startSession(PARAMS)).rejects.toMatchObject({
            constructor: IgcoreApiError,
            code: 'NOT_CONFIGURED',
        })
        await expect(client.getToken()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
        expect(mockFetch).not.toHaveBeenCalled()
    })

    it('falls back to the configured language and tolerates a trailing slash and custom version', async () => {
        vi.stubEnv('IGCORE_API_URL', 'https://igcore.test/')
        vi.stubEnv('IGCORE_API_VERSION', '2.1.0')
        vi.stubEnv('IGCORE_DEFAULT_LANG', 'am')
        script({ auth: [TOK1], start: [OK_URL] })
        await new IgcoreClient().startSession({ userId: 'u1', currency: 'ETB' })
        const [url, init] = callsTo('/2.1.0/start-session')[0]
        expect(url).toBe('https://igcore.test/2.1.0/start-session')
        expect(JSON.parse(init.body).lang).toBe('am')
    })

    it('getToken(true) bypasses and replaces the cached token', async () => {
        store.set('igcore:token', 'stale')
        script({ auth: [reply({ token: 'fresh', expires_in: 21600 })] })
        const client = new IgcoreClient()
        expect(await client.getToken()).toBe('stale')
        expect(mockFetch).not.toHaveBeenCalled()
        expect(await client.getToken(true)).toBe('fresh')
        expect(store.get('igcore:token')).toBe('fresh')
    })

    it('never caches a token for less than 60 seconds', async () => {
        script({ auth: [reply({ token: 'short', expires_in: 120 })] })
        await new IgcoreClient().getToken()
        expect(redisMock.setex).toHaveBeenCalledWith('igcore:token', 60, 'short')
    })

    it('surfaces invalid credentials from /auth without caching', async () => {
        script({ auth: [reply({ error: 'invalid credentials' })] })
        await expect(new IgcoreClient().getToken()).rejects.toMatchObject({
            constructor: IgcoreApiError,
            code: 'invalid credentials',
        })
        expect(redisMock.setex).not.toHaveBeenCalled()
    })

    it('rejects an /auth answer without a token as BAD_RESPONSE', async () => {
        script({ auth: [reply({ expires_in: 21600 })] })
        await expect(new IgcoreClient().getToken()).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
        expect(redisMock.setex).not.toHaveBeenCalled()
    })

    it('rejects a success without a string url as BAD_RESPONSE', async () => {
        script({ auth: [TOK1], start: [reply({}), reply({ url: 42 })] })
        const client = new IgcoreClient()
        await expect(client.startSession(PARAMS)).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
        await expect(client.startSession(PARAMS)).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
    })

    it('maps an HTTP failure to HTTP_<status>', async () => {
        script({ auth: [TOK1], start: [reply('', 500)] })
        await expect(new IgcoreClient().startSession(PARAMS)).rejects.toMatchObject({
            constructor: IgcoreApiError,
            code: 'HTTP_500',
        })
    })

    it('maps a network failure to NETWORK', async () => {
        mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED'))
        await expect(new IgcoreClient().startSession(PARAMS)).rejects.toMatchObject({
            constructor: IgcoreApiError,
            code: 'NETWORK',
        })
    })

    it('maps a non-JSON 200 to BAD_RESPONSE', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError('Unexpected token <')
            },
            text: async () => '<html>',
        })
        await expect(new IgcoreClient().getToken()).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
    })

    it('does not put the token, password or session url in an error message', async () => {
        script({ auth: [TOK1], start: [reply({ url: 42, extra: 'https://sb/secret' })] })
        const err = await new IgcoreClient().startSession(PARAMS).catch((e) => e)
        expect(err).toBeInstanceOf(IgcoreApiError)
        for (const secret of ['tok1', 'wb-pass', 'https://sb/secret']) {
            expect(err.message).not.toContain(secret)
        }
    })
})
