import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import gameProviderRoutes from '../routes/game-provider/index'
import { GameCatalogService } from '../services/game-catalog.service'
import { prisma } from './setup'

vi.mock('../lib/redis', () => ({
  default: {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
  },
}))

async function buildApp() {
  const app = Fastify({ logger: false })
  app.decorate('authenticate', async () => {})
  await app.register(gameProviderRoutes, { prefix: '/providers' })
  await app.ready()
  return app
}

const GAME_DEFAULTS = {
  imageSquare: null,
  imageLandscape: null,
  languageCodes: ['en'],
  platformCodes: ['WEB'],
  currencyCodes: ['ETB'],
  isActive: true,
  sortOrder: 0,
}

async function seedProvider(
  code: string,
  priority: number,
  status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
) {
  const provider = await prisma.gameProvider.create({
    data: { code, name: code, apiBaseUrl: `https://${code}.example.com`, status, priority },
  })
  const vendor = await prisma.gameVendor.create({
    data: {
      providerId: provider.id,
      code: 'SPRIBE',
      name: 'Spribe',
      categoryCode: 'CRASH',
      isActive: true,
    },
  })
  return { provider, vendor }
}

describe('GET /providers/games/by-name/:nameKey', () => {
  beforeEach(async () => {
    await prisma.providerGame.deleteMany()
    await prisma.gameVendor.deleteMany()
    await prisma.gameProvider.deleteMany()
  })

  it('returns the highest-priority provider’s copy, matched on the normalized name', async () => {
    const palace = await seedProvider('palace-byname', 100)
    const atlas = await seedProvider('atlasv-byname', 0)
    await prisma.providerGame.createMany({
      data: [
        {
          ...GAME_DEFAULTS,
          providerId: palace.provider.id,
          vendorId: palace.vendor.id,
          gameCode: '533',
          gameName: 'AVIATOR',
          categoryCode: 'MINI',
        },
        {
          ...GAME_DEFAULTS,
          providerId: palace.provider.id,
          vendorId: palace.vendor.id,
          gameCode: '534',
          gameName: 'Aviator Deluxe',
          categoryCode: 'MINI',
        },
        {
          ...GAME_DEFAULTS,
          providerId: atlas.provider.id,
          vendorId: atlas.vendor.id,
          gameCode: 'spribe_aviator',
          gameName: 'Aviator',
          categoryCode: 'CRASH',
        },
      ],
    })
    await GameCatalogService.applyShadowing()
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/providers/games/by-name/aviator' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      providerCode: 'atlasv-byname',
      gameCode: 'spribe_aviator',
      gameName: 'Aviator',
      vendorCode: 'SPRIBE',
    })
  })

  it('never launches a copy the lobby hides: shadowed rows, inactive games and inactive providers', async () => {
    const palace = await seedProvider('palace-byname', 100)
    const atlas = await seedProvider('atlasv-byname', 0)
    const gasea = await seedProvider('gasea-byname', 50, 'INACTIVE')
    await prisma.providerGame.createMany({
      data: [
        {
          ...GAME_DEFAULTS,
          providerId: palace.provider.id,
          vendorId: palace.vendor.id,
          gameCode: '533',
          gameName: 'Aviator',
          categoryCode: 'MINI',
        },
        {
          ...GAME_DEFAULTS,
          providerId: atlas.provider.id,
          vendorId: atlas.vendor.id,
          gameCode: 'spribe_aviator',
          gameName: 'Aviator',
          categoryCode: 'CRASH',
          isActive: false,
        },
        {
          ...GAME_DEFAULTS,
          providerId: gasea.provider.id,
          vendorId: gasea.vendor.id,
          gameCode: 'g-aviator',
          gameName: 'Aviator',
          categoryCode: 'CRASH',
        },
      ],
    })
    await GameCatalogService.applyShadowing()
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/providers/games/by-name/aviator' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ providerCode: 'palace-byname', gameCode: '533' })
  })

  it('is 404 when no active provider carries the title', async () => {
    const palace = await seedProvider('palace-byname', 100)
    await prisma.providerGame.create({
      data: {
        ...GAME_DEFAULTS,
        providerId: palace.provider.id,
        vendorId: palace.vendor.id,
        gameCode: '534',
        gameName: 'Aviator Deluxe',
        categoryCode: 'MINI',
      },
    })
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/providers/games/by-name/aviator' })

    expect(res.statusCode).toBe(404)
  })
})
