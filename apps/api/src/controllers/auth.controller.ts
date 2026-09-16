import { STATUS_CODES } from 'http'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthService } from '../services'
import { PasswordError } from '../services/auth.service'
import type {
    LoginDto,
    RegisterDto,
    RefreshTokenDto,
    LogoutDto,
    ChangePasswordDto,
    TelegramAuthDto,
    FirebasePhoneAuthDto,
} from '@world-bingo/shared-types'
import { UserRole } from '@world-bingo/shared-types'

export class AuthController {
    static async register(request: FastifyRequest<{ Body: RegisterDto }>, reply: FastifyReply) {
        const { user, refreshToken } = await AuthService.register(request.body)
        const accessToken = await reply.jwtSign(
            { id: user.id, role: user.role },
            { expiresIn: '15m' }
        )
        return { user, accessToken, refreshToken }
    }

    /**
     * Username/phone + password. One of three ways a player signs in, beside
     * `firebasePhone` (SMS) and `telegramLogin` — and the one support's
     * password reset hands a player back to.
     */
    static async login(request: FastifyRequest<{ Body: LoginDto }>, reply: FastifyReply) {
        const { user, refreshToken } = await AuthService.login(request.body)
        const accessToken = await reply.jwtSign(
            { id: user.id, role: user.role },
            { expiresIn: '15m' }
        )
        return { user, accessToken, refreshToken }
    }

    /**
     * The staff door. The role check lives in the service so it runs BEFORE a
     * refresh token is minted — this used to issue a live 30-day token and then
     * 403, leaving the refused account with a working session credential.
     */
    static async adminLogin(request: FastifyRequest<{ Body: LoginDto }>, reply: FastifyReply) {
        const { user, refreshToken } = await AuthService.login(request.body, {
            roles: [UserRole.CLERK, UserRole.ADMIN, UserRole.SUPER_ADMIN],
        })
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
        // @ts-ignore
        return AuthService.me(request.user.id)
    }

    static async changePassword(request: FastifyRequest<{ Body: ChangePasswordDto }>, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        try {
            const { message, user, refreshToken } = await AuthService.changePassword(userId, request.body)
            const accessToken = await reply.jwtSign(
                { id: user.id, role: user.role },
                { expiresIn: '15m' }
            )
            return { message, user, accessToken, refreshToken }
        } catch (err) {
            if (err instanceof PasswordError) {
                return reply.status(err.statusCode).send({
                    statusCode: err.statusCode,
                    error: STATUS_CODES[err.statusCode],
                    message: err.message,
                    code: err.code,
                })
            }
            throw err
        }
    }

    /**
     * Firebase phone sign-in. Signs the player in, creating the account on
     * first use — the client cannot tell the two apart and does not need to.
     *
     * Refusals are left to the shared error handler so the client keeps the
     * distinction between "this token is no good" (401, verify again) and
     * "this server cannot check tokens right now" (503, retry).
     */
    static async firebasePhone(request: FastifyRequest<{ Body: FirebasePhoneAuthDto }>, reply: FastifyReply) {
        const { user, refreshToken } = await AuthService.firebasePhoneAuth(request.body)
        const accessToken = await reply.jwtSign(
            { id: user.id, role: user.role },
            { expiresIn: '15m' }
        )
        return { user, accessToken, refreshToken }
    }

    static async telegramLogin(request: FastifyRequest<{ Body: TelegramAuthDto }>, reply: FastifyReply) {
        try {
            const { user, refreshToken } = await AuthService.telegramAuth(request.body)
            const accessToken = await reply.jwtSign(
                { id: user.id, role: user.role },
                { expiresIn: '15m' }
            )
            return { user, accessToken, refreshToken }
        } catch (err: any) {
            reply.status(401).send({ message: err.message ?? 'Telegram authentication failed' })
        }
    }
}


