/**
 * HTTP-level coverage for the refresh-refusal `code` on the wire.
 *
 * `apps/api/src/lib/error-handler.ts` (extracted here from index.ts — see
 * that file's comment) maps a thrown `RefreshTokenError` onto a 401 body
 * carrying `code: 'refresh_token_invalid' | 'refresh_token_expired'`. The
 * web store (Task 5, not yet written) will clear a player's session ONLY
 * when it sees one of those two exact `code` values and will keep the
 * session for everything else — so this assertion is the contract between
 * the two halves of the "stop forced logouts" fix.
 *
 * auth-refresh-limits.test.ts only covers the pure rate-limit-key helpers;
 * nothing before this file drove a real `POST /auth/refresh` through the
 * real route, the real `AuthController`/`AuthService`, and the real error
 * handler and asserted the response body shape. A reorder of the handler's
 * branches (the RefreshTokenError branch must run before the older
 * 'Invalid refresh token' string-match branch — see error-handler.ts), or a
 * future refactor of `AuthController.refresh` that starts catching and
 * rewrapping errors, would silently reintroduce the bug with nothing here
 * to catch it.
 */
import { describe, it, expect, vi } from 'vitest'
import crypto from 'crypto'
import Fastify from 'fastify'
import fastifyJwt from '@fastify/jwt'
import fastifyRateLimit from '@fastify/rate-limit'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import authRoutes from '../routes/auth'
import { mapErrorToResponse } from '../lib/error-handler'
import { AuthService } from '../services/auth.service'
import { prisma } from './setup'

// A key pair standing in for the server's real RS256 keys, generated fresh
// for this test file — never the real keys from lib/jwt-keys.ts.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

/**
 * Builds the smallest server that exercises the real error-handler branch:
 * the real @fastify/jwt plugin (so AuthController.refresh's `reply.jwtSign`
 * works), the real `authRoutes` plugin under `/auth`, and the same
 * `mapErrorToResponse` function index.ts installs.
 *
 * `setErrorHandler` is called before any `await server.register(...)`, and
 * must stay that way — mirroring index.ts, where it runs at line ~212,
 * before `authRoutes` is registered at line ~287. In Fastify v5,
 * `await app.register(...)` is thenable and drives the child plugin through
 * a full `ready()`-style boot; a handler set only after that await runs too
 * late for the already-booted `/auth` child context and that context falls
 * back to Fastify's own default error shape (no `code` field, and 500s for
 * errors this handler maps to 4xx) instead of `mapErrorToResponse`.
 */
async function buildApp() {
    const app = Fastify({ logger: false })
    app.setErrorHandler(mapErrorToResponse)
    await app.register(fastifyJwt, {
        secret: { private: privateKey, public: publicKey },
        sign: { algorithm: 'RS256', expiresIn: '15m' },
    })
    // authRoutes reads `fastify.authenticate` at registration time (for
    // /me and /change-password). Neither route is exercised by this file —
    // a stub that's never invoked is enough to let the plugin register.
    app.decorate('authenticate', async () => {})
    // Required, not incidental: /auth/refresh builds its per-IP ceiling with
    // `fastify.rateLimit(...)` at registration time, so authRoutes cannot be
    // registered without the plugin. Production must fail loudly if this is
    // ever missing — a silently absent ceiling is the bug it exists to
    // prevent — so the test registers it rather than the route tolerating it.
    // The limits here are far above anything these few injects reach, so they
    // never colour the response shapes under test.
    await app.register(fastifyRateLimit, { global: false })
    await app.register(authRoutes, { prefix: '/auth' })
    await app.ready()
    return app
}

async function seedRefreshToken(suffix: string): Promise<string> {
    const username = `refresh_route_${suffix}`
    await AuthService.register({
        username,
        phone: `+25197710${suffix}`,
        password: 'password123',
    })
    const { refreshToken } = await AuthService.login({
        identifier: username,
        password: 'password123',
    })
    return refreshToken
}

function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex')
}

describe('POST /auth/refresh — wire-level response shape', () => {
    it('responds 401 with code "refresh_token_invalid" for a retired/unknown token', async () => {
        const app = await buildApp()

        const res = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            payload: { refreshToken: 'not-a-real-token' },
        })

        expect(res.statusCode).toBe(401)
        const body = res.json()
        expect(body).toMatchObject({
            statusCode: 401,
            error: 'Unauthorized',
            code: 'refresh_token_invalid',
        })
        expect(typeof body.message).toBe('string')
        await app.close()
    })

    it('responds 401 with code "refresh_token_expired" for an expired token', async () => {
        const app = await buildApp()
        const token = await seedRefreshToken('001')
        await prisma.refreshToken.updateMany({
            where: { tokenHash: hashToken(token) },
            data: { expiresAt: new Date(Date.now() - 1000) },
        })

        const res = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            payload: { refreshToken: token },
        })

        expect(res.statusCode).toBe(401)
        const body = res.json()
        expect(body).toMatchObject({
            statusCode: 401,
            error: 'Unauthorized',
            code: 'refresh_token_expired',
        })
        expect(typeof body.message).toBe('string')
        await app.close()
    })

    it('responds 200 with no "code" field for a successful refresh', async () => {
        const app = await buildApp()
        const token = await seedRefreshToken('002')

        const res = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            payload: { refreshToken: token },
        })

        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body).not.toHaveProperty('code')
        expect(typeof body.accessToken).toBe('string')
        expect(body.refreshToken).not.toBe(token)
        await app.close()
    })

    it('does not attach a "code" to an unrelated failure through the same handler', async () => {
        // A wrong-password login runs through the exact same setErrorHandler
        // via the pre-existing 'Invalid credentials' branch — a different
        // shape of 401 that the client must NOT treat as a refresh refusal.
        // Guards against a future change giving that branch a colliding
        // `code` field.
        const app = await buildApp()
        const username = 'refresh_route_003'
        await AuthService.register({
            username,
            phone: '+251977100003',
            password: 'password123',
        })

        const res = await app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: { identifier: username, password: 'wrong-password' },
        })

        expect(res.statusCode).toBe(401)
        const body = res.json()
        expect(body).not.toHaveProperty('code')
        expect(body.error).toBe('Unauthorized')
        await app.close()
    })
})
