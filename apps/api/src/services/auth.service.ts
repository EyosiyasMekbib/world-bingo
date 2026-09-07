import prisma from '../lib/prisma'
import { LoginDto, RegisterDto, ChangePasswordDto, TelegramAuthDto } from '@world-bingo/shared-types'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { ReferralService } from './referral.service'
import { captureEvent } from '../lib/posthog'
import { personPropsFor } from '../lib/posthog-events'
import { wbAuthRefreshTotal } from '../lib/metrics'

const REFRESH_TOKEN_EXPIRY_DAYS = 30

/**
 * How long a rotated refresh token keeps working. The web app fires several
 * authenticated calls at once (the lobby loads bingo and provider games in
 * parallel); when the 15-minute access token expires they all 401 together and
 * each one refreshes with the same stored token. Without this window exactly
 * one of them won and every other caller was logged out — 64 of 194 refreshes
 * in one 4-hour production sample, plus 4 crashes from the delete/create race.
 *
 * A minute is long enough to cover that burst and a slow mobile round trip, and
 * short enough that a genuinely stolen token is useless.
 */
export const REFRESH_GRACE_MS = 60_000

/** Rotated rows are pruned once they are this old — long past any live burst. */
const REFRESH_PRUNE_MS = 5 * 60_000

/**
 * A refusal the client can act on. `code` is what the web store keys its
 * "really log out" decision on: anything else (network, 429, 5xx) must leave
 * the session alone.
 */
