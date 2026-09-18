import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

import adminRoutes from '../routes/admin/index'

const PROVIDER = 'games-tab-test'

async function buildApp() {
    const app = Fastify({ logger: false })
    app.decorate('authenticate', async () => {})
    app.decorate('requireAdmin', async () => {})
    app.decorate('requireAdminOrClerk', async () => {})
    app.decorate('requireSuperAdmin', async () => {})
    await app.register(adminRoutes, { prefix: '/admin' })
    await app.ready()
    return app
}

async function clearCatalog() {
    // The shared cleanDb() in setup.ts leaves the provider catalog alone.
    await prisma.providerGame.deleteMany({ where: { provider: { code: PROVIDER } } })
    await prisma.gameVendor.deleteMany({ where: { provider: { code: PROVIDER } } })
    await prisma.gameProvider.deleteMany({ where: { code: PROVIDER } })
}

async function seedCatalog() {
    await clearCatalog()
    const provider = await prisma.gameProvider.create({
        data: { code: PROVIDER, name: 'Games Tab Test', apiBaseUrl: 'https://example.invalid', status: 'ACTIVE' },
    })
    const spribe = await prisma.gameVendor.create({
        data: { providerId: provider.id, code: 'SPRIBE', name: 'Spribe' },
    })
    const atlas = await prisma.gameVendor.create({
        data: { providerId: provider.id, code: 'ATLAS', name: 'ATLAS V2' },
    })
    await prisma.providerGame.createMany({
        data: [
            { providerId: provider.id, vendorId: spribe.id, gameCode: 'S1', gameName: 'Aviator', categoryCode: 'CRASH' },
            { providerId: provider.id, vendorId: spribe.id, gameCode: 'S2', gameName: 'Plinko', categoryCode: 'CRASH' },
            { providerId: provider.id, vendorId: atlas.id, gameCode: 'A1', gameName: 'Wheel of Fortune', categoryCode: 'SLOTS' },
            { providerId: provider.id, vendorId: atlas.id, gameCode: 'A2', gameName: 'Aviator', categoryCode: 'CRASH', shadowed: true },
        ],
    })
}

describe('admin provider games list', () => {
    beforeEach(seedCatalog)
    afterAll(clearCatalog)

    it('carries the studio name and the projected shadowed flag on every row', async () => {
        const app = await buildApp()
        const res = await app.inject({ method: 'GET', url: `/admin/providers/${PROVIDER}/games` })
        expect(res.statusCode).toBe(200)
        const rows = res.json().data.map((g: any) => [g.gameCode, g.vendorCode, g.vendorName, g.vendorActive, g.shadowed])
        expect(rows).toEqual(expect.arrayContaining([
            ['S1', 'SPRIBE', 'Spribe', true, false],
            ['A2', 'ATLAS', 'ATLAS V2', true, true],
        ]))
        expect(res.json().total).toBe(4)
        await app.close()
    })

    it('narrows to one studio by vendor code, combined with the name search', async () => {
        const app = await buildApp()

        const byVendor = await app.inject({ method: 'GET', url: `/admin/providers/${PROVIDER}/games?vendor=ATLAS` })
        expect(byVendor.json().total).toBe(2)
        expect(byVendor.json().data.map((g: any) => g.gameCode).sort()).toEqual(['A1', 'A2'])

        const both = await app.inject({ method: 'GET', url: `/admin/providers/${PROVIDER}/games?vendor=ATLAS&search=avi` })
        expect(both.json().data.map((g: any) => g.gameCode)).toEqual(['A2'])

        const unknown = await app.inject({ method: 'GET', url: `/admin/providers/${PROVIDER}/games?vendor=NOPE` })
        expect(unknown.json().total).toBe(0)

        await app.close()
    })

    it('disabling a game is a manual override that survives a re-projection', async () => {
        const app = await buildApp()

        const off = await app.inject({
            method: 'PATCH',
            url: `/admin/providers/${PROVIDER}/games/S1/status`,
            payload: { isActive: false },
        })
        expect(off.statusCode).toBe(200)
        expect(off.json()).toMatchObject({ gameCode: 'S1', isActive: false, autoHidden: false, shadowed: false })

        // The list reports the row as off, not hidden-as-duplicate.
        const list = await app.inject({ method: 'GET', url: `/admin/providers/${PROVIDER}/games?vendor=SPRIBE` })
        const s1 = list.json().data.find((g: any) => g.gameCode === 'S1')
        expect(s1).toMatchObject({ isActive: false, autoHidden: false, shadowed: false })

        const on = await app.inject({
            method: 'PATCH',
            url: `/admin/providers/${PROVIDER}/games/S1/status`,
            payload: { isActive: true },
        })
        expect(on.json()).toMatchObject({ gameCode: 'S1', isActive: true, autoHidden: false })

        await app.close()
    })
})
