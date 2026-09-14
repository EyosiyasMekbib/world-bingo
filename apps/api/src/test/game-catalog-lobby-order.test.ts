import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { prisma } from './setup'

vi.mock('../lib/redis', () => ({
    default: {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        keys: vi.fn().mockResolvedValue([]),
    },
}))

import { GameCatalogService } from '../services/game-catalog.service'
import gameProviderRoutes from '../routes/game-provider/index'

async function provider(code: string, createdAt: string, isPrimary = false) {
    await prisma.gameProvider.create({
        data: { code, name: code, apiBaseUrl: 'https://p.test', status: 'ACTIVE', isPrimary, createdAt: new Date(createdAt) },
    })
}

describe('provider ordering', () => {
    beforeEach(async () => {
        await prisma.providerGame.deleteMany()
        await prisma.gameVendor.deleteMany()
        await prisma.gameProvider.deleteMany()
    })

    it('lobby leads with the primary provider even when another was created first', async () => {
        await provider('order-old', '2026-01-01T00:00:00Z')
        await provider('order-primary', '2026-01-05T00:00:00Z', true)
        const lobby = await GameCatalogService.getLobby({ pageSize: 1 })
        expect(lobby.activeProviderCode).toBe('order-primary')
        expect(lobby.providers.map((p) => p.code)).toEqual(['order-primary', 'order-old'])
    })

    it('lobby falls back to the oldest provider, not row order', async () => {
        await provider('order-newer', '2026-02-01T00:00:00Z')
        await provider('order-older', '2026-01-01T00:00:00Z')
        const lobby = await GameCatalogService.getLobby({ pageSize: 1 })
        expect(lobby.activeProviderCode).toBe('order-older')
    })

    it('GET /providers uses the same order', async () => {
        await provider('order-newer', '2026-02-01T00:00:00Z')
        await provider('order-older', '2026-01-01T00:00:00Z')
        const app = Fastify({ logger: false })
        app.decorate('authenticate', async () => {})
        await app.register(gameProviderRoutes, { prefix: '/providers' })
        const res = await app.inject({ method: 'GET', url: '/providers' })
        expect(res.json().map((p: { code: string }) => p.code)).toEqual(['order-older', 'order-newer'])
    })
})
