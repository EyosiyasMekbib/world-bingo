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

import redis from '../lib/redis'
import { GameCatalogService } from '../services/game-catalog.service'
import gameProviderRoutes from '../routes/game-provider/index'
import adminRoutes from '../routes/admin/index'

type Seeded = { id: string; code: string; vendorId: string }

async function provider(
    code: string,
    opts: {
        priority?: number
        isPrimary?: boolean
        createdAt?: string
        vendorName?: string
        name?: string
        studio?: boolean
    } = {},
): Promise<Seeded> {
    const p = await prisma.gameProvider.create({
        data: {
            code,
            name: opts.name ?? code,
            ...(opts.studio ? { config: { catalogSync: false } } : {}),
            apiBaseUrl: 'https://p.test',
            status: 'ACTIVE',
            isPrimary: opts.isPrimary ?? false,
            priority: opts.priority ?? 100,
            createdAt: new Date(opts.createdAt ?? '2026-01-01T00:00:00Z'),
        },
    })
    const v = await prisma.gameVendor.create({
        data: { providerId: p.id, code: 'SPRIBE', name: opts.vendorName ?? 'Spribe', isActive: true },
    })
    return { id: p.id, code, vendorId: v.id }
}

async function game(p: Seeded, gameCode: string, gameName: string, categoryCode = 'CRASH') {
    return prisma.providerGame.create({
        data: {
            providerId: p.id,
            vendorId: p.vendorId,
            gameCode,
            gameName,
            categoryCode,
            languageCodes: ['en'],
            platformCodes: ['WEB'],
            currencyCodes: ['ETB'],
            isActive: true,
        },
    })
}

async function lobbyProviders(): Promise<string[]> {
    const page = await GameCatalogService.getGames({ page: 1, pageSize: 50 })
    return page.games.map((g: any) => `${g.providerCode}:${g.gameName}`).sort()
}

async function buildAdminApp() {
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
    await prisma.providerGame.deleteMany()
    await prisma.gameVendor.deleteMany()
    await prisma.gameProvider.deleteMany()
}

