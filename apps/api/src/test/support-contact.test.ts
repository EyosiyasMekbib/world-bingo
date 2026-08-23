import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    siteSetting: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}))

import Fastify from 'fastify'
import prisma from '../lib/prisma'
import { SupportContact, buildContactUpdates } from '../services/support/support-contact'
import settingsRoutes from '../routes/settings/index'

describe('SupportContact.get', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps all three configured rows to phone / telegram / hours', async () => {
    ;(prisma.siteSetting.findMany as any).mockResolvedValue([
      { key: 'support_phone', value: '+251911223344' },
      { key: 'support_telegram', value: '@world_bingo_support' },
      { key: 'support_hours', value: '9am-9pm EAT' },
    ])

    const result = await SupportContact.get()

    expect(result).toEqual({
      phone: '+251911223344',
      telegram: '@world_bingo_support',
      hours: '9am-9pm EAT',
    })
  })

  it('returns empty strings, not undefined, when no rows exist', async () => {
    ;(prisma.siteSetting.findMany as any).mockResolvedValue([])

    const result = await SupportContact.get()

    expect(result).toEqual({ phone: '', telegram: '', hours: '' })
    // Explicitly assert none of the fields is undefined — the widget hides a
    // channel that is an empty string, but undefined would render as the
    // literal text "undefined" to a player.
    expect(result.phone).not.toBeUndefined()
    expect(result.telegram).not.toBeUndefined()
    expect(result.hours).not.toBeUndefined()
  })

  it('fills in empty strings for the unconfigured keys of a partial row set', async () => {
    ;(prisma.siteSetting.findMany as any).mockResolvedValue([
      { key: 'support_phone', value: '+251911223344' },
    ])

    const result = await SupportContact.get()

    expect(result).toEqual({ phone: '+251911223344', telegram: '', hours: '' })
  })

  it('queries only the three support_* keys, not the whole settings table', async () => {
    ;(prisma.siteSetting.findMany as any).mockResolvedValue([])

    await SupportContact.get()

    expect(prisma.siteSetting.findMany).toHaveBeenCalledWith({
      where: { key: { in: ['support_phone', 'support_telegram', 'support_hours'] } },
    })
    expect(prisma.siteSetting.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('buildContactUpdates', () => {
  it('trims a normal string value and includes it', () => {
    const updates = buildContactUpdates({ support_phone: '  +251911223344  ' })

    expect(updates).toEqual({ support_phone: '+251911223344' })
  })

  it('ignores a JSON null value — does not write anything, and never the string "null"', () => {
    const updates = buildContactUpdates({ support_phone: null })

    expect(updates).not.toHaveProperty('support_phone')
    expect(updates).toEqual({})
    expect(JSON.stringify(updates)).not.toContain('null')
  })

  it('omits a key entirely when it is absent from the body, leaving other rows untouched', () => {
    const updates = buildContactUpdates({ support_phone: 'abc' })

    expect(updates).toEqual({ support_phone: 'abc' })
    expect(updates).not.toHaveProperty('support_telegram')
    expect(updates).not.toHaveProperty('support_hours')
  })

  it('ignores a number or boolean value rather than stringifying it', () => {
    const updates = buildContactUpdates({ support_telegram: 12345, support_hours: true })

    expect(updates).toEqual({})
    expect(updates).not.toHaveProperty('support_telegram')
    expect(updates).not.toHaveProperty('support_hours')
  })
})

describe('PUT /settings/support route', () => {
  beforeEach(() => vi.clearAllMocks())

  async function buildApp() {
    const app = Fastify({ logger: false })
    app.decorate('requireAdmin', async () => {})
    await app.register(settingsRoutes, { prefix: '/settings' })
    await app.ready()
    return app
  }

  it('writes only the string fields sent, trimmed, via upsert', async () => {
    ;(prisma.siteSetting.upsert as any).mockResolvedValue({})
    ;(prisma.siteSetting.findMany as any).mockResolvedValue([
      { key: 'support_phone', value: '+251911223344' },
    ])
    const app = await buildApp()

    const res = await app.inject({
      method: 'PUT',
      url: '/settings/support',
      payload: { support_phone: '  +251911223344  ' },
    })

    expect(res.statusCode).toBe(200)
    expect(prisma.siteSetting.upsert).toHaveBeenCalledTimes(1)
    expect(prisma.siteSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'support_phone' },
      update: { value: '+251911223344' },
      create: { key: 'support_phone', value: '+251911223344' },
    })
  })

  it('drops a null field and an omitted field without ever persisting the string "null"', async () => {
    ;(prisma.siteSetting.upsert as any).mockResolvedValue({})
    ;(prisma.siteSetting.findMany as any).mockResolvedValue([])
    const app = await buildApp()

    const res = await app.inject({
      method: 'PUT',
      url: '/settings/support',
      // support_phone: null ("clear this field" from a client's point of view),
      // support_telegram: omitted entirely, support_hours: a real string.
      payload: { support_phone: null, support_hours: '9am-9pm EAT' },
    })

    expect(res.statusCode).toBe(200)
    // Only the one real string field was written.
    expect(prisma.siteSetting.upsert).toHaveBeenCalledTimes(1)
    expect(prisma.siteSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'support_hours' },
      update: { value: '9am-9pm EAT' },
      create: { key: 'support_hours', value: '9am-9pm EAT' },
    })
    // Never called for the null/omitted keys, and never with the literal "null".
    expect(prisma.siteSetting.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'support_phone' } }),
    )
    expect(prisma.siteSetting.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'support_telegram' } }),
    )
    for (const call of (prisma.siteSetting.upsert as any).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('null')
    }
  })
})
