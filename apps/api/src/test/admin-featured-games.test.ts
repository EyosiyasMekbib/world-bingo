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

import adminRoutes from '../routes/admin/index'

async function buildApp() {
  const app = Fastify({ logger: false })
  app.decorate('authenticate', async () => {})
  app.decorate('requireAdmin', async () => {})
  app.decorate('requireAdminOrClerk', async () => {})
  await app.register(adminRoutes, { prefix: '/admin' })
  await app.ready()
  return app
}

async function seedCatalog() {
  // The shared cleanDb() in setup.ts leaves the provider catalog alone, so clear
  // our own rows first — otherwise the second test trips the unique code.
  await prisma.providerGame.deleteMany({ where: { provider: { code: 'featured-test' } } })
  await prisma.gameVendor.deleteMany({ where: { provider: { code: 'featured-test' } } })
  await prisma.gameProvider.deleteMany({ where: { code: 'featured-test' } })

  const provider = await prisma.gameProvider.create({
    data: { code: 'featured-test', name: 'Featured Test', apiBaseUrl: 'https://example.invalid' },
  })
  const vendor = await prisma.gameVendor.create({
    data: { providerId: provider.id, code: 'FT', name: 'Featured Vendor' },
  })
  await prisma.providerGame.createMany({
    data: [
      { providerId: provider.id, vendorId: vendor.id, gameCode: 'F1', gameName: 'Aviator', categoryCode: 'CRASH' },
      { providerId: provider.id, vendorId: vendor.id, gameCode: 'F2', gameName: 'Plinko', categoryCode: 'CRASH' },
      { providerId: provider.id, vendorId: vendor.id, gameCode: 'F3', gameName: 'Aaa Slot', categoryCode: 'SLOTS' },
    ],
  })
}

describe('admin featured-games routes', () => {
  beforeEach(async () => {
    await prisma.featuredGame.deleteMany()
    await seedCatalog()
  })

  it('saves the order and reports it back with match counts', async () => {
    const app = await buildApp()

    const put = await app.inject({
      method: 'PUT',
      url: '/admin/featured-games',
      payload: {
        items: [
          { nameKey: 'plinko', label: 'Plinko' },
          { nameKey: 'aviator', label: 'Aviator' },
        ],
      },
    })

    expect(put.statusCode).toBe(200)
    expect(put.json().items).toEqual([
      { nameKey: 'plinko', label: 'Plinko', position: 0, matches: 1 },
      { nameKey: 'aviator', label: 'Aviator', position: 1, matches: 1 },
    ])

    const get = await app.inject({ method: 'GET', url: '/admin/featured-games' })
    expect(get.json().items.map((i: any) => i.nameKey)).toEqual(['plinko', 'aviator'])

    await app.close()
  })

  it('serves the catalog in the curated order, pinned first', async () => {
    const app = await buildApp()

    await app.inject({
      method: 'PUT',
      url: '/admin/featured-games',
      payload: { items: [{ nameKey: 'plinko', label: 'Plinko' }] },
    })

    const games = await app.inject({ method: 'GET', url: '/admin/providers/featured-test/games' })
    // Plinko is pinned, so it leads despite two alphabetically earlier games.
    expect(games.json().data.map((g: any) => g.gameName)).toEqual(['Plinko', 'Aaa Slot', 'Aviator'])

    await app.close()
  })

  it('filters the picker by search term', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/admin/providers/featured-test/games?search=avi' })
    expect(res.json().data.map((g: any) => g.gameName)).toEqual(['Aviator'])

    await app.close()
  })

  it('rejects a payload with a duplicate game', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/featured-games',
      payload: {
        items: [
          { nameKey: 'aviator', label: 'Aviator' },
          { nameKey: 'Aviator', label: 'Aviator' },
        ],
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Duplicate game/)

    await app.close()
  })
})
