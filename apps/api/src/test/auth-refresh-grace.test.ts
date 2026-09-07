import { describe, it, expect, beforeEach, vi } from 'vitest'
import crypto from 'crypto'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import { AuthService, REFRESH_GRACE_MS, RefreshTokenError } from '../services/auth.service'
import { prisma } from './setup'

let userId: string

// Mirrors the private hashToken() in auth.service.ts — needed here to look up
// a specific row by token, since `register()` also issues its own refresh
// token and a bare `{ userId }` query would pick that row up too.
function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex')
}

beforeEach(async () => {
    vi.clearAllMocks()
    const { user } = await AuthService.register({
        username: 'refresh_user',
        phone: '+251977100001',
        password: 'password123',
    })
    userId = user.id
})

async function issueToken(): Promise<string> {
    const { refreshToken } = await AuthService.login({
        identifier: 'refresh_user',
        password: 'password123',
    })
    return refreshToken
}

describe('AuthService.refreshToken', () => {
    it('rotates a valid token and returns a different one', async () => {
        const first = await issueToken()
        const { refreshToken: second } = await AuthService.refreshToken(first)
        expect(second).not.toBe(first)
        // the rotated row is kept, not deleted — checked by tokenHash, not a
        // blanket userId query, since register() in beforeEach also issues
        // its own (untouched) refresh token for this user.
        const firstRow = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(first) } })
        const secondRow = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(second) } })
        expect(firstRow).not.toBeNull()
        expect(firstRow?.rotatedAt).toBeInstanceOf(Date)
        expect(secondRow?.rotatedAt).toBeNull()
    })

    it('serves concurrent refreshes of the same token — the whole point', async () => {
        const token = await issueToken()
        const results = await Promise.all([
            AuthService.refreshToken(token),
            AuthService.refreshToken(token),
            AuthService.refreshToken(token),
        ])
        const issued = results.map((r) => r.refreshToken)
        expect(new Set(issued).size).toBe(3)
        for (const r of results) expect(r.user.id).toBe(userId)
    })

    it('never throws P2025 when two refreshes race', async () => {
        const token = await issueToken()
        const settled = await Promise.allSettled([
            AuthService.refreshToken(token),
            AuthService.refreshToken(token),
        ])
        expect(settled.every((s) => s.status === 'fulfilled')).toBe(true)
    })

    it('rejects reuse once the grace window has passed', async () => {
        const token = await issueToken()
        await AuthService.refreshToken(token)
        const stale = new Date(Date.now() - REFRESH_GRACE_MS - 1000)
        await prisma.refreshToken.updateMany({ where: { rotatedAt: { not: null } }, data: { rotatedAt: stale } })
        await expect(AuthService.refreshToken(token)).rejects.toMatchObject({
            code: 'refresh_token_invalid',
            statusCode: 401,
        })
    })

    it('rejects an unknown token as invalid', async () => {
        await expect(AuthService.refreshToken('not-a-real-token')).rejects.toBeInstanceOf(RefreshTokenError)
        await expect(AuthService.refreshToken('not-a-real-token')).rejects.toMatchObject({
            code: 'refresh_token_invalid',
        })
    })

    it('rejects an expired token with its own code and removes the row', async () => {
        const token = await issueToken()
        const tokenHash = hashToken(token)
        // Scoped to this token's row, not a blanket `{ rotatedAt: null }`
        // update — register()'s own refresh token for this user also matches
        // that filter and must be left alone.
        await prisma.refreshToken.updateMany({
            where: { tokenHash },
            data: { expiresAt: new Date(Date.now() - 1000) },
        })
        await expect(AuthService.refreshToken(token)).rejects.toMatchObject({
            code: 'refresh_token_expired',
        })
        expect(await prisma.refreshToken.findUnique({ where: { tokenHash } })).toBeNull()
    })

    it('prunes rotated rows older than the grace window on the next refresh', async () => {
        const first = await issueToken()
        const { refreshToken: second } = await AuthService.refreshToken(first)
        await prisma.refreshToken.updateMany({
            where: { rotatedAt: { not: null } },
            data: { rotatedAt: new Date(Date.now() - 10 * 60_000) },
        })
        await AuthService.refreshToken(second)
        const stale = await prisma.refreshToken.count({
            where: { userId, rotatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
        })
        expect(stale).toBe(0)
    })
})
