import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    siteSetting: {
      findMany: vi.fn(),
    },
  },
}))

import Fastify from 'fastify'
import prisma from '../lib/prisma'
import settingsRoutes from '../routes/settings/index'

describe('GET /settings/deposit-limits', () => {
  beforeEach(() => vi.clearAllMocks())

  async function buildApp() {
    const app = Fastify({ logger: false })
    app.decorate('requireAdmin', async () => {})
    await app.register(settingsRoutes, { prefix: '/settings' })
    await app.ready()
    return app
  }

  it('returns the deployment’s configured floor and ceiling as numbers', async () => {
    ;(prisma.siteSetting.findMany as any).mockResolvedValue([
      { key: 'min_deposit_amount', value: '50' },
      { key: 'max_deposit_amount', value: '20000' },
    ])
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/settings/deposit-limits' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ min: 50, max: 20000 })
    expect(prisma.siteSetting.findMany).toHaveBeenCalledWith({
      where: { key: { in: ['min_deposit_amount', 'max_deposit_amount'] } },
    })
  })

  it('falls back to the same defaults WalletService enforces when no rows exist', async () => {
    ;(prisma.siteSetting.findMany as any).mockResolvedValue([])
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/settings/deposit-limits' })

    expect(res.json()).toEqual({ min: 10, max: 50000 })
  })
})
