import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import settingsRoutes from '../routes/settings'
import { prisma } from './setup'
import { jwtPrivateKey, jwtPublicKey } from '../lib/jwt-keys'

async function buildApp() {
  const app = Fastify()
  await app.register(jwt, {
    secret: {
      private: jwtPrivateKey,
      public: jwtPublicKey,
    },
    sign: { algorithm: 'RS256', expiresIn: '15m' },
  })
  app.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify()
    } catch (err) {
      reply.send(err)
    }
  })
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
