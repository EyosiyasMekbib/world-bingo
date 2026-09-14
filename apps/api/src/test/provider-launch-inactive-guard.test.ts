import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { prisma } from './setup'

vi.mock('../lib/redis', () => ({
    default: {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        keys: vi.fn().mockResolvedValue([]),
    },
}))
const { getGameUrl, emitProviderLaunch } = vi.hoisted(() => ({ getGameUrl: vi.fn(), emitProviderLaunch: vi.fn() }))
vi.mock('../gateways/game-provider/index.js', () => ({
    getGameProviderGateway: vi.fn(() => ({ getGameUrl, terminateSession: vi.fn() })),
}))
vi.mock('../lib/posthog-events.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/posthog-events.js')>()
    return { ...actual, emitProviderLaunch }
})
vi.mock('../services/event.service.js', () => ({ EventService: { record: vi.fn().mockResolvedValue(undefined) } }))

import gameProviderRoutes from '../routes/game-provider/index'

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

async function buildApp() {
    const app = Fastify({ logger: false })
    app.decorate('authenticate', async (req: any) => {
        req.user = { id: USER_ID, username: 'guard-player' }
    })
    await app.register(gameProviderRoutes, { prefix: '/providers' })
    await app.ready()
    return app
}

async function seed(code: string, status: 'ACTIVE' | 'INACTIVE', gameActive: boolean) {
    const provider = await prisma.gameProvider.create({ data: { code, name: code, apiBaseUrl: 'https://provider.test', status } })
    const vendor = await prisma.gameVendor.create({ data: { providerId: provider.id, code: `${code}-vendor`, name: 'Vendor', isActive: true } })
    await prisma.providerGame.create({
        data: {
            providerId: provider.id,
            vendorId: vendor.id,
            gameCode: 'g1',
            gameName: 'Game One',
            categoryCode: 'MINI',
            languageCodes: ['en'],
            platformCodes: ['WEB'],
            currencyCodes: ['ETB'],
            isActive: gameActive,
        },
    })
}

const launch = (app: Awaited<ReturnType<typeof buildApp>>, url: string) => app.inject({ method: 'POST', url, payload: {} })

describe('POST /providers/:providerCode/games/:gameCode/launch — switched-off catalog', () => {
    beforeEach(async () => {
        vi.clearAllMocks()
        await prisma.gameProvider.deleteMany({ where: { code: { startsWith: 'guard-' } } })
        getGameUrl.mockResolvedValue({ gameUrl: 'https://play.provider.test/session', token: '' })
    })

    it('refuses an INACTIVE provider without calling it', async () => {
        await seed('guard-off', 'INACTIVE', true)
        const res = await launch(await buildApp(), '/providers/guard-off/games/g1/launch')
        expect(res.statusCode).toBe(409)
        expect(res.json()).toMatchObject({ error: 'GameUnavailable' })
        expect(getGameUrl).not.toHaveBeenCalled()
        expect(emitProviderLaunch).toHaveBeenCalledWith(USER_ID, { providerCode: 'guard-off', gameCode: 'g1', launchOk: false, reason: 'provider_inactive' })
    })

    it('refuses an inactive game on an ACTIVE provider without calling it', async () => {
        await seed('guard-hidden', 'ACTIVE', false)
        const res = await launch(await buildApp(), '/providers/guard-hidden/games/g1/launch')
        expect(res.statusCode).toBe(409)
        expect(getGameUrl).not.toHaveBeenCalled()
        expect(emitProviderLaunch).toHaveBeenCalledWith(USER_ID, { providerCode: 'guard-hidden', gameCode: 'g1', launchOk: false, reason: 'game_inactive' })
    })

    it('launches an active game on an ACTIVE provider', async () => {
        await seed('guard-on', 'ACTIVE', true)
        const res = await launch(await buildApp(), '/providers/guard-on/games/g1/launch')
        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ gameUrl: 'https://play.provider.test/session', token: '' })
        expect(getGameUrl).toHaveBeenCalledTimes(1)
    })

    it('still launches a game with no catalog row on an ACTIVE provider', async () => {
        await seed('guard-on', 'ACTIVE', true)
        const res = await launch(await buildApp(), '/providers/guard-on/games/unsynced/launch')
        expect(res.statusCode).toBe(200)
        expect(getGameUrl).toHaveBeenCalledWith(expect.objectContaining({ gameCode: 'unsynced' }))
    })
})
