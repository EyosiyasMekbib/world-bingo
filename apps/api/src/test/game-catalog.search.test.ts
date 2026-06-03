import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import gameProviderRoutes from '../routes/game-provider/index'
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

async function seedCatalog() {
  const alpha = await prisma.gameProvider.create({
    data: {
      code: 'alpha-search',
      name: 'Galaxy Play',
      apiBaseUrl: 'https://alpha.example.com',
      status: 'ACTIVE',
    },
  })

  const beta = await prisma.gameProvider.create({
    data: {
      code: 'beta-search',
      name: 'Orbit Games',
      apiBaseUrl: 'https://beta.example.com',
      status: 'ACTIVE',
    },
  })

  const alphaVendor = await prisma.gameVendor.create({
    data: {
      providerId: alpha.id,
      code: 'SPRIBE',
      name: 'Spribe',
      categoryCode: 'CRASH',
      isActive: true,
    },
  })

  const betaVendor = await prisma.gameVendor.create({
    data: {
      providerId: beta.id,
      code: 'NOVA',
      name: 'Nova Studio',
      categoryCode: 'SLOTS',
      isActive: true,
    },
  })

  await prisma.providerGame.createMany({
    data: [
      {
        providerId: alpha.id,
        vendorId: alphaVendor.id,
        gameCode: 'aviator-deluxe',
        gameName: 'Aviator Deluxe',
        categoryCode: 'CRASH',
        imageSquare: null,
        imageLandscape: null,
        languageCodes: ['en'],
        platformCodes: ['WEB'],
        currencyCodes: ['ETB'],
        isActive: true,
        sortOrder: 0,
      },
      {
        providerId: beta.id,
        vendorId: betaVendor.id,
        gameCode: 'book-of-galaxy',
        gameName: 'Book of Galaxy',
        categoryCode: 'SLOTS',
        imageSquare: null,
        imageLandscape: null,
        languageCodes: ['en'],
        platformCodes: ['WEB'],
        currencyCodes: ['ETB'],
        isActive: true,
        sortOrder: 0,
      },
    ],
  })

  await prisma.game.create({
    data: {
      title: 'Weekend Bingo',
      ticketPrice: 20,
      maxPlayers: 20,
      minPlayers: 2,
      houseEdgePct: 10,
      pattern: 'ANY_LINE',
      status: 'WAITING',
      calledBalls: [],
    },
  })
}

describe('GET /providers/search', () => {
  beforeEach(async () => {
    await prisma.providerGame.deleteMany()
    await prisma.gameVendor.deleteMany()
    await prisma.gameProvider.deleteMany()
    await prisma.game.deleteMany()
  })

  it('searches across every active provider instead of one catalog', async () => {
    await seedCatalog()
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: '/providers/search?q=galaxy',
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    expect(body.results).toHaveLength(2)
    expect(body.results.map((item: any) => item.providerCode)).toEqual(['alpha-search', 'beta-search'])
    expect(body.results.map((item: any) => item.gameName)).toEqual(['Aviator Deluxe', 'Book of Galaxy'])
  })

  it('returns Bingo as a single result when the query matches bingo lobby games', async () => {
    await seedCatalog()
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: '/providers/search?q=weekend',
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    expect(body.results).toEqual([
      expect.objectContaining({
        kind: 'bingo',
        gameName: 'Bingo',
        providerCode: 'world-bingo',
      }),
    ])
  })
})
