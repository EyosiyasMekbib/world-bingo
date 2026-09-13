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

    it('debugAtlasVHash exposes the same expected hash that made verifyAtlasVBody pass', async () => {
        const { signAtlasVBody, verifyAtlasVBody, debugAtlasVHash } = await import('../gateways/game-provider/atlasv-signature.js')
        const signed = signAtlasVBody({ game: 'penalty', casino_id: 'c1', player_id: 'p1', amount: 100 })
        expect(verifyAtlasVBody(signed)).toBe(true)

        const diag = debugAtlasVHash(signed)
        expect(diag.expected).toBe(signed.hash)
        expect(diag.received).toBe(signed.hash)
        expect(diag.timestamp).toBe(signed.timestamp)
    })

    it('matches Atlas-V\'s real hash for a known request (confirmed against their staging test tool)', async () => {
        vi.resetModules()
        const prevKey = process.env.ATLASV_PRIVATE_KEY
        process.env.ATLASV_PRIVATE_KEY = 'fivuebwifigyhwiqbd'
        const { verifyAtlasVBody } = await import('../gateways/game-provider/atlasv-signature.js')
        // Captured verbatim from staging logs: /account request whose hash Atlas-V's
        // own test tool computed. Locks in the confirmed formula — timestamp is
        // appended raw, NOT included in the hashed JSON — so a future change can't
        // silently regress back to the wrong (assumed) canonicalization.
        const realRequest = {
            game: 'keno',
            casino_id: 'betshop',
            player_id: 'defefe',
            session_id: 'test-session-1',
            hash: 'd7bf94dc8fdf87a29a4d6422a370cfaa86865e10',
            timestamp: '1789240675555',
        }
        expect(verifyAtlasVBody(realRequest)).toBe(true)
        process.env.ATLASV_PRIVATE_KEY = prevKey
        vi.resetModules()
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
