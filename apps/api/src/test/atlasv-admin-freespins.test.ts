import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../lib/prisma.js', () => ({ default: { user: { findUnique: vi.fn() } } }))

const mockCreateFreeSpins = vi.fn()
vi.mock('../gateways/game-provider/index.js', () => ({
    getGameProviderGateway: vi.fn(() => ({ createFreeSpins: mockCreateFreeSpins })),
}))

import prisma from '../lib/prisma.js'
const p = prisma as any

async function buildApp() {
    const app = Fastify()
    const { default: atlasVAdminRoutes } = await import('../routes/admin/atlasv.js')
    await app.register(atlasVAdminRoutes, { prefix: '/admin/game-providers/atlasv' })
    return app
}

describe('POST /admin/game-providers/atlasv/freespins', () => {
    beforeEach(() => vi.clearAllMocks())

    it('grants freespins for an existing user', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
        mockCreateFreeSpins.mockResolvedValue(undefined)

        const app = await buildApp()
        const res = await app.inject({
            method: 'POST',
            url: '/admin/game-providers/atlasv/freespins',
            payload: { userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', endDate: '2026-12-14T11:55:00+00:00', freespinsCount: 5 },
        })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ success: true })
        expect(mockCreateFreeSpins).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-12-14T11:55:00+00:00', 5)
    })

    it('404s for an unknown user', async () => {
        p.user.findUnique.mockResolvedValue(null)
        const app = await buildApp()
        const res = await app.inject({
            method: 'POST',
            url: '/admin/game-providers/atlasv/freespins',
            payload: { userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', endDate: '2026-12-14T11:55:00+00:00', freespinsCount: 5 },
        })
        expect(res.statusCode).toBe(404)
    })

    it('400s on an invalid body', async () => {
        const app = await buildApp()
        const res = await app.inject({
            method: 'POST',
            url: '/admin/game-providers/atlasv/freespins',
            payload: { userId: 'not-a-uuid', endDate: '2026-12-14T11:55:00+00:00', freespinsCount: 5 },
        })
        expect(res.statusCode).toBe(400)
    })
})