export class RefreshTokenError extends Error {
    readonly statusCode = 401
    constructor(readonly code: 'refresh_token_invalid' | 'refresh_token_expired', message: string) {
        super(message)
        this.name = 'RefreshTokenError'
    }
}

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
                // Starts this device's own rotation chain — see logout()'s
                // family-wide revoke and refreshToken()'s propagation below.
                familyId: crypto.randomUUID(),
            },
        })

        void captureEvent(
            user.id,
            'user_registered',
            { signup_method: 'phone', referred: !!referredById },
            { set: personPropsFor(user, 'phone') },
        )

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
                // Starts this device's own rotation chain — a logout on this
                // login must not touch a session started by a different login.
                familyId: crypto.randomUUID(),
            },
        })

        void captureEvent(user.id, 'user_logged_in', {
            signup_method: user.telegramId ? 'telegram' : 'phone',
        })

        const { passwordHash: _, ...result } = user
        return { user: result, refreshToken }
    }

    /**
     * Wraps the actual refresh logic so any failure that is NOT a deliberate
     * `RefreshTokenError` (a DB error on the `create`, say) still moves the
     * `error` counter — otherwise that class of failure vanishes from the
     * metric meant to prove it doesn't happen. `RefreshTokenError` already
     * labels itself (invalid/expired/grace/rotated below) and must not also
     * be counted here.
     */
    static async refreshToken(token: string) {
        try {
            return await AuthService.rotateRefreshToken(token)
        } catch (err) {
            if (err instanceof RefreshTokenError) throw err
            wbAuthRefreshTotal.labels('error').inc()
            throw err
        }
    }

    private static async rotateRefreshToken(token: string) {
        const tokenHash = hashToken(token)

        const storedToken = await prisma.refreshToken.findUnique({
            where: { tokenHash },
            include: { user: true },
        })

        if (!storedToken) {
            wbAuthRefreshTotal.labels('invalid').inc()
            throw new RefreshTokenError('refresh_token_invalid', 'Invalid refresh token')
        }

        if (storedToken.expiresAt < new Date()) {
            await prisma.refreshToken.deleteMany({ where: { tokenHash } })
            wbAuthRefreshTotal.labels('expired').inc()
            throw new RefreshTokenError('refresh_token_expired', 'Refresh token expired')
        }

        // Every token this chain produces from here on — the rotation winner
        // and any grace-window siblings alike — shares this family, so
        // logout() can revoke the whole chain in one delete. A row created
        // before this column existed has no familyId of its own; treat it as
        // a one-row family of itself rather than leaving new siblings
        // unlinked from it.
        const familyId = storedToken.familyId ?? storedToken.id

        const newRefreshToken = generateRefreshToken()
        const newTokenHash = hashToken(newRefreshToken)
        const newExpiresAt = new Date()
        newExpiresAt.setDate(newExpiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS)

        // Claim the rotation. `rotatedAt: null` in the WHERE makes this atomic:
        // concurrent callers serialize on the row and exactly one gets count 1.
        // The loser is NOT an error — see the grace branch below.
        const claim = await prisma.refreshToken.updateMany({
            where: { tokenHash, rotatedAt: null },
            data: { rotatedAt: new Date(), replacedByHash: newTokenHash },
        })

        if (claim.count === 0) {
            // We lost the race: another caller already claimed this token.
            // `storedToken` is a pre-claim snapshot — re-read so the grace
            // check sees the rotatedAt the winner just set, not a stale null.
            const current = await prisma.refreshToken.findUnique({ where: { tokenHash } })
            const rotatedAt = current?.rotatedAt ?? new Date(0)
            if (!current || Date.now() - rotatedAt.getTime() > REFRESH_GRACE_MS) {
                wbAuthRefreshTotal.labels('invalid').inc()
                throw new RefreshTokenError('refresh_token_invalid', 'Invalid refresh token')
            }
            wbAuthRefreshTotal.labels('grace').inc()
        } else {
            wbAuthRefreshTotal.labels('rotated').inc()
        }

        await prisma.refreshToken.create({
            data: { userId: storedToken.userId, tokenHash: newTokenHash, expiresAt: newExpiresAt, familyId },
        })

        // Housekeeping, not correctness: prunes rotated tokens older than the
        // grace window (5 minutes). During a concurrent burst, multiple unrotated
        // rows may temporarily coexist; this cleanup removes old rotated ones.
        // Never blocks the response.
        prisma.refreshToken
            .deleteMany({
                where: {
                    userId: storedToken.userId,
                    rotatedAt: { lt: new Date(Date.now() - REFRESH_PRUNE_MS) },
                },
            })
            .catch(() => {})

        const { passwordHash: _, ...user } = storedToken.user
        return { user, refreshToken: newRefreshToken }
    }

    static async logout(token: string) {
        const tokenHash = hashToken(token)
        const storedToken = await prisma.refreshToken.findUnique({ where: { tokenHash } })
        if (!storedToken) return

        // Revoke the whole device chain, not just the presented hash — a
        // sibling minted seconds earlier during a grace-window burst (see
        // rotateRefreshToken above) is otherwise still valid for up to 30
        // days after the player logs out. A null familyId (a row from before
        // that column existed) falls back to the old single-hash behaviour.
        if (storedToken.familyId) {
            await prisma.refreshToken.deleteMany({
                where: { userId: storedToken.userId, familyId: storedToken.familyId },
            })
        } else {
            await prisma.refreshToken.deleteMany({ where: { tokenHash } })
        }
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
        const botToken = process.env.TELEGRAM_BOT_TOKEN
        if (!botToken) throw new Error('Telegram login is not configured on this server')
        const secretKey = crypto.createHash('sha256')
            .update(botToken)
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
        // Read before the upsert: it is the only way to tell a first login
        // (user_registered) from a returning one (user_logged_in).
        const existed = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } })

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
        // Starts this device's own rotation chain — see login()'s comment.
        await prisma.refreshToken.create({ data: { userId: user.id, tokenHash, expiresAt, familyId: crypto.randomUUID() } })

        if (existed) {
            void captureEvent(user.id, 'user_logged_in', { signup_method: 'telegram' })
        } else {
            void captureEvent(
                user.id,
                'user_registered',
                { signup_method: 'telegram', referred: false },
                { set: personPropsFor(user, 'telegram') },
            )
        }

        const { passwordHash: _, ...result } = user
        return { user: result, refreshToken }
    }
}

