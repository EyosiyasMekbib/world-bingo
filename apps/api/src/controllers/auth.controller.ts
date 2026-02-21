import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthService } from '../services'
import { LoginDto, RegisterDto } from '@world-bingo/shared-types'

export class AuthController {
    static async register(request: FastifyRequest<{ Body: RegisterDto }>, reply: FastifyReply) {
        const user = await AuthService.register(request.body)
        const token = await reply.jwtSign({ id: user.id, role: user.role })
        return { user, token }
    }

    static async login(request: FastifyRequest<{ Body: LoginDto }>, reply: FastifyReply) {
        const user = await AuthService.login(request.body)
        const token = await reply.jwtSign({ id: user.id, role: user.role })
        return { user, token }
    }

    static async adminLogin(request: FastifyRequest<{ Body: LoginDto }>, reply: FastifyReply) {
        const user = await AuthService.login(request.body)
        if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
            reply.status(403).send({ error: 'Not an admin' })
            return
        }
        const token = await reply.jwtSign({ id: user.id, role: user.role })
        return { user, token }
    }

    static async me(request: FastifyRequest, reply: FastifyReply) {
        return request.user
    }
}