describe('cross-provider lobby de-duplication', () => {
    beforeEach(clearCatalog)
    // The shared cleanDb() leaves the provider catalog alone, and the featured
    // games suite counts every catalog row matching a title — don't leak ours.
    afterAll(clearCatalog)

    it('shows one copy of a title carried by two providers, from the higher-priority one', async () => {
        const gasea = await provider('shadow-gasea', { priority: 10 })
        const palace = await provider('shadow-palace', { priority: 20 })
        await game(gasea, 'SPB_AVIATOR', 'Aviator')
        await game(palace, 'spribe-aviator', 'Aviator')
        await game(palace, 'spribe-mines', 'Mines')

        await GameCatalogService.applyShadowing()

        expect(await lobbyProviders()).toEqual(['shadow-gasea:Aviator', 'shadow-palace:Mines'])
        const page = await GameCatalogService.getGames({ page: 1, pageSize: 50 })
        expect(page.totalItems).toBe(2)
    })

    it('matches titles on normalized vendor + name, so punctuation and case do not split them', async () => {
        const a = await provider('shadow-a', { priority: 1, vendorName: 'Pragmatic Play' })
        const b = await provider('shadow-b', { priority: 2, vendorName: 'PRAGMATIC-PLAY' })
        await game(a, 'PP_1', "Sweet Bonanza")
        await game(b, 'pp-one', "SWEET  BONANZA!")

        await GameCatalogService.applyShadowing()

        expect(await lobbyProviders()).toEqual(['shadow-a:Sweet Bonanza'])
    })

    it('keeps same-named games from different vendors apart', async () => {
        const a = await provider('shadow-a', { priority: 1, vendorName: 'Studio One' })
        const b = await provider('shadow-b', { priority: 2, vendorName: 'Studio Two' })
        await game(a, 'keno-1', 'Keno')
        await game(b, 'keno-2', 'Keno')

        await GameCatalogService.applyShadowing()

        expect(await lobbyProviders()).toEqual(['shadow-a:Keno', 'shadow-b:Keno'])
    })

    it('breaks a priority tie on the primary flag, then on the oldest provider', async () => {
        const older = await provider('shadow-older', { createdAt: '2026-01-01T00:00:00Z' })
        const primary = await provider('shadow-primary', { createdAt: '2026-02-01T00:00:00Z', isPrimary: true })
        const newer = await provider('shadow-newer', { createdAt: '2026-03-01T00:00:00Z' })
        for (const p of [older, primary, newer]) await game(p, 'aviator', 'Aviator')

        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual(['shadow-primary:Aviator'])

        await prisma.gameProvider.update({ where: { id: primary.id }, data: { isPrimary: false } })
        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual(['shadow-older:Aviator'])
    })

    it('surfaces the other copy again when the winning provider or game is turned off', async () => {
        const gasea = await provider('shadow-gasea', { priority: 10 })
        const palace = await provider('shadow-palace', { priority: 20 })
        await game(gasea, 'SPB_AVIATOR', 'Aviator')
        const palaceAviator = await game(palace, 'spribe-aviator', 'Aviator')

        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual(['shadow-gasea:Aviator'])

        await prisma.gameProvider.update({ where: { id: gasea.id }, data: { status: 'MAINTENANCE' } })
        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual(['shadow-palace:Aviator'])

        // Back on, and the losing copy is hidden again — including when it is
        // itself disabled, so a disabled game never stays marked shadowed.
        await prisma.gameProvider.update({ where: { id: gasea.id }, data: { status: 'ACTIVE' } })
        await prisma.providerGame.update({ where: { id: palaceAviator.id }, data: { isActive: false } })
        await GameCatalogService.applyShadowing()
        const row = await prisma.providerGame.findUniqueOrThrow({ where: { id: palaceAviator.id } })
        expect(row.shadowed).toBe(false)
        expect(await lobbyProviders()).toEqual(['shadow-gasea:Aviator'])
    })

    it('leaves provider-scoped browsing untouched: a shadowed copy still lists under its own provider', async () => {
        const gasea = await provider('shadow-gasea', { priority: 10 })
        const palace = await provider('shadow-palace', { priority: 20 })
        await game(gasea, 'SPB_AVIATOR', 'Aviator')
        await game(palace, 'spribe-aviator', 'Aviator')
        await GameCatalogService.applyShadowing()

        const scoped = await GameCatalogService.getGames({ providerCode: 'shadow-palace', page: 1, pageSize: 50 })
        expect(scoped.games.map((g: any) => g.gameName)).toEqual(['Aviator'])
    })

    it('hides shadowed copies from the merged categories and from search', async () => {
        const gasea = await provider('shadow-gasea', { priority: 10 })
        const palace = await provider('shadow-palace', { priority: 20 })
        await game(gasea, 'SPB_AVIATOR', 'Aviator', 'CRASH')
        await game(palace, 'spribe-aviator', 'Aviator', 'INSTANT')
        await GameCatalogService.applyShadowing()

        expect(await GameCatalogService.getCategories()).toEqual(['CRASH'])

        const app = Fastify({ logger: false })
        app.decorate('authenticate', async () => {})
        await app.register(gameProviderRoutes, { prefix: '/providers' })
        const res = await app.inject({ method: 'GET', url: '/providers/search?q=aviator' })
        expect(res.json().results.map((r: any) => r.providerCode)).toEqual(['shadow-gasea'])
    })

    it('sync re-projects shadowing so a newly listed duplicate is hidden without an admin touching anything', async () => {
        const gasea = await provider('shadow-gasea', { priority: 10 })
        const palace = await provider('shadow-palace', { priority: 20 })
        await game(gasea, 'SPB_AVIATOR', 'Aviator')
        await GameCatalogService.applyShadowing()

        // A later Palace sync creates its own Aviator row.
        await game(palace, 'spribe-aviator', 'Aviator')
        expect(await lobbyProviders()).toEqual(['shadow-gasea:Aviator', 'shadow-palace:Aviator'])

        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual(['shadow-gasea:Aviator'])
    })

    it('admin priority endpoint validates and re-projects', async () => {
        const gasea = await provider('shadow-gasea', { priority: 10 })
        const palace = await provider('shadow-palace', { priority: 20 })
        await game(gasea, 'SPB_AVIATOR', 'Aviator')
        await game(palace, 'spribe-aviator', 'Aviator')
        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual(['shadow-gasea:Aviator'])

        const app = await buildAdminApp()

        const bad = await app.inject({ method: 'PATCH', url: `/admin/providers/${palace.id}/priority`, payload: { priority: 1.5 } })
        expect(bad.statusCode).toBe(400)

        const ok = await app.inject({ method: 'PATCH', url: `/admin/providers/${palace.id}/priority`, payload: { priority: 5 } })
        expect(ok.statusCode).toBe(200)
        expect(ok.json().priority).toBe(5)
        expect(await lobbyProviders()).toEqual(['shadow-palace:Aviator'])

        // Provider list comes back in priority order for the dashboard.
        const list = await app.inject({ method: 'GET', url: '/admin/providers' })
        expect(list.json().map((p: any) => p.code)).toEqual(['shadow-palace', 'shadow-gasea'])
    })

    it('admin status changes re-project so a disabled winner hands the title over', async () => {
        const gasea = await provider('shadow-gasea', { priority: 10 })
        const palace = await provider('shadow-palace', { priority: 20 })
        await game(gasea, 'SPB_AVIATOR', 'Aviator')
        await game(palace, 'spribe-aviator', 'Aviator')
        await GameCatalogService.applyShadowing()

        const app = await buildAdminApp()
        const res = await app.inject({ method: 'PATCH', url: `/admin/providers/${gasea.id}/status`, payload: { status: 'INACTIVE' } })
        expect(res.statusCode).toBe(200)
        expect(await lobbyProviders()).toEqual(['shadow-palace:Aviator'])

        const game2 = await app.inject({
            method: 'PATCH',
            url: `/admin/providers/shadow-palace/games/spribe-aviator/status`,
            payload: { isActive: false },
        })
        expect(game2.statusCode).toBe(200)
        expect(await lobbyProviders()).toEqual([])
    })

    it('a vendor de-dup alias joins differently named vendors into one group', async () => {
        // Atlas-V seeds its catalog under a vendor named "Atlas-V"; Palace lists
        // the same studio as "ATLAS V2". Without an alias the names differ and
        // both copies show; with the same alias on both, priority decides.
        const atlasv = await provider('shadow-atlasv', { priority: 0, vendorName: 'Atlas-V' })
        const palace = await provider('shadow-palace', { priority: 100, vendorName: 'ATLAS V2' })
        await game(atlasv, 'wof', 'Wheel of Fortune')
        await game(palace, '1234', 'WheelOfFortune')
        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual(['shadow-atlasv:Wheel of Fortune', 'shadow-palace:WheelOfFortune'])

        await prisma.gameVendor.update({ where: { id: palace.vendorId }, data: { dedupAlias: 'Atlas V' } })
        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual(['shadow-atlasv:Wheel of Fortune'])

        // Clearing the alias splits the group again.
        await prisma.gameVendor.update({ where: { id: palace.vendorId }, data: { dedupAlias: null } })
        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual(['shadow-atlasv:Wheel of Fortune', 'shadow-palace:WheelOfFortune'])
    })

    it('admin vendor alias endpoint validates, saves and re-projects across providers', async () => {
        const atlasv = await provider('shadow-atlasv', { priority: 0, vendorName: 'Atlas-V' })
        const palace = await provider('shadow-palace', { priority: 100, vendorName: 'ATLAS V2' })
        await game(atlasv, 'horseracing', 'Horse Racing')
        await game(palace, '5678', 'HorseRacing')
        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual(['shadow-atlasv:Horse Racing', 'shadow-palace:HorseRacing'])

        const app = await buildAdminApp()
        const url = `/admin/providers/${palace.code}/vendors/SPRIBE/alias`

        const bad = await app.inject({ method: 'PATCH', url, payload: { alias: 42 } })
        expect(bad.statusCode).toBe(400)
        const blank = await app.inject({ method: 'PATCH', url, payload: { alias: '---' } })
        expect(blank.statusCode).toBe(400)
        const missing = await app.inject({ method: 'PATCH', url: `/admin/providers/${palace.code}/vendors/NOPE/alias`, payload: { alias: 'x' } })
        expect(missing.statusCode).toBe(404)

        const ok = await app.inject({ method: 'PATCH', url, payload: { alias: '  atlasv  ' } })
        expect(ok.statusCode).toBe(200)
        expect(ok.json().dedupAlias).toBe('atlasv')
        expect(await lobbyProviders()).toEqual(['shadow-atlasv:Horse Racing'])

        const cleared = await app.inject({ method: 'PATCH', url, payload: { alias: '' } })
        expect(cleared.statusCode).toBe(200)
        expect(cleared.json().dedupAlias).toBeNull()
        expect(await lobbyProviders()).toEqual(['shadow-atlasv:Horse Racing', 'shadow-palace:HorseRacing'])
    })

    it('lobby rows carry the vendor name so the filter chips can label vendors, not providers', async () => {
        const palace = await provider('shadow-palace', { priority: 100, vendorName: 'Pragmatic Play' })
        await game(palace, '9', 'Sweet Bonanza')
        const page = await GameCatalogService.getGames({ page: 1, pageSize: 10 })
        expect(page.games).toHaveLength(1)
        expect(page.games[0]).toMatchObject({ vendorCode: 'SPRIBE', vendorName: 'Pragmatic Play', providerName: 'shadow-palace' })
    })

    it('bustCatalogCache drops every cached catalog page and category list (runs at API boot)', async () => {
        vi.mocked(redis.keys)
            .mockResolvedValueOnce(['tp:games:__all__:ALL:1:60', 'tp:games:palace:ALL:1:50'])
            .mockResolvedValueOnce(['tp:categories:__all__'])
        await GameCatalogService.bustCatalogCache()
        expect(redis.keys).toHaveBeenCalledWith('tp:games:*')
        expect(redis.keys).toHaveBeenCalledWith('tp:categories:*')
        expect(redis.del).toHaveBeenCalledWith('tp:games:__all__:ALL:1:60', 'tp:games:palace:ALL:1:50', 'tp:categories:__all__')
    })

    it('recognises a studio provider\'s games on another provider by vendor name alone, no alias needed', async () => {
        // Atlas-V is a direct studio integration (config.catalogSync false,
        // seeded under one vendor named after it). Palace carries the same
        // studio under its own vendor name; whatever that name is, as long
        // as it contains "atlasv" (or is contained in it), it is Atlas-V.
        const atlasv = await provider('shadow-atlasv', { priority: 0, name: 'Atlas-V', studio: true, vendorName: 'Atlas-V' })
        await game(atlasv, 'wof', 'Wheel of Fortune')
        await game(atlasv, 'boombasket', 'Boom Basket')
        await game(atlasv, 'horseracing', 'Horse Racing')
        await game(atlasv, 'plinko', 'Plinko')

        const palace = await provider('shadow-palace', { priority: 100, name: 'Palace Casino' })
        const v2 = await prisma.gameVendor.create({ data: { providerId: palace.id, code: 'palace:1', name: 'ATLAS V2', isActive: true } })
        const games = await prisma.gameVendor.create({ data: { providerId: palace.id, code: 'palace:2', name: 'Atlas-V Games', isActive: true } })
        const short = await prisma.gameVendor.create({ data: { providerId: palace.id, code: 'palace:3', name: 'Atlas', isActive: true } })
        const spribe = await prisma.gameVendor.create({ data: { providerId: palace.id, code: 'palace:4', name: 'Spribe', isActive: true } })
        await game({ ...palace, vendorId: v2.id }, '101', 'WheelOfFortune')
        await game({ ...palace, vendorId: games.id }, '102', 'Boom Basket')
        await game({ ...palace, vendorId: short.id }, '103', 'HorseRacing')
        await game({ ...palace, vendorId: spribe.id }, '104', 'Plinko')

        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual([
            'shadow-atlasv:Boom Basket',
            'shadow-atlasv:Horse Racing',
            'shadow-atlasv:Plinko',
            'shadow-atlasv:Wheel of Fortune',
            // Spribe's Plinko is a different game from Atlas-V's: different studio, both stay.
            'shadow-palace:Plinko',
        ])
    })

    it('does not treat a non-studio provider\'s name as a vendor match', async () => {
        // "Palace Casino" syncs many studios; a vendor that happens to contain
        // a provider name only merges when that provider is a studio provider.
        const palace = await provider('shadow-palace', { priority: 0, name: 'Palace Casino', vendorName: 'Palace Casino Originals' })
        const other = await provider('shadow-other', { priority: 100, name: 'Other', vendorName: 'Palace Casino Live' })
        await game(palace, '1', 'Roulette')
        await game(other, '2', 'Roulette')
        await GameCatalogService.applyShadowing()
        expect(await lobbyProviders()).toEqual(['shadow-other:Roulette', 'shadow-palace:Roulette'])
    })
})
