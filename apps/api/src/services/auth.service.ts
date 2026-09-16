import prisma from '../lib/prisma'
import {
    LoginDto,
    RegisterDto,
    ChangePasswordDto,
    TelegramAuthDto,
    FirebasePhoneAuthDto,
    UserRole,
    phoneVariants,
} from '@world-bingo/shared-types'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { ReferralService } from './referral.service'
import { captureEvent } from '../lib/posthog'
import { personPropsFor } from '../lib/posthog-events'
import { wbAuthRefreshTotal } from '../lib/metrics'
import { FirebaseAuthError, verifyFirebaseIdToken } from '../lib/firebase'

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
 * Support reads a temporary password aloud over the phone, so the alphabet
 * drops every character that looks or sounds like another (0/O, 1/I/l) and
 * lowercase altogether, so nobody has to say "capital". 32 symbols over 8
 * characters is 40 bits: plenty for a password the login limiter throttles and
 * the player must replace at their next sign-in.
 */
export const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const TEMP_PASSWORD_LENGTH = 8

/**
 * A refusal the client can act on. `code` is what the web and admin apps key
 * their messages on. These used to be plain `Error`s, which the shared error
 * handler turned into 500s — a mistyped current password read as a server
 * fault.
 */
export class PasswordError extends Error {
    constructor(
        readonly statusCode: 400 | 403 | 404 | 409,
        readonly code:
            | 'user_not_found'
            | 'reset_not_allowed'
            | 'no_password_login'
            | 'password_not_set'
            | 'current_password_incorrect'
            | 'password_unchanged',
        message: string,
    ) {
        super(message)
        this.name = 'PasswordError'
    }
}

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

/**
 * Roles that may sign in with a password at /auth/admin/login, and the roles
 * `firebasePhoneAuth` refuses to reach by SMS.
 */
const STAFF_ROLES: string[] = [UserRole.CLERK, UserRole.ADMIN, UserRole.SUPER_ADMIN]

export function generateTemporaryPassword(): string {
    let password = ''
    for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
        // randomInt is uniform over the range; `randomBytes % n` would bias it.
        password += TEMP_PASSWORD_ALPHABET[crypto.randomInt(TEMP_PASSWORD_ALPHABET.length)]
    }
    return password
}

/** The two markers bot.service.ts writes — the same test lib/posthog.ts uses. */
function isBotAccount(user: { username: string | null; passwordHash: string | null }): boolean {
    return user.username?.startsWith('bot_t') === true || user.passwordHash === 'BOT_ACCOUNT'
}

export class AuthService {
    /**
     * Mints a refresh token that starts its own rotation chain. Every sign-in
     * path ends here, and each gets a fresh `familyId`: logging out of one
     * device must not end a session started by another.
     */
    private static async issueRefreshToken(userId: string): Promise<string> {
        const refreshToken = generateRefreshToken()
        const expiresAt = new Date()
        expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS)

        await prisma.refreshToken.create({
            data: {
                userId,
                tokenHash: hashToken(refreshToken),
                expiresAt,
                familyId: crypto.randomUUID(),
            },
        })

