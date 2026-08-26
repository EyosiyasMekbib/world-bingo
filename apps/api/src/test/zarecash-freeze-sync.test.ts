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
    await ZareCashService.syncPlayerFreeze('u1', true, 'fraud review')
    expect(freezePlayer).toHaveBeenCalledWith('u1', 'fraud review')
    expect(unfreezePlayer).not.toHaveBeenCalled()
  })

  it('unfreezes the player upstream', async () => {
    await ZareCashService.syncPlayerFreeze('u1', false, 'reinstated')
    expect(unfreezePlayer).toHaveBeenCalledWith('u1', 'reinstated')
  })

  it('never throws — a failed sync must not block the local freeze', async () => {
    freezePlayer.mockRejectedValue(new Error('upstream down'))
    await expect(ZareCashService.syncPlayerFreeze('u1', true, 'fraud')).resolves.toBeUndefined()
  })

  it('does nothing when ZareCash is disabled', async () => {
    process.env.ZARECASH_ENABLED = 'false'
    await ZareCashService.syncPlayerFreeze('u1', true, 'fraud')
    expect(freezePlayer).not.toHaveBeenCalled()
    process.env = { ...ORIGINAL }
  })
})
