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

