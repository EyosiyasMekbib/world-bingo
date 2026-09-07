import { createHash } from 'crypto'
import { FastifyPluginAsync } from 'fastify'
import { LoginSchema, RegisterSchema, RefreshTokenSchema, LogoutSchema, ChangePasswordSchema, TelegramAuthSchema } from '@world-bingo/shared-types'
import { AuthController } from '../../controllers'
import zodToJsonSchema from 'zod-to-json-schema'

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
                // every player on one 20/min budget, and a 429 here reads to the
                // client as a lost session.
                keyGenerator: (req: any) => {
                    const token = req.body?.refreshToken
                    return typeof token === 'string' && token.length > 0
                        ? `rt:${createHash('sha256').update(token).digest('hex')}`
                        : `ip:${(req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip}`
                },
            },
        },
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

