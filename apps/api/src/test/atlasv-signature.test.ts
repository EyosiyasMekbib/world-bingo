import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('Atlas-V signature', () => {
    beforeEach(() => {
        process.env.ATLASV_PRIVATE_KEY = 'test-private-key'
    })

    it('signs a body and verifies it round-trips', async () => {
        const { signAtlasVBody, verifyAtlasVBody } = await import('../gateways/game-provider/atlasv-signature.js')
        const signed = signAtlasVBody({ game: 'penalty', casino_id: 'c1', player_id: 'p1', amount: 100 })
        expect(signed.hash).toMatch(/^[0-9a-f]{40}$/)
        expect(verifyAtlasVBody(signed)).toBe(true)
    })

    it('rejects a tampered field', async () => {
        const { signAtlasVBody, verifyAtlasVBody } = await import('../gateways/game-provider/atlasv-signature.js')
        const signed = signAtlasVBody({ game: 'penalty', casino_id: 'c1', player_id: 'p1', amount: 100 })
        expect(verifyAtlasVBody({ ...signed, amount: 999 })).toBe(false)
    })

    it('rejects a body with no hash field', async () => {
        const { verifyAtlasVBody } = await import('../gateways/game-provider/atlasv-signature.js')
        expect(verifyAtlasVBody({ game: 'penalty', player_id: 'p1', timestamp: String(Date.now()) })).toBe(false)
    })

    it('rejects when ATLASV_PRIVATE_KEY is unset', async () => {
        vi.resetModules()
        const prevKey = process.env.ATLASV_PRIVATE_KEY
        delete process.env.ATLASV_PRIVATE_KEY
        const { signAtlasVBody, verifyAtlasVBody } = await import('../gateways/game-provider/atlasv-signature.js')
        const signed = signAtlasVBody({ game: 'penalty', player_id: 'p1' })
        expect(verifyAtlasVBody(signed)).toBe(false)
        process.env.ATLASV_PRIVATE_KEY = prevKey
        vi.resetModules()
    })
})