        return refreshToken
    }

    /** Username + phone + password sign-up, behind `POST /auth/register`. */
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

        const refreshToken = await AuthService.issueRefreshToken(user.id)

        void captureEvent(
            user.id,
            'user_registered',
            { signup_method: 'phone', referred: !!referredById },
            { set: personPropsFor(user, 'phone') },
        )

        const { passwordHash: _, ...result } = user
        return { user: result, refreshToken }
    }

    /**
     * Password sign-in, for players (`/auth/login`) and staff
     * (`/auth/admin/login`) alike. Players may also arrive by SMS
     * (`firebasePhoneAuth`) or Telegram; staff have only this.
     *
     * `roles`, which only the admin route passes, is checked BEFORE a refresh
     * token is minted: the controller used to mint one and then 403, leaving a
     * live 30-day token behind for an account it had just refused.
     */
    static async login(data: LoginDto, options: { roles?: string[] } = {}) {
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

        // Same message as a wrong password on purpose: which accounts are staff
        // is not something an anonymous caller gets to probe for.
        if (options.roles && !options.roles.includes(user.role)) {
            throw new Error('Invalid credentials')
        }

        const refreshToken = await AuthService.issueRefreshToken(user.id)

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

    /**
     * The signed-in user's current row, minus the hash. Not the token's own
     * claims: those are frozen when the token is issued and cannot carry a flag
     * such as `mustChangePassword` that changed afterwards.
     */
    static async me(userId: string) {
        const user = await prisma.user.findUnique({ where: { id: userId } })
        if (!user) throw new Error('User not found')
        const { passwordHash: _, ...result } = user
        return result
    }

    static async changePassword(userId: string, data: ChangePasswordDto) {
        const user = await prisma.user.findUnique({ where: { id: userId } })
        if (!user) throw new Error('User not found')

        if (!user.passwordHash) {
            throw new PasswordError(400, 'password_not_set', 'Password not set for this account')
        }

        const isValid = await bcrypt.compare(data.currentPassword, user.passwordHash)
        if (!isValid) {
            throw new PasswordError(400, 'current_password_incorrect', 'Current password is incorrect')
        }

        // `currentPassword` was just proven to match the stored hash, so a
        // string comparison is a comparison against the hash without a second
        // bcrypt round. Above all it stops a player "changing" a temporary
        // password to itself, which would clear the flag that forces a real one.
        if (data.newPassword === data.currentPassword) {
            throw new PasswordError(
                400,
                'password_unchanged',
                'New password must be different from the current password',
            )
        }

        const newPasswordHash = await bcrypt.hash(data.newPassword, 10)

        // Every existing session is revoked and this device gets a fresh one.
        // Without it the player who just chose a password is signed out again
        // as soon as their 15-minute access token lapses and the revoked
        // refresh token is refused.
        const refreshToken = generateRefreshToken()
        const expiresAt = new Date()
        expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS)

        const [updated] = await prisma.$transaction([
            prisma.user.update({
                where: { id: userId },
                data: { passwordHash: newPasswordHash, mustChangePassword: false },
            }),
            // Invalidate all refresh tokens on password change
            prisma.refreshToken.deleteMany({ where: { userId } }),
            prisma.refreshToken.create({
                data: { userId, tokenHash: hashToken(refreshToken), expiresAt, familyId: crypto.randomUUID() },
            }),
        ])

        const { passwordHash: _, ...result } = updated
        return { message: 'Password changed successfully', user: result, refreshToken }
    }

    /**
     * Support-assisted recovery. Replaces a player's password with a temporary
     * one that support reads out, signs the player out on every device, and
     * flags the account so the web app makes them choose their own at the next
     * sign-in. The reset time starts the withdrawal hold in
     * WalletService.requestWithdrawal.
     *
     * Authorising the actor is the route's job (admin and super-admin only —
     * see routes/admin/index.ts). The temporary password goes back to that
     * caller once and is never stored, logged or audited.
     */
    static async adminResetPassword(userId: string, actorId: string) {
        const target = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, role: true, username: true, phone: true, passwordHash: true },
        })
        if (!target) throw new PasswordError(404, 'user_not_found', 'User not found')

        // Players only. Resetting a staff password hands the account to whoever
        // issued it — an ADMIN resetting a SUPER_ADMIN would sign in as them —
        // and a bot is house-operated, not a person who can forget anything.
        if (target.role !== 'PLAYER' || isBotAccount(target)) {
            throw new PasswordError(403, 'reset_not_allowed', 'Only player accounts can have their password reset')
        }

        // Login finds the account by username or phone. A Telegram-only account
        // with neither could never use the password it was given.
        if (!target.username && !target.phone) {
            throw new PasswordError(
                409,
                'no_password_login',
                'This account has no username or phone number to sign in with',
            )
        }

        const temporaryPassword = generateTemporaryPassword()
        // Hashed before the transaction opens: bcrypt is deliberately slow and
        // must not run while the transaction holds the row.
        const passwordHash = await bcrypt.hash(temporaryPassword, 10)

        // The JWT carries only { id, role }; the trail should say who, too.
        const actorName = await prisma.user
            .findUnique({ where: { id: actorId }, select: { username: true } })
            .then((u) => u?.username ?? null)
            .catch(() => null)

        const revokedSessions = await prisma.$transaction(async (tx) => {
            // Re-asserts PLAYER in the write itself, so a role change landing
            // between the check above and this update cannot slip through.
            const { count: updated } = await tx.user.updateMany({
                where: { id: userId, role: 'PLAYER' },
                data: { passwordHash, mustChangePassword: true, passwordResetAt: new Date() },
            })
            if (updated === 0) {
                throw new PasswordError(403, 'reset_not_allowed', 'Only player accounts can have their password reset')
            }

            // The same revocation changePassword uses: every device, every family.
            const { count } = await tx.refreshToken.deleteMany({ where: { userId } })

            // Written inside the transaction, unlike the CRM helper's best-effort
            // audit: a reset that hands out account access must not happen
            // without leaving a trace.
            await tx.auditLog.create({
                data: {
                    action: 'user.password_reset',
                    actorId,
                    actorName,
                    target: `user:${userId}`,
                    detail: { revokedSessions: count },
                },
            })
            return count
        })

        void captureEvent(userId, 'password_reset_by_admin', { revoked_sessions: revokedSessions })

        return { temporaryPassword }
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
        const refreshToken = await AuthService.issueRefreshToken(user.id)

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

    /**
     * Firebase phone (SMS) sign-in — the only way a player reaches an account.
     *
     * The browser does the SMS round trip with Firebase and sends us the ID
     * token it ends up with; `verifyFirebaseIdToken` checks Google's signature
     * and this deployment's project id. The phone number is read from the
     * token's signed claims, never from the request body.
     *
     * Sign-up and sign-in are the same call on purpose: a player types a number
     * and a code, and whether an account already existed is our problem, not
     * theirs. `referralCode` is only honoured when an account is actually
     * created.
     */
    static async firebasePhoneAuth(data: FirebasePhoneAuthDto) {
        const claims = await verifyFirebaseIdToken(data.idToken)

        // A token minted by any other provider on the same Firebase project
        // (an anonymous session, say) verifies just fine — it is simply not a
        // proof that anyone controls a phone number, which is the whole point.
        if (claims.signInProvider !== 'phone') {
            throw new FirebaseAuthError(
                'firebase_token_invalid',
                'That sign-in method is not supported. Please verify your phone number.',
            )
        }
        if (!claims.phoneNumber) {
            throw new FirebaseAuthError(
                'firebase_token_invalid',
                'Sign-in token carries no verified phone number',
            )
        }

        const { user, created } = await AuthService.resolvePhoneUser(
            claims.uid,
            claims.phoneNumber,
            data.referralCode,
        )

        const refreshToken = await AuthService.issueRefreshToken(user.id)

        if (created) {
            void captureEvent(
                user.id,
                'user_registered',
                { signup_method: 'phone', referred: user.referredById !== null },
                { set: personPropsFor(user, 'phone') },
            )
        } else {
            void captureEvent(user.id, 'user_logged_in', { signup_method: 'phone' })
        }

        const { passwordHash: _, ...result } = user
        return { user: result, refreshToken }
    }

    /**
     * Drops a temporary password the player never used.
     *
     * Support verifies a player and issues one, setting `mustChangePassword`;
     * the web app then holds them on /set-password until they replace it — and
     * that page asks for the temporary password as the current one. A player
     * who never received it and signed in by SMS instead would land in that
     * loop with nothing to type, unable to reach the lobby at all.
     *
     * The SMS proves control of the number, which is what support verified
     * before issuing the password, so the pending credential has done its job
     * without ever being used: retire it, and the flag with it. Nothing weakens
     * — `passwordResetAt` is untouched, so WalletService still holds
     * withdrawals for 24h after the reset however the player got back in, and
     * the temporary password support read aloud stops working.
     *
     * A player whose own password still works keeps it: the flag is written
     * only by `adminResetPassword`.
     */
    private static async retirePendingTempPassword<T extends { id: string; mustChangePassword: boolean }>(
        user: T,
    ): Promise<T> {
        if (!user.mustChangePassword) return user

        const updated = await prisma.user.update({
            where: { id: user.id },
            data: { mustChangePassword: false, passwordHash: null },
        })
        return updated as unknown as T
    }

    /**
     * The account behind a verified phone number, creating one on first sight.
     *
     * Match order is `firebaseUid` first, then the phone number: the uid is
     * stable for a number within a brand's Firebase project, so once an account
     * is linked, support correcting the stored phone does not strand it.
     *
     * The phone match is an exact comparison against every spelling that number
     * could be stored under (`phoneVariants`) — accounts created before phone
     * sign-in hold whatever the player typed, from `0911234567` to
     * `+251911234567`. A `contains` match on the last digits would eventually
     * sign one player into another player's account.
     */
    private static async resolvePhoneUser(uid: string, phone: string, referralCode?: string) {
        const byUid = await prisma.user.findUnique({ where: { firebaseUid: uid } })
        if (byUid) return { user: await AuthService.retirePendingTempPassword(byUid), created: false }

        const variants = phoneVariants(phone)
        const byPhone = variants.length
            ? await prisma.user.findFirst({ where: { phone: { in: variants } } })
            : null

        if (byPhone) {
            // An SMS code is a single factor and a SIM is swappable, so it must
            // not be enough to reach a CLERK/ADMIN/SUPER_ADMIN account — those
            // keep the password path at /auth/admin/login.
            if (STAFF_ROLES.includes(byPhone.role)) {
                throw new FirebaseAuthError(
                    'firebase_token_invalid',
                    'This number belongs to a staff account. Please sign in from the admin dashboard.',
                    403,
                )
            }

            // Claim (or re-claim) the account for this uid. A different uid on
            // the row means the number was re-registered in Firebase — the SMS
            // just proved who holds the number now, and that is the stronger
            // claim of the two.
            const user = await prisma.user.update({
                where: { id: byPhone.id },
                data: { firebaseUid: uid },
            })
            return { user: await AuthService.retirePendingTempPassword(user), created: false }
        }

        let referredById: string | undefined
        if (referralCode) {
            const referrerId = await ReferralService.resolveCode(referralCode)
            if (referrerId) referredById = referrerId
        }

        try {
            const user = await prisma.user.create({
                data: {
                    // E.164, exactly as Firebase verified it. New accounts are
                    // all one shape; `phoneVariants` is what bridges to the
                    // older rows.
                    phone,
                    firebaseUid: uid,
                    referredById,
                    wallet: { create: { realBalance: 0 } },
                },
            })
            return { user, created: true }
        } catch (err) {
            // Two tabs finishing the same first sign-in at once: one wins the
            // unique index on firebaseUid/phone and the loser lands here. The
            // account exists and is the right one — hand it back rather than
            // failing a sign-in that actually succeeded.
            if ((err as { code?: string }).code !== 'P2002') throw err

            const existing = await prisma.user.findFirst({
                where: { OR: [{ firebaseUid: uid }, { phone: { in: variants } }] },
            })
            if (!existing) throw err
            return { user: existing, created: false }
        }
    }
}

