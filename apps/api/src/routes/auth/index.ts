import { FastifyPluginAsync } from 'fastify'
import { LoginSchema, RegisterSchema } from '@world-bingo/shared-types'
import { AuthController } from '../../controllers'

const authRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post('/register', {
        schema: {
            body: RegisterSchema,
        },
        handler: AuthController.register,
    })

    fastify.post('/login', {
        schema: {
            body: LoginSchema,
        },
        handler: AuthController.login,
    })

    fastify.get('/me', {
        preValidation: [fastify.authenticate],
        handler: AuthController.me,
    })
}

export default authRoutes
