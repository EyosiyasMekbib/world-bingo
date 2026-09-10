import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma.js', () => ({
    default: { gameProvider: { findUnique: vi.fn() }, gameVendor: { findMany: vi.fn() } },
}))
vi.mock('../lib/redis.js', () => ({ default: { keys: vi.fn().mockResolvedValue([]), del: vi.fn() } }))

import prisma from '../lib/prisma.js'
const p = prisma as any

describe('GameCatalogService.syncAll — static-catalog skip', () => {
    beforeEach(() => vi.clearAllMocks())

    it('skips providers with config.catalogSync === false without touching the gateway', async () => {
        p.gameProvider.findUnique.mockResolvedValue({ id: 'prov1', code: 'atlasv', config: { catalogSync: false } })
        const { GameCatalogService } = await import('../services/game-catalog.service.js')
        const result = await GameCatalogService.syncAll('atlasv')
        expect(result).toEqual({ total: 0, reenabled: 0, autoHidden: 0 })
        expect(p.gameVendor.findMany).not.toHaveBeenCalled()
    })
})
