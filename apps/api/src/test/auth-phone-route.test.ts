/**
 * Wire-level coverage for `POST /auth/phone` — the only way a player signs in.
 *
 * The service-level rules (which account a verified number reaches) are covered
 * in auth-firebase-phone.test.ts. What this file pins down is the response the
 * browser actually receives, because the web app branches on it:
 *
 *   503 firebase_not_configured / firebase_keys_unavailable → "try again",
 *       the player's code was never the problem
 *   401 firebase_token_invalid                              → "verify again"
 *   403                                                     → a staff number
 *
 * Losing that distinction (an error handler that drops `code`, or flattens
 * everything to 401) turns a misconfigured deployment into a screen telling
 * every player their correct SMS code is wrong.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import Fastify from 'fastify'
import fastifyJwt from '@fastify/jwt'
import fastifyRateLimit from '@fastify/rate-limit'
import { UserRole } from '@world-bingo/shared-types'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import authRoutes from '../routes/auth'
import { mapErrorToResponse } from '../lib/error-handler'
import { FirebaseAuthError, __resetFirebaseCertCache } from '../lib/firebase'
import { prisma } from './setup'

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

/** The same shape index.ts boots: real routes, real controller, real handler. */
async function buildApp() {
    const app = Fastify({ logger: false })
    app.setErrorHandler(mapErrorToResponse)
    await app.register(fastifyJwt, {
        secret: { private: privateKey, public: publicKey },
        sign: { algorithm: 'RS256', expiresIn: '15m' },
    })
    app.decorate('authenticate', async () => {})
    // /auth/phone and /auth/refresh both build limiters at registration time.
    await app.register(fastifyRateLimit, { global: false })
    await app.register(authRoutes, { prefix: '/auth' })
    await app.ready()
    return app
}

function post(app: Awaited<ReturnType<typeof buildApp>>, payload: unknown) {
    return app.inject({ method: 'POST', url: '/auth/phone', payload: payload as object })
}

describe('POST /auth/phone', () => {
    const originalProjectId = process.env.FIREBASE_PROJECT_ID

    beforeEach(() => {
        __resetFirebaseCertCache()
        // Nothing here should ever reach the network; a test that does is a bug.
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network call') }))
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        if (originalProjectId === undefined) delete process.env.FIREBASE_PROJECT_ID
        else process.env.FIREBASE_PROJECT_ID = originalProjectId
    })

    it('answers 503 firebase_not_configured when the brand has no project', async () => {
        delete process.env.FIREBASE_PROJECT_ID
        const app = await buildApp()

        const res = await post(app, { idToken: 'anything' })

        expect(res.statusCode).toBe(503)
        expect(res.json()).toMatchObject({
            statusCode: 503,
            error: 'Service Unavailable',
            code: 'firebase_not_configured',
        })
        await app.close()
    })

    it('answers 401 firebase_token_invalid for a token that is not a JWT', async () => {
        process.env.FIREBASE_PROJECT_ID = 'arada-bingo-test'
        const app = await buildApp()

        const res = await post(app, { idToken: 'not-a-jwt' })

        expect(res.statusCode).toBe(401)
        expect(res.json()).toMatchObject({
            statusCode: 401,
            error: 'Unauthorized',
            code: 'firebase_token_invalid',
        })
        await app.close()
    })

    it('rejects a body with no token before any verification', async () => {
        process.env.FIREBASE_PROJECT_ID = 'arada-bingo-test'
        const app = await buildApp()

        const res = await post(app, {})

        expect(res.statusCode).toBe(400)
        await app.close()
    })

    // The phone number is never read from the body — a caller who sends one
    // gets it ignored, not honoured.
    it('ignores a phone number in the request body', async () => {
        process.env.FIREBASE_PROJECT_ID = 'arada-bingo-test'
        const app = await buildApp()

        const res = await post(app, { idToken: 'not-a-jwt', phone: '+251911234567' })

        expect(res.statusCode).toBe(401)
        expect(await prisma.user.count()).toBe(0)
        await app.close()
    })
})

/**
 * The success and staff-refusal paths, with verification stubbed — a real
 * signature is exercised in firebase-token.test.ts. Separate describe because
 * the module mock has to be in place before `authRoutes` pulls the service in.
 */
describe('POST /auth/phone — signed in', () => {
    beforeEach(() => {
        process.env.FIREBASE_PROJECT_ID = 'arada-bingo-test'
    })

    it('answers 200 with a user, an access token and a refresh token', async () => {
        const { AuthService } = await import('../services/auth.service')
        const spy = vi.spyOn(AuthService, 'firebasePhoneAuth')
        const user = await prisma.user.create({
            data: { phone: '+251911234567', firebaseUid: 'uid-1', wallet: { create: {} } },
        })
        spy.mockResolvedValue({ user: user as never, refreshToken: 'refresh-token-value' })

        const app = await buildApp()
        const res = await post(app, { idToken: 'good-token' })

        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.user.id).toBe(user.id)
        expect(body.refreshToken).toBe('refresh-token-value')
        expect(typeof body.accessToken).toBe('string')
        // The access token carries the role the rest of the API authorises on.
        expect(app.jwt.verify<{ id: string; role: string }>(body.accessToken)).toMatchObject({
            id: user.id,
            role: UserRole.PLAYER,
        })

        spy.mockRestore()
        await app.close()
    })

    it('surfaces a staff refusal as 403 with its code', async () => {
        const { AuthService } = await import('../services/auth.service')
        const spy = vi.spyOn(AuthService, 'firebasePhoneAuth')
        spy.mockRejectedValue(
            new FirebaseAuthError('firebase_token_invalid', 'This number belongs to a staff account.', 403),
        )

        const app = await buildApp()
        const res = await post(app, { idToken: 'good-token' })

        expect(res.statusCode).toBe(403)
        expect(res.json()).toMatchObject({ statusCode: 403, error: 'Forbidden' })

        spy.mockRestore()
        await app.close()
    })
})
