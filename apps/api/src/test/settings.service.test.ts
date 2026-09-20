import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import settingsRoutes from '../routes/settings'
import { prisma } from './setup'

/**
 * The route under test is a public GET. `routes/settings` also carries admin
 * routes whose `preValidation` reads `fastify.requireAdmin`, and a decorator
 * referenced at registration has to exist even for a route no test calls — so
 * it is stubbed, the convention the admin suites already follow.
 *
 * No JWT plugin. This suite used to register @fastify/jwt with the real RS256
 * keypair from the environment; `lib/jwt-keys` returns an empty string for an
 * unset var and @fastify/jwt rejects that at registration, so all three tests
 * died on "missing public key" on any machine without JWT keys exported. It
 * also decorated `authenticate`, which nothing in these routes reads — so even
 * with keys present it would have failed on the missing `requireAdmin`. Both
 * were dropped rather than propped up with a throwaway keypair: a public
 * endpoint's test should not need one, and needing one was the bug.
 */
async function buildApp() {
  const app = Fastify()
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
