import { FastifyPluginAsync } from 'fastify'
import { LoginSchema, RegisterSchema } from '@world-bingo/shared-types'
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

    fastify.get('/me', {
        preValidation: [fastify.authenticate],
        handler: AuthController.me,
    })
}

export default authRoutes
