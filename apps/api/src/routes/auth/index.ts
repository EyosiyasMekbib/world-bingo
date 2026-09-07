import { createHash } from 'crypto'
import { FastifyPluginAsync } from 'fastify'
import { LoginSchema, RegisterSchema, RefreshTokenSchema, LogoutSchema, ChangePasswordSchema, TelegramAuthSchema } from '@world-bingo/shared-types'
import { AuthController } from '../../controllers'
import zodToJsonSchema from 'zod-to-json-schema'
import { rateLimitKey } from '../../lib/rate-limit-key'

const authRoutes: FastifyPluginAsync = async (fastify) => {
    // Strict rate limit for auth endpoints to prevent brute-force
    fastify.post('/register', {
        config: {
            rateLimit: {
                max: 5,
                timeWindow: '1 minute',
            },
        },
        schema: {
            body: zodToJsonSchema(RegisterSchema),
        },
        handler: AuthController.register,
    })

    fastify.post('/login', {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: '1 minute',
            },
        },
        schema: {
            body: zodToJsonSchema(LoginSchema),
        },
        handler: AuthController.login,
    })

    fastify.post('/admin/login', {
        config: {
            rateLimit: {
                max: 5,
                timeWindow: '1 minute',
            },
        },
        schema: {
            body: zodToJsonSchema(LoginSchema),
        },
        handler: AuthController.adminLogin,
    })

    fastify.post('/refresh', {
        config: {
            rateLimit: {
                max: 20,
                timeWindow: '1 minute',
                // @fastify/rate-limit's default hook is 'onRequest', which runs
                // before Fastify parses the body — req.body would always be
                // undefined there and this keyGenerator would silently fall back
                // to `ip:...` for every request. Move just this route's rate
                // limit to 'preValidation' (after parsing, before the schema
                // check) so it can actually key on the token. This does not
                // touch the global limiter's hook phase.
                hook: 'preValidation',
                // Per device, not per IP: a shared carrier address must not put
                // every player on one 20/min budget. A 429 here used to read to
                // the client as a lost session, but the web store now treats
                // 429 as transient and keeps the session — so this budget only
                // needs to protect the device, not avoid ever being hit.
                keyGenerator: (req: any) => {
                    const token = req.body?.refreshToken
                    return typeof token === 'string' && token.length > 0
                        ? `rt:${createHash('sha256').update(token).digest('hex')}`
                        : `ip:${(req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip}`
                },
            },
        },
        // A route carrying its own `config.rateLimit` gets ONLY that hook —
        // @fastify/rate-limit's `onRoute` listener adds the global limiter's
        // hook exclusively in its `else if (globalParams.global)` branch,
        // which never runs once `routeOptions.config.rateLimit` is set (see
        // node_modules/.pnpm/@fastify+rate-limit@10.3.0/node_modules/@fastify/rate-limit/index.js).
        // So the per-token budget above is this route's ENTIRE defence: an
        // attacker who mints a fresh random token on every request lands in a
        // brand-new bucket each time and is never throttled by it, and every
        // such request still costs a SHA-256 plus an indexed lookup.
        // `fastify.rateLimit(...)` is a decorator the plugin adds for exactly
        // this — building an independent limiter (its own store, so it can't
        // collide with the token budget's buckets) that we attach as a plain
        // `onRequest` hook ourselves. 120/min per IP sits well above real
        // usage (a player refreshes roughly every 13 minutes, and several
        // tabs share one refresh) so it only bites abuse, and it's cheap to
        // restore now that a 429 no longer costs the player their session.
        onRequest: fastify.rateLimit({
            max: 120,
            timeWindow: '1 minute',
            keyGenerator: (req: any) =>
                rateLimitKey({
                    userId: null,
                    forwardedFor: req.headers['x-forwarded-for'] as string | undefined,
                    ip: req.ip,
                }),
        }),
        schema: {
            body: zodToJsonSchema(RefreshTokenSchema),
        },
        handler: AuthController.refresh,
    })

    fastify.post('/logout', {
        schema: {
            body: zodToJsonSchema(LogoutSchema),
        },
        handler: AuthController.logout,
    })

    fastify.get('/me', {
        preValidation: [fastify.authenticate],
        handler: AuthController.me,
    })

    fastify.post('/change-password', {
        preValidation: [fastify.authenticate],
        config: {
            rateLimit: {
                max: 5,
                timeWindow: '1 minute',
            },
        },
        schema: {
            body: zodToJsonSchema(ChangePasswordSchema),
        },
        handler: AuthController.changePassword,
    })

    fastify.post('/telegram', {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: '1 minute',
            },
        },
        schema: {
            body: zodToJsonSchema(TelegramAuthSchema),
        },
        handler: AuthController.telegramLogin,
    })
}

export default authRoutes

