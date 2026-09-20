import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import settingsRoutes from '../routes/settings'
import { prisma } from './setup'

// Only the public route is exercised here, so the auth hooks are stubbed the
// way the other route suites do it. Registering @fastify/jwt needs the RSA
// keys from the root .env, which CI (and a fresh checkout) does not have —
// the plugin then throws "missing public key" before any test runs.
async function buildApp() {
  const app = Fastify()
  app.decorate('authenticate', async () => {})
  app.decorate('requireAdmin', async () => {})
  await app.register(settingsRoutes, { prefix: '/settings' })
  return app
}

describe('GET /settings/featured-game (public)', () => {
  it('returns templateId null when setting is not configured', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/settings/featured-game' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toEqual({ templateId: null })
  })

  it('returns templateId null when setting is empty string', async () => {
    await prisma.siteSetting.create({ data: { key: 'featured_template_id', value: '' } })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/settings/featured-game' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toEqual({ templateId: null })
  })

  it('returns templateId when setting has a value', async () => {
    await prisma.siteSetting.create({ data: { key: 'featured_template_id', value: 'abc-123' } })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/settings/featured-game' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toEqual({ templateId: 'abc-123' })
  })
})
