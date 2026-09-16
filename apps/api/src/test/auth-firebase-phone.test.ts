import { describe, it, expect, beforeEach, vi } from 'vitest'
import { UserRole } from '@world-bingo/shared-types'
import { prisma } from './setup'
import { FirebaseAuthError } from '../lib/firebase'
import { AuthService } from '../services/auth.service'
import { verifyFirebaseIdToken } from '../lib/firebase'

/**
 * Phone sign-in, from the token's claims down to the row it lands on.
 *
 * Token verification itself is covered in firebase-token.test.ts against a real
 * signature; here it is stubbed, because what these tests are about is the part
 * that decides WHICH account a verified number belongs to. That decision is the
 * one with teeth: matching too loosely hands a player someone else's account
 * and wallet, matching too tightly silently gives a returning player a second,
 * empty one.
 */
vi.mock('../lib/firebase', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/firebase')>()
    return { ...actual, verifyFirebaseIdToken: vi.fn() }
})

const verifyMock = vi.mocked(verifyFirebaseIdToken)

/** The claims a real Firebase phone token carries, with the parts we read. */
function claims(overrides: Partial<Awaited<ReturnType<typeof verifyFirebaseIdToken>>> = {}) {
    return {
        uid: 'firebase-uid-1',
        phoneNumber: '+251911234567',
        signInProvider: 'phone',
        authTime: Math.floor(Date.now() / 1000),
        ...overrides,
    }
}

