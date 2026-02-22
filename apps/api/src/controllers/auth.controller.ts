import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthService } from '../services'
import type { LoginDto, RegisterDto, RefreshTokenDto, LogoutDto, ChangePasswordDto } from '@world-bingo/shared-types'

export class AuthController {
    static async register(request: FastifyRequest<{ Body: RegisterDto }>, reply: FastifyReply) {
        const user = await AuthService.register(request.body)
        // After register, automatically sign an access token (no refresh token on first register;
        // client must call /auth/login to get a refresh token)
        const accessToken = await reply.jwtSign(
            { id: user.id, role: user.role },
            { expiresIn: '15m' }
        )
        return { user, accessToken }
    }

    static async login(request: FastifyRequest<{ Body: LoginDto }>, reply: FastifyReply) {
        const { user, refreshToken } = await AuthService.login(request.body)
        const accessToken = await reply.jwtSign(
            { id: user.id, role: user.role },
            { expiresIn: '15m' }
        )
        return { user, accessToken, refreshToken }
    }

    static async adminLogin(request: FastifyRequest<{ Body: LoginDto }>, reply: FastifyReply) {
        const { user, refreshToken } = await AuthService.login(request.body)
        if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
            reply.status(403).send({ error: 'Not an admin' })
            return
        }
        const accessToken = await reply.jwtSign(
            { id: user.id, role: user.role },
            { expiresIn: '15m' }
        )
        return { user, accessToken, refreshToken }
    }

    static async refresh(request: FastifyRequest<{ Body: RefreshTokenDto }>, reply: FastifyReply) {
        const { user, refreshToken } = await AuthService.refreshToken(request.body.refreshToken)
        const accessToken = await reply.jwtSign(
            { id: user.id, role: user.role },
            { expiresIn: '15m' }
        )
        return { user, accessToken, refreshToken }
    }

    static async logout(request: FastifyRequest<{ Body: LogoutDto }>, reply: FastifyReply) {
        await AuthService.logout(request.body.refreshToken)
        return { message: 'Logged out successfully' }
    }

    static async me(request: FastifyRequest, reply: FastifyReply) {
        return request.user
    }

    static async changePassword(request: FastifyRequest<{ Body: ChangePasswordDto }>, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const result = await AuthService.changePassword(userId, request.body)
        return result
    }
}


