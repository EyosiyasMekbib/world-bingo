import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { DEFAULT_BRAND } from '@world-bingo/shared-types'

vi.mock('../../services/brand.service', () => ({
  BrandService: { getBrand: vi.fn(), updateBrand: vi.fn() },
}))

import { BrandService } from '../../services/brand.service'
import brandRoutes from './index'

function build() {
  const app = Fastify()
  app.decorate('requireAdmin', async () => {})
  app.register(brandRoutes, { prefix: '/brand' })
  return app
}

describe('brand routes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET /brand returns the brand config (public)', async () => {
    ;(BrandService.getBrand as any).mockResolvedValue(DEFAULT_BRAND)
    const app = build()
    const res = await app.inject({ method: 'GET', url: '/brand' })
    expect(res.statusCode).toBe(200)
    expect(res.json().tokens.brandPrimary).toBe('#f59e0b')
    await app.close()
  })

  it('PUT /brand returns 400 on invalid body', async () => {
    ;(BrandService.updateBrand as any).mockRejectedValue(new Error('bad'))
    const app = build()
    const res = await app.inject({
      method: 'PUT',
      url: '/brand',
      payload: { tokens: { brandPrimary: 'nope' } },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('PUT /brand returns the updated brand on success', async () => {
    ;(BrandService.updateBrand as any).mockResolvedValue({ ...DEFAULT_BRAND, displayName: 'Arada Bingo' })
    const app = build()
    const res = await app.inject({ method: 'PUT', url: '/brand', payload: { displayName: 'Arada Bingo' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().displayName).toBe('Arada Bingo')
    await app.close()
  })
})