describe('AuthService.firebasePhoneAuth', () => {
    beforeEach(() => {
        verifyMock.mockReset()
        verifyMock.mockResolvedValue(claims())
    })

    describe('first sign-in', () => {
        it('creates the account, its wallet and a refresh token', async () => {
            const { user, refreshToken } = await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            expect(user.phone).toBe('+251911234567')
            expect(user.firebaseUid).toBe('firebase-uid-1')
            expect(user.role).toBe(UserRole.PLAYER)
            expect('passwordHash' in user).toBe(false)

            const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
            expect(wallet?.realBalance.toString()).toBe('0')

            const stored = await prisma.refreshToken.findFirst({ where: { userId: user.id } })
            expect(stored).toBeTruthy()
            // Hashed at rest, and its own rotation chain — same as every other
            // sign-in path.
            expect(stored?.tokenHash).not.toBe(refreshToken)
            expect(stored?.familyId).toBeTruthy()
        })

        it('leaves the account without a password', async () => {
            const { user } = await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            const row = await prisma.user.findUnique({ where: { id: user.id } })
            expect(row?.passwordHash).toBeNull()
        })

        it('applies a referral code', async () => {
            const referrer = await prisma.user.create({
                data: { username: 'referrer', referralCode: 'REF123', wallet: { create: {} } },
            })

            const { user } = await AuthService.firebasePhoneAuth({ idToken: 'tok', referralCode: 'REF123' })

            expect(user.referredById).toBe(referrer.id)
        })

        it('ignores a referral code that resolves to nothing', async () => {
            const { user } = await AuthService.firebasePhoneAuth({ idToken: 'tok', referralCode: 'NOSUCH' })

            expect(user.referredById).toBeNull()
        })
    })

    describe('returning player', () => {
        it('signs in to the same account, without creating a second one', async () => {
            const first = await AuthService.firebasePhoneAuth({ idToken: 'tok' })
            const second = await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            expect(second.user.id).toBe(first.user.id)
            expect(await prisma.user.count()).toBe(1)
        })

        it('does not re-apply a referral code on a later sign-in', async () => {
            const referrer = await prisma.user.create({
                data: { username: 'referrer', referralCode: 'REF123', wallet: { create: {} } },
            })
            const { user } = await AuthService.firebasePhoneAuth({ idToken: 'tok' })
            expect(user.referredById).toBeNull()

            const again = await AuthService.firebasePhoneAuth({ idToken: 'tok', referralCode: 'REF123' })

            expect(again.user.id).toBe(user.id)
            expect(again.user.referredById).toBeNull()
            expect(referrer.id).toBeTruthy()
        })

        // The uid is matched before the number, so support correcting a phone
        // must not strand the account behind it.
        it('follows the firebase uid even after the stored phone changes', async () => {
            const { user } = await AuthService.firebasePhoneAuth({ idToken: 'tok' })
            await prisma.user.update({ where: { id: user.id }, data: { phone: '+251911000000' } })

            const again = await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            expect(again.user.id).toBe(user.id)
            expect(again.user.phone).toBe('+251911000000')
        })
    })

    // Accounts that predate phone sign-in hold whatever the player typed at
    // registration. Every one of these spellings is the same subscriber as the
    // E.164 number Firebase verified, and must reach the same wallet.
    describe('accounts created before phone sign-in', () => {
        it.each([
            ['local, trunk-prefixed', '0911234567'],
            ['bare national', '911234567'],
            ['international, no plus', '251911234567'],
            ['E.164', '+251911234567'],
        ])('links an account stored as %s', async (_label, storedPhone) => {
            const existing = await prisma.user.create({
                data: {
                    username: 'legacy',
                    phone: storedPhone,
                    passwordHash: 'legacy-hash',
                    wallet: { create: { realBalance: 250 } },
                },
            })

            const { user } = await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            expect(user.id).toBe(existing.id)
            expect(user.firebaseUid).toBe('firebase-uid-1')
            expect(await prisma.user.count()).toBe(1)

            // The player's money is the point of linking rather than creating.
            const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
            expect(wallet?.realBalance.toString()).toBe('250')
        })

        it('leaves a different number alone', async () => {
            const other = await prisma.user.create({
                data: { username: 'other', phone: '0911234568', wallet: { create: { realBalance: 999 } } },
            })

            const { user } = await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            expect(user.id).not.toBe(other.id)
            expect(await prisma.user.count()).toBe(2)
        })

        // Deleting and recreating a number in the Firebase console mints a new
        // uid for the same subscriber. The SMS just proved who holds the number
        // now, which is the stronger claim of the two.
        it('re-links when the number comes back under a new firebase uid', async () => {
            const { user } = await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            verifyMock.mockResolvedValue(claims({ uid: 'firebase-uid-2' }))
            const again = await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            expect(again.user.id).toBe(user.id)
            expect(again.user.firebaseUid).toBe('firebase-uid-2')
            expect(await prisma.user.count()).toBe(1)
        })
    })

    // Support issues a temporary password and the web app then holds the player
    // on /set-password, which asks for that password as the current one. A
    // player who signs in by SMS instead has nothing to type there, so the
    // unused credential is retired rather than left to trap them.
    describe('a pending support password reset', () => {
        async function playerWithTempPassword(phone = '+251911234567') {
            return prisma.user.create({
                data: {
                    username: 'reset-me',
                    phone,
                    passwordHash: 'temp-hash',
                    mustChangePassword: true,
                    passwordResetAt: new Date(),
                    wallet: { create: {} },
                },
            })
        }

        it('clears the flag and the unused temporary password', async () => {
            const existing = await playerWithTempPassword()

            const { user } = await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            expect(user.id).toBe(existing.id)
            expect(user.mustChangePassword).toBe(false)
            const row = await prisma.user.findUnique({ where: { id: existing.id } })
            expect(row?.passwordHash).toBeNull()
        })

        // The 24h hold is keyed on passwordResetAt, not on the flag, so getting
        // back in by SMS must not shorten it.
        it('leaves passwordResetAt alone, so the withdrawal hold still applies', async () => {
            const existing = await playerWithTempPassword()

            await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            const row = await prisma.user.findUnique({ where: { id: existing.id } })
            expect(row?.passwordResetAt).toEqual(existing.passwordResetAt)
        })

        it('also clears it on a later sign-in, once the account is already linked', async () => {
            const { user } = await AuthService.firebasePhoneAuth({ idToken: 'tok' })
            await prisma.user.update({
                where: { id: user.id },
                data: { passwordHash: 'temp-hash', mustChangePassword: true, passwordResetAt: new Date() },
            })

            const again = await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            expect(again.user.id).toBe(user.id)
            expect(again.user.mustChangePassword).toBe(false)
        })

        it('leaves a password the player still uses alone', async () => {
            const existing = await prisma.user.create({
                data: {
                    username: 'has-password',
                    phone: '+251911234567',
                    passwordHash: 'real-hash',
                    wallet: { create: {} },
                },
            })

            await AuthService.firebasePhoneAuth({ idToken: 'tok' })

            const row = await prisma.user.findUnique({ where: { id: existing.id } })
            expect(row?.passwordHash).toBe('real-hash')
        })
    })

    describe('refusals', () => {
        // An SMS code is one factor and a SIM is swappable. Staff keep the
        // password path at /auth/admin/login.
        it.each([UserRole.CLERK, UserRole.ADMIN, UserRole.SUPER_ADMIN])(
            'refuses to sign in to a %s account',
            async (role) => {
                const staff = await prisma.user.create({
                    data: { username: `staff-${role}`, phone: '0911234567', role, passwordHash: 'hash' },
                })

                await expect(AuthService.firebasePhoneAuth({ idToken: 'tok' })).rejects.toBeInstanceOf(
                    FirebaseAuthError,
                )

                const row = await prisma.user.findUnique({ where: { id: staff.id } })
                expect(row?.firebaseUid).toBeNull()
                expect(await prisma.refreshToken.count()).toBe(0)
            },
        )

        it('refuses a token that is not a phone sign-in', async () => {
            verifyMock.mockResolvedValue(claims({ signInProvider: 'anonymous' }))

            await expect(AuthService.firebasePhoneAuth({ idToken: 'tok' })).rejects.toBeInstanceOf(
                FirebaseAuthError,
            )
            expect(await prisma.user.count()).toBe(0)
        })

        it('refuses a token with no phone number', async () => {
            verifyMock.mockResolvedValue(claims({ phoneNumber: null }))

            await expect(AuthService.firebasePhoneAuth({ idToken: 'tok' })).rejects.toBeInstanceOf(
                FirebaseAuthError,
            )
            expect(await prisma.user.count()).toBe(0)
        })

        it('propagates a verification failure without touching the database', async () => {
            verifyMock.mockRejectedValue(
                new FirebaseAuthError('firebase_token_invalid', 'Sign-in token rejected'),
            )

            await expect(AuthService.firebasePhoneAuth({ idToken: 'bad' })).rejects.toBeInstanceOf(
                FirebaseAuthError,
            )
            expect(await prisma.user.count()).toBe(0)
        })
    })
})
