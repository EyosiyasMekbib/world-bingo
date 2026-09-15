/**
 * Admin-assisted password reset, driven over HTTP through the real admin and
 * auth routes.
 *
 * Players who forget their password had no way back in: about 600 a day hit
 * invalid_credentials at peak and most of them re-registered. Support now
 * verifies the player and an admin issues a one-time temporary password. That
 * endpoint hands out account takeover, so the guards are the point of this
 * file: clerks are refused, staff and bot accounts cannot be targeted, every
 * existing session dies, and the player has to choose a new password at the
 * next sign-in.
 *
 * The role guards below mirror the ones index.ts decorates (jwtVerify, then a
 * role check). Stubbing them to always pass — as the other admin route tests
 * do — would let this route sit in the clerk scope and still go green.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'
import Fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import fastifyRateLimit from '@fastify/rate-limit'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/posthog')>()),
    captureEvent,
}))
vi.mock('../lib/redis', () => ({
    default: {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        keys: vi.fn().mockResolvedValue([]),
    },
}))

import authRoutes from '../routes/auth'
import adminRoutes from '../routes/admin/index'
import { mapErrorToResponse } from '../lib/error-handler'
import {
    AuthService,
    TEMP_PASSWORD_ALPHABET,
    TEMP_PASSWORD_LENGTH,
    generateTemporaryPassword,
} from '../services/auth.service'
import { prisma } from './setup'

// A key pair standing in for the server's real RS256 keys — never the real
// keys from lib/jwt-keys.ts.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function roleGuard(allowed: string[], message: string) {
    return async function (request: any, reply: any) {
        try {
            await request.jwtVerify()
        } catch (err) {
            return reply.send(err)
        }
        if (!allowed.includes(request.user.role)) {
            return reply.status(403).send({ error: message })
        }
    }
}

async function buildApp() {
    const app = Fastify({ logger: false })
    // Before any register — see auth-refresh-route.test.ts for why the order
    // matters in Fastify v5.
    app.setErrorHandler(mapErrorToResponse)
    await app.register(fastifyJwt, {
        secret: { private: privateKey, public: publicKey },
        sign: { algorithm: 'RS256', expiresIn: '15m' },
    })
    app.decorate('authenticate', async (request: any, reply: any) => {
        try {
            await request.jwtVerify()
        } catch (err) {
            return reply.send(err)
        }
    })
    app.decorate('requireAdmin', roleGuard(['ADMIN', 'SUPER_ADMIN'], 'Forbidden: Admin access only'))
    app.decorate('requireSuperAdmin', roleGuard(['SUPER_ADMIN'], 'Forbidden: Super admin access only'))
    app.decorate(
        'requireAdminOrClerk',
        roleGuard(['ADMIN', 'SUPER_ADMIN', 'CLERK'], 'Forbidden: Insufficient permissions'),
    )
    // Registered so the reset route's own per-admin budget is live. authRoutes
    // needs it regardless (its IP ceilings are built at registration time).
    await app.register(fastifyRateLimit, { global: false })
    await app.register(authRoutes, { prefix: '/auth' })
    await app.register(adminRoutes, { prefix: '/admin' })
    await app.ready()
    return app
}

let seq = 0
function uniq(): string {
    seq += 1
    return `${Date.now().toString(36)}${seq}`
}

function randomPhone(): string {
    return `+2519${Math.floor(10_000_000 + Math.random() * 89_999_999)}`
}

async function seedPlayer() {
    const username = `pwr_p_${uniq()}`
    const phone = randomPhone()
    const { user, refreshToken } = await AuthService.register({ username, phone, password: 'original-pass' })
    return { id: user.id, role: user.role as string, username, phone, refreshToken }
}

async function seedStaff(role: 'ADMIN' | 'SUPER_ADMIN' | 'CLERK') {
    return prisma.user.create({
        data: { username: `pwr_${role.toLowerCase()}_${uniq()}`, passwordHash: 'hashed:staff-pass', role },
    })
}

function bearer(app: FastifyInstance, user: { id: string; role: string }) {
    return { authorization: `Bearer ${app.jwt.sign({ id: user.id, role: user.role })}` }
}

function resetPassword(app: FastifyInstance, actor: { id: string; role: string }, targetId: string) {
    return app.inject({
        method: 'POST',
        url: `/admin/users/${targetId}/reset-password`,
        headers: bearer(app, actor),
    })
}

const TEMP_PASSWORD_RE = new RegExp(`^[${TEMP_PASSWORD_ALPHABET}]{${TEMP_PASSWORD_LENGTH}}$`)

beforeEach(async () => {
    captureEvent.mockClear()
    // cleanDb() in setup.ts leaves the audit trail alone.
    await prisma.auditLog.deleteMany({ where: { action: 'user.password_reset' } })
})

describe('generateTemporaryPassword', () => {
    it('is 8 characters from an alphabet support can read over the phone', () => {
        expect(TEMP_PASSWORD_LENGTH).toBe(8)
        for (const ambiguous of ['0', 'O', '1', 'l', 'I']) {
            expect(TEMP_PASSWORD_ALPHABET).not.toContain(ambiguous)
        }
        for (let i = 0; i < 500; i++) {
            expect(generateTemporaryPassword()).toMatch(TEMP_PASSWORD_RE)
        }
    })

    it('draws every character from crypto.randomInt', () => {
        const spy = vi.spyOn(crypto, 'randomInt')
        try {
            generateTemporaryPassword()
            expect(spy).toHaveBeenCalledTimes(TEMP_PASSWORD_LENGTH)
            expect(spy).toHaveBeenCalledWith(TEMP_PASSWORD_ALPHABET.length)
        } finally {
            spy.mockRestore()
        }
    })
})

describe('POST /admin/users/:id/reset-password', () => {
    it('lets an ADMIN reset a player and returns the temporary password once', async () => {
        const app = await buildApp()
        const admin = await seedStaff('ADMIN')
        const player = await seedPlayer()

        const res = await resetPassword(app, admin, player.id)

        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(Object.keys(body)).toEqual(['temporaryPassword'])
        expect(body.temporaryPassword).toMatch(TEMP_PASSWORD_RE)
        // A credential in the body: no proxy or browser cache may keep it.
        expect(res.headers['cache-control']).toBe('no-store')

        const row = await prisma.user.findUnique({ where: { id: player.id } })
        expect(row?.passwordHash).toBe(`hashed:${body.temporaryPassword}`)
        expect(row?.mustChangePassword).toBe(true)
        await app.close()
    })

    it('lets a SUPER_ADMIN reset a player', async () => {
        const app = await buildApp()
        const root = await seedStaff('SUPER_ADMIN')
        const player = await seedPlayer()

        const res = await resetPassword(app, root, player.id)

        expect(res.statusCode).toBe(200)
        await app.close()
    })

    it.each(['CLERK', 'PLAYER'] as const)('refuses a %s with 403 and leaves the password alone', async (role) => {
        const app = await buildApp()
        const actor = role === 'CLERK' ? await seedStaff('CLERK') : await seedPlayer()
        const player = await seedPlayer()

        const res = await resetPassword(app, actor, player.id)

        expect(res.statusCode).toBe(403)
        const row = await prisma.user.findUnique({ where: { id: player.id } })
        expect(row?.passwordHash).toBe('hashed:original-pass')
        expect(row?.mustChangePassword).toBe(false)
        expect(await prisma.auditLog.count({ where: { action: 'user.password_reset' } })).toBe(0)
        await app.close()
    })

    it('returns 404 for an unknown user', async () => {
        const app = await buildApp()
        const admin = await seedStaff('ADMIN')

        const res = await resetPassword(app, admin, crypto.randomUUID())

        expect(res.statusCode).toBe(404)
        await app.close()
    })

    // An ADMIN who could reset a SUPER_ADMIN would sign in as them.
    it.each(['ADMIN', 'SUPER_ADMIN', 'CLERK'] as const)('refuses to reset a %s account', async (role) => {
        const app = await buildApp()
        const admin = await seedStaff('ADMIN')
        const target = await seedStaff(role)

        const res = await resetPassword(app, admin, target.id)

        expect(res.statusCode).toBe(403)
        expect(res.json().code).toBe('reset_not_allowed')
        const row = await prisma.user.findUnique({ where: { id: target.id } })
        expect(row?.passwordHash).toBe('hashed:staff-pass')
        await app.close()
    })

    it('refuses to reset a bot account', async () => {
        const app = await buildApp()
        const admin = await seedStaff('ADMIN')
        const bot = await prisma.user.create({
            data: { username: `bot_t_${uniq()}`, passwordHash: 'BOT_ACCOUNT', role: 'PLAYER' },
        })

        const res = await resetPassword(app, admin, bot.id)

        expect(res.statusCode).toBe(403)
        expect(res.json().code).toBe('reset_not_allowed')
        await app.close()
    })

    it('refuses an account that has no username or phone to sign in with', async () => {
        const app = await buildApp()
        const admin = await seedStaff('ADMIN')
        const telegramOnly = await prisma.user.create({
            data: { telegramId: `tg_${uniq()}`, firstName: 'Tele', role: 'PLAYER' },
        })

        const res = await resetPassword(app, admin, telegramOnly.id)

        expect(res.statusCode).toBe(409)
        expect(res.json().code).toBe('no_password_login')
        await app.close()
    })

    it('signs the player in with the temporary password and flags the session', async () => {
        const app = await buildApp()
        const admin = await seedStaff('ADMIN')
        const player = await seedPlayer()
        const { temporaryPassword } = (await resetPassword(app, admin, player.id)).json()

        const login = await app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: { identifier: player.phone, password: temporaryPassword },
        })

        expect(login.statusCode).toBe(200)
        const body = login.json()
        expect(body.user.mustChangePassword).toBe(true)
        expect(body.user).not.toHaveProperty('passwordHash')

        // The refresh response carries the same user DTO.
        const refresh = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            payload: { refreshToken: body.refreshToken },
        })
        expect(refresh.statusCode).toBe(200)
        expect(refresh.json().user.mustChangePassword).toBe(true)

        // So does /auth/me.
        const me = await app.inject({
            method: 'GET',
            url: '/auth/me',
            headers: { authorization: `Bearer ${body.accessToken}` },
        })
        expect(me.statusCode).toBe(200)
        expect(me.json()).toMatchObject({ id: player.id, mustChangePassword: true })
        expect(me.json()).not.toHaveProperty('passwordHash')

        // The old password is gone.
        const old = await app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: { identifier: player.phone, password: 'original-pass' },
        })
        expect(old.statusCode).toBe(401)
        await app.close()
    })

    it('signs the player out everywhere: refresh tokens from before the reset are rejected', async () => {
        const app = await buildApp()
        const admin = await seedStaff('ADMIN')
        const player = await seedPlayer()
        const second = await AuthService.login({ identifier: player.username, password: 'original-pass' })

        expect((await resetPassword(app, admin, player.id)).statusCode).toBe(200)

        for (const refreshToken of [player.refreshToken, second.refreshToken]) {
            const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } })
            expect(res.statusCode).toBe(401)
            expect(res.json().code).toBe('refresh_token_invalid')
        }
        expect(await prisma.refreshToken.count({ where: { userId: player.id } })).toBe(0)
        await app.close()
    })

    it('writes an audit row naming the admin and the player, never the password', async () => {
        const app = await buildApp()
        const admin = await seedStaff('ADMIN')
        const player = await seedPlayer()

        const { temporaryPassword } = (await resetPassword(app, admin, player.id)).json()

        const rows = await prisma.auditLog.findMany({ where: { action: 'user.password_reset' } })
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            actorId: admin.id,
            actorName: admin.username,
            target: `user:${player.id}`,
        })
        const serialized = JSON.stringify(rows[0])
        expect(serialized).not.toContain(temporaryPassword)
        expect(serialized).not.toContain('hashed:')
        await app.close()
    })

    it('emits password_reset_by_admin for the player with no PII or password', async () => {
        const app = await buildApp()
        const admin = await seedStaff('ADMIN')
        const player = await seedPlayer()
        captureEvent.mockClear()

        const { temporaryPassword } = (await resetPassword(app, admin, player.id)).json()

        const calls = captureEvent.mock.calls.filter(([, event]) => event === 'password_reset_by_admin')
        expect(calls).toHaveLength(1)
        expect(calls[0][0]).toBe(player.id)
        const serialized = JSON.stringify(calls[0])
        for (const secret of [temporaryPassword, player.phone, player.username, admin.username!]) {
            expect(serialized).not.toContain(secret)
        }
        await app.close()
    })

    it('rate-limits each admin on their own budget', async () => {
        const app = await buildApp()
        const first = await seedStaff('ADMIN')
        const second = await seedStaff('ADMIN')
        const player = await seedPlayer()

        for (let i = 0; i < 10; i++) {
            expect((await resetPassword(app, first, player.id)).statusCode).toBe(200)
        }
        expect((await resetPassword(app, first, player.id)).statusCode).toBe(429)
        // A per-IP key would have put both admins in one bucket.
        expect((await resetPassword(app, second, player.id)).statusCode).toBe(200)
        await app.close()
    })
})

describe('POST /auth/change-password after a reset', () => {
    async function signInWithTemporaryPassword(app: FastifyInstance) {
        const admin = await seedStaff('ADMIN')
        const player = await seedPlayer()
        const { temporaryPassword } = (await resetPassword(app, admin, player.id)).json()
        const login = await app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: { identifier: player.username, password: temporaryPassword },
        })
        const { accessToken, refreshToken } = login.json()
        return { player, temporaryPassword, accessToken, refreshToken }
    }

    function changePassword(app: FastifyInstance, accessToken: string, body: Record<string, string>) {
        return app.inject({
            method: 'POST',
            url: '/auth/change-password',
            headers: { authorization: `Bearer ${accessToken}` },
            payload: body,
        })
    }

    it('clears mustChangePassword and keeps this device signed in on a fresh session', async () => {
        const app = await buildApp()
        const { player, temporaryPassword, accessToken, refreshToken } = await signInWithTemporaryPassword(app)

        const res = await changePassword(app, accessToken, {
            currentPassword: temporaryPassword,
            newPassword: 'chosen-by-player',
        })

        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.user.mustChangePassword).toBe(false)
        expect(body.user).not.toHaveProperty('passwordHash')
        expect(typeof body.accessToken).toBe('string')
        expect(typeof body.refreshToken).toBe('string')

        const row = await prisma.user.findUnique({ where: { id: player.id } })
        expect(row?.mustChangePassword).toBe(false)
        expect(row?.passwordHash).toBe('hashed:chosen-by-player')

        // The session that signed in with the temporary password is retired;
        // the one handed back by this call is the device's session now.
        const stale = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } })
        expect(stale.statusCode).toBe(401)
        const fresh = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            payload: { refreshToken: body.refreshToken },
        })
        expect(fresh.statusCode).toBe(200)
        expect(fresh.json().user.mustChangePassword).toBe(false)
        await app.close()
    })

    it('rejects a new password equal to the current one', async () => {
        const app = await buildApp()
        const { player, temporaryPassword, accessToken } = await signInWithTemporaryPassword(app)

        const res = await changePassword(app, accessToken, {
            currentPassword: temporaryPassword,
            newPassword: temporaryPassword,
        })

        expect(res.statusCode).toBe(400)
        expect(res.json().code).toBe('password_unchanged')
        const row = await prisma.user.findUnique({ where: { id: player.id } })
        expect(row?.passwordHash).toBe(`hashed:${temporaryPassword}`)
        expect(row?.mustChangePassword).toBe(true)
        await app.close()
    })

    it('rejects a wrong current password with 400, not a 500', async () => {
        const app = await buildApp()
        const { player, accessToken } = await signInWithTemporaryPassword(app)

        const res = await changePassword(app, accessToken, {
            currentPassword: 'not-the-password',
            newPassword: 'chosen-by-player',
        })

        expect(res.statusCode).toBe(400)
        expect(res.json().code).toBe('current_password_incorrect')
        const row = await prisma.user.findUnique({ where: { id: player.id } })
        expect(row?.mustChangePassword).toBe(true)
        await app.close()
    })
})
