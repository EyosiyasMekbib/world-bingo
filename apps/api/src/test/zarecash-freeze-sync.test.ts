import { describe, it, expect, vi, beforeEach } from 'vitest'

const { freezePlayer, unfreezePlayer } = vi.hoisted(() => ({
  freezePlayer: vi.fn().mockResolvedValue({}),
  unfreezePlayer: vi.fn().mockResolvedValue({}),
}))
vi.mock('../gateways/payment/zarecash/client', () => ({
  zarecashClient: () => ({ freezePlayer, unfreezePlayer }),
}))
vi.mock('../lib/prisma', () => ({ default: {} }))

import { ZareCashService } from '../services/zarecash.service'

describe('ZareCashService.syncPlayerFreeze', () => {
  const ORIGINAL = { ...process.env }
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    process.env.ZARECASH_WEBHOOK_SECRET = 'whsec'
    process.env.ZARECASH_MODE = 'test'
  })

  it('freezes the player upstream', async () => {
    const result = await ZareCashService.syncPlayerFreeze('u1', true, 'fraud review')
    expect(freezePlayer).toHaveBeenCalledWith('u1', 'fraud review')
    expect(unfreezePlayer).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, skipped: false })
  })

  it('unfreezes the player upstream', async () => {
    const result = await ZareCashService.syncPlayerFreeze('u1', false, 'reinstated')
    expect(unfreezePlayer).toHaveBeenCalledWith('u1', 'reinstated')
    expect(result).toEqual({ ok: true, skipped: false })
  })

  it('never throws — a failed sync must not block the local freeze — and reports the failure', async () => {
    freezePlayer.mockRejectedValue(new Error('upstream down'))
    await expect(ZareCashService.syncPlayerFreeze('u1', true, 'fraud')).resolves.toEqual({
      ok: false,
      skipped: false,
      error: 'upstream down',
    })
  })

  it('does nothing when ZareCash is disabled', async () => {
    process.env.ZARECASH_ENABLED = 'false'
    const result = await ZareCashService.syncPlayerFreeze('u1', true, 'fraud')
    expect(freezePlayer).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, skipped: true })
    process.env = { ...ORIGINAL }
  })

  it('returns skipped: true without touching the client when disabled', async () => {
    process.env.ZARECASH_ENABLED = 'false'
    const frozenResult = await ZareCashService.syncPlayerFreeze('u1', true, 'fraud')
    const unfrozenResult = await ZareCashService.syncPlayerFreeze('u1', false, 'reinstated')
    expect(frozenResult).toEqual({ ok: true, skipped: true })
    expect(unfrozenResult).toEqual({ ok: true, skipped: true })
    expect(freezePlayer).not.toHaveBeenCalled()
    expect(unfreezePlayer).not.toHaveBeenCalled()
    process.env = { ...ORIGINAL }
  })
})
