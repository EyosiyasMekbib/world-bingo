import prisma from '../lib/prisma'
import { LoginDto, RegisterDto, ChangePasswordDto } from '@world-bingo/shared-types'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { ReferralService } from './referral.service'

const REFRESH_TOKEN_EXPIRY_DAYS = 30

function generateRefreshToken(): string {
    return crypto.randomBytes(64).toString('hex')
}

function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex')
}

export class AuthService {
    static async register(data: RegisterDto) {
        const existingUser = await prisma.user.findFirst({
            where: {
                OR: [{ username: data.username }, { phone: data.phone }],
            },
        })

        if (existingUser) {
            throw new Error('User already exists')
        }

        const passwordHash = await bcrypt.hash(data.password, 10)

        // Resolve referral code → referrer ID (if provided)
        let referredById: string | undefined
        if (data.referralCode) {
            const referrerId = await ReferralService.resolveCode(data.referralCode)
            if (referrerId) referredById = referrerId
        }

        const user = await prisma.user.create({
            data: {
                username: data.username,
                phone: data.phone,
                passwordHash,
                referredById,
                wallet: {
                    create: {
                        balance: 0,
                    },
                },
            },
        })

        const { passwordHash: _, ...result } = user
        return result
    }

    static async login(data: LoginDto) {
        // Support login by username OR phone
        const user = await prisma.user.findFirst({
            where: {
                OR: [
                    { phone: data.identifier },
                    { username: data.identifier },
                ],
            },
        })

        if (!user) {
            throw new Error('Invalid credentials')
        }

        const isValid = await bcrypt.compare(data.password, user.passwordHash)

        if (!isValid) {
            throw new Error('Invalid credentials')
        }

        const refreshToken = generateRefreshToken()
        const tokenHash = hashToken(refreshToken)
        const expiresAt = new Date()
        expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS)

        await prisma.refreshToken.create({
            data: {
                userId: user.id,
                tokenHash,
                expiresAt,
            },
        })

        const { passwordHash: _, ...result } = user
        return { user: result, refreshToken }
    }

    static async refreshToken(token: string) {
        const tokenHash = hashToken(token)

        const storedToken = await prisma.refreshToken.findUnique({
            where: { tokenHash },
            include: { user: true },
        })

        if (!storedToken) {
            throw new Error('Invalid refresh token')
        }

        if (storedToken.expiresAt < new Date()) {
            // Clean up expired token
            await prisma.refreshToken.delete({ where: { tokenHash } })
            throw new Error('Refresh token expired')
        }

        // Rotate: delete old token, issue new one
        const newRefreshToken = generateRefreshToken()
        const newTokenHash = hashToken(newRefreshToken)
        const newExpiresAt = new Date()
        newExpiresAt.setDate(newExpiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS)

        await prisma.$transaction([
            prisma.refreshToken.delete({ where: { tokenHash } }),
            prisma.refreshToken.create({
                data: {
                    userId: storedToken.userId,
                    tokenHash: newTokenHash,
                    expiresAt: newExpiresAt,
                },
            }),
        ])

        const { passwordHash: _, ...user } = storedToken.user
        return { user, refreshToken: newRefreshToken }
    }

    static async logout(token: string) {
        const tokenHash = hashToken(token)
        await prisma.refreshToken.deleteMany({ where: { tokenHash } })
    }

    static async changePassword(userId: string, data: ChangePasswordDto) {
        const user = await prisma.user.findUnique({ where: { id: userId } })
        if (!user) throw new Error('User not found')

        const isValid = await bcrypt.compare(data.currentPassword, user.passwordHash)
        if (!isValid) throw new Error('Current password is incorrect')

        const newPasswordHash = await bcrypt.hash(data.newPassword, 10)

        await prisma.$transaction([
            prisma.user.update({
                where: { id: userId },
                data: { passwordHash: newPasswordHash },
            }),
            // Invalidate all refresh tokens on password change
            prisma.refreshToken.deleteMany({ where: { userId } }),
        ])

        return { message: 'Password changed successfully' }
    }
}

