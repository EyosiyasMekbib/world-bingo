/**
 * GET /settings/support tells the web whether the support bot is there to
 * link to. The web used NUXT_PUBLIC_TELEGRAM_BOT_NAME for that, which the
 * login widget sets on every brand whether or not the bot is armed, so a
 * deploy before arming sent the forgot-password flow to a bot that never
 * answers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    siteSetting: {
      findMany: vi.fn(() => Promise.resolve([])),
      upsert: vi.fn(() => Promise.resolve({})),
    },
  },
}))

const configMock = vi.hoisted(() => ({
  isEnabled: vi.fn(() => true),
  botUsername: vi.fn<() => string | null>(() => 'arada_support_bot'),
}))
vi.mock('../gateways/telegram/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gateways/telegram/config')>()),
  ...configMock,
}))

import Fastify from 'fastify'
import settingsRoutes from '../routes/settings/index'

async function getSupport() {
  const app = Fastify({ logger: false })
  app.decorate('requireAdmin', async () => {})
  await app.register(settingsRoutes, { prefix: '/settings' })
  const res = await app.inject({ method: 'GET', url: '/settings/support' })
  return res.json()
}

describe('GET /settings/support — bot', () => {
  beforeEach(() => {
    configMock.isEnabled.mockReturnValue(true)
    configMock.botUsername.mockReturnValue('arada_support_bot')
  })

  it("names the bot once it is armed and getMe has answered", async () => {
    expect(await getSupport()).toMatchObject({ bot: 'arada_support_bot' })
  })

  it("is '' while the bot is disabled, even with a username cached", async () => {
    configMock.isEnabled.mockReturnValue(false)
    expect(await getSupport()).toMatchObject({ bot: '' })
  })

  it("is '' while boot has not learned the username yet", async () => {
    configMock.botUsername.mockReturnValue(null)
    expect(await getSupport()).toMatchObject({ bot: '' })
  })
})
