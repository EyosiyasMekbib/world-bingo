/**
 * Coverage for the refresh-token "family" — the identity that links a
 * device's whole rotation chain together (see the `familyId` column and its
 * comment in prisma/schema.prisma, and `rotateRefreshToken`/`logout` in
 * auth.service.ts).
 *
 * Before this column existed, `logout(token)` only ever deleted the single
 * presented hash. A grace-window burst (concurrent refreshes of the same
 * token — see auth-refresh-grace.test.ts) mints several unrotated sibling
 * rows that all outlive a `logout()` call on any one of them, staying valid
 * for up to 30 days after the player thinks they've logged out. Giving every
 * row minted from one login its login's `familyId` lets `logout` revoke the
 * whole chain in one delete, while leaving every OTHER device's chain (its
 * own, separate `familyId`) untouched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import crypto from 'crypto'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import { AuthService } from '../services/auth.service'
import { prisma } from './setup'

let userId: string

// Mirrors the private hashToken() in auth.service.ts.
function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex')
}

beforeEach(async () => {
    vi.clearAllMocks()
    const { user } = await AuthService.register({
        username: 'family_user',
        phone: '+251977100002',
        password: 'password123',
    })
    userId = user.id
})

async function issueToken(): Promise<string> {
    const { refreshToken } = await AuthService.login({
        identifier: 'family_user',
        password: 'password123',
    })
    return refreshToken
}

async function familyOf(token: string): Promise<string | null> {
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } })
    return row?.familyId ?? null
}

describe('refresh token families', () => {
    it('gives every sibling minted by a grace-window burst the same familyId', async () => {
        const original = await issueToken()
        const originalFamily = await familyOf(original)
        expect(originalFamily).not.toBeNull()

        const results = await Promise.all([
            AuthService.refreshToken(original),
            AuthService.refreshToken(original),
            AuthService.refreshToken(original),
        ])
        const issued = results.map((r) => r.refreshToken)
        expect(new Set(issued).size).toBe(3) // one winner, two grace siblings

        for (const token of issued) {
            expect(await familyOf(token)).toBe(originalFamily)
        }
    })

    it('revokes every sibling in the chain when logout is called with any one of them', async () => {
        const original = await issueToken()
        const results = await Promise.all([
            AuthService.refreshToken(original),
            AuthService.refreshToken(original),
            AuthService.refreshToken(original),
        ])
        const issued = results.map((r) => r.refreshToken)

        // Log out with the second sibling, not the first — any member of the
        // chain must revoke the whole thing, not just itself.
        await AuthService.logout(issued[1])

        expect(await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(original) } })).toBeNull()
        for (const token of issued) {
            expect(await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } })).toBeNull()
        }
    })

    it("does not revoke a second device's family when the first logs out", async () => {
        const deviceA = await issueToken()
        const deviceB = await issueToken()
        expect(await familyOf(deviceA)).not.toBe(await familyOf(deviceB))

        await AuthService.logout(deviceA)

        expect(await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(deviceA) } })).toBeNull()
        // Device B's own token is untouched and keeps working.
        const stillThere = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(deviceB) } })
        expect(stillThere).not.toBeNull()
        const { refreshToken: rotatedB } = await AuthService.refreshToken(deviceB)
        expect(rotatedB).not.toBe(deviceB)
    })

    it('still refreshes a legacy row with no familyId, and links the new token to it', async () => {
        const legacyToken = crypto.randomBytes(64).toString('hex')
        const legacyRow = await prisma.refreshToken.create({
            data: {
                userId,
                tokenHash: hashToken(legacyToken),
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
                // familyId omitted — simulates a row written before the column existed.
            },
        })
        expect(legacyRow.familyId).toBeNull()

        const { refreshToken: rotated } = await AuthService.refreshToken(legacyToken)

        const rotatedFamily = await familyOf(rotated)
        expect(rotatedFamily).toBe(legacyRow.id)
    })

    it('still logs out a legacy row with no familyId, via the single-hash fallback', async () => {
        const legacyToken = crypto.randomBytes(64).toString('hex')
        await prisma.refreshToken.create({
            data: {
                userId,
                tokenHash: hashToken(legacyToken),
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
            },
        })

        await AuthService.logout(legacyToken)

        expect(await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(legacyToken) } })).toBeNull()
    })
})
