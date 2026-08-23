import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: { siteSetting: { findMany: vi.fn() } },
}))

import prisma from '../lib/prisma'
import { SupportContact } from '../services/support/support-contact'

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
