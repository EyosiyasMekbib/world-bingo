import { FastifyPluginAsync } from 'fastify'
import { LoginSchema, RegisterSchema } from '@world-bingo/shared-types'
import { AuthController } from '../../controllers'
import zodToJsonSchema from 'zod-to-json-schema'

const authRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post('/register', {
        schema: {
            body: zodToJsonSchema(RegisterSchema),
        },
        handler: AuthController.register,
    })

    fastify.post('/login', {
        schema: {
            body: zodToJsonSchema(LoginSchema),
        },
        handler: AuthController.login,
    })

    fastify.get('/me', {
        preValidation: [fastify.authenticate],
        handler: AuthController.me,
    })
}

export default authRoutes
