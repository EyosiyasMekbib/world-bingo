import prisma from '../lib/prisma'
import { LoginDto, RegisterDto, ChangePasswordDto, TelegramAuthDto } from '@world-bingo/shared-types'
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
                        realBalance: 0,
                    },
                },
            },
        })

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

        if (!user.passwordHash) {
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

        if (!user.passwordHash) throw new Error('Password not set for this account')

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

    static async telegramAuth(data: TelegramAuthDto) {
        // 1. Verify hash
        const { hash, ...fields } = data
        const dataCheckString = Object.entries(fields)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n')
        const secretKey = crypto.createHash('sha256')
            .update(process.env.TELEGRAM_BOT_TOKEN!)
            .digest()
        const expectedHash = crypto.createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex')
        if (expectedHash !== hash) throw new Error('Invalid Telegram auth data')

        // 2. Check freshness (300 seconds)
        if (Date.now() / 1000 - data.auth_date > 300) {
            throw new Error('Telegram auth data expired')
        }

        // 3. Upsert user
        const telegramId = String(data.id)

        // If phone_number provided, check it's not already taken by another account
        let phoneToSet: string | null | undefined = undefined
        if (data.phone_number) {
            const existing = await prisma.user.findUnique({ where: { phone: data.phone_number } })
            if (!existing || existing.telegramId === telegramId) {
                phoneToSet = data.phone_number
            }
        }

        const user = await prisma.user.upsert({
            where: { telegramId },
            update: {
                firstName: data.first_name,
                lastName: data.last_name ?? null,
                telegramUsername: data.username ?? null,
                photoUrl: data.photo_url ?? null,
                ...(phoneToSet !== undefined ? { phone: phoneToSet } : {}),
            },
            create: {
                telegramId,
                firstName: data.first_name,
                lastName: data.last_name ?? null,
                telegramUsername: data.username ?? null,
                photoUrl: data.photo_url ?? null,
                phone: phoneToSet ?? null,
                wallet: { create: { realBalance: 0 } },
            },
        })

        // 4. Issue refresh token (same pattern as login())
        const refreshToken = generateRefreshToken()
        const tokenHash = hashToken(refreshToken)
        const expiresAt = new Date()
        expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS)
        await prisma.refreshToken.create({ data: { userId: user.id, tokenHash, expiresAt } })

        const { passwordHash: _, ...result } = user
        return { user: result, refreshToken }
    }
}

