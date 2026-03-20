import { describe, it, expect, beforeEach } from 'vitest'
import crypto from 'crypto'
import { AuthService } from '../services/auth.service'
import { prisma } from './setup'
import type { TelegramAuthDto } from '@world-bingo/shared-types'

describe('AuthService', () => {
    describe('register', () => {
        it('should create a new user with wallet', async () => {
            const userData = {
                username: 'testuser',
                phone: '+251912345678',
                password: 'password123',
            }

            const { user } = await AuthService.register(userData)

            expect(user.username).toBe(userData.username)
            expect(user.phone).toBe(userData.phone)
            expect(user.id).toBeDefined()
        })

        it('should create a wallet with zero balance', async () => {
            const userData = {
                username: 'testuser2',
                phone: '+251912345679',
                password: 'password123',
            }

            const { user } = await AuthService.register(userData)

            const wallet = await prisma.wallet.findUnique({
                where: { userId: user.id },
            })

            expect(wallet).toBeDefined()
            expect(wallet?.balance.toString()).toBe('0')
        })

        it('should throw error if username exists', async () => {
            const userData = {
                username: 'duplicateuser',
                phone: '+251912345680',
                password: 'password123',
            }

            await AuthService.register(userData)

            await expect(
                AuthService.register({
                    ...userData,
                    phone: '+251912345681',
                })
            ).rejects.toThrow('User already exists')
        })

        it('should throw error if phone exists', async () => {
            const userData = {
                username: 'newuser',
                phone: '+251912345682',
                password: 'password123',
            }

            await AuthService.register(userData)

            await expect(
                AuthService.register({
                    ...userData,
                    username: 'anotheruser',
                })
            ).rejects.toThrow('User already exists')
        })

        it('should not expose password hash in response', async () => {
            const userData = {
                username: 'testuser3',
                phone: '+251912345683',
                password: 'mypassword',
            }

            const { user } = await AuthService.register(userData)

            expect(user).not.toHaveProperty('passwordHash')

            const dbUser = await prisma.user.findUnique({
                where: { id: user.id },
            })
            expect(dbUser?.passwordHash).toBeDefined()
        })
    })

    describe('login', () => {
        it('should login with valid phone and return user + refreshToken', async () => {
            const userData = {
                username: 'logintest',
                phone: '+251912345684',
                password: 'password123',
            }

            await AuthService.register(userData)

            const { user, refreshToken } = await AuthService.login({
                identifier: userData.phone,
                password: userData.password,
            })

            expect(user.phone).toBe(userData.phone)
            expect('passwordHash' in user).toBe(false)
            expect(refreshToken).toBeDefined()
            expect(typeof refreshToken).toBe('string')
        })

        it('should login with valid username', async () => {
            const userData = {
                username: 'logintest_username',
                phone: '+251912345694',
                password: 'password123',
            }

            await AuthService.register(userData)

            const { user } = await AuthService.login({
                identifier: userData.username,
                password: userData.password,
            })

            expect(user.username).toBe(userData.username)
            expect('passwordHash' in user).toBe(false)
        })

        it('should store refresh token hash in DB', async () => {
            const userData = {
                username: 'refreshtest',
                phone: '+251912300001',
                password: 'password123',
            }

            await AuthService.register(userData)

            const { refreshToken } = await AuthService.login({
                identifier: userData.phone,
                password: userData.password,
            })

            const stored = await prisma.refreshToken.findFirst({
                where: { user: { phone: userData.phone } },
            })

            expect(stored).toBeDefined()
            expect(stored?.tokenHash).not.toBe(refreshToken) // stored as hash, not plain
        })

        it('should throw error with invalid identifier', async () => {
            await expect(
                AuthService.login({
                    identifier: '+251999999999',
                    password: 'password123',
                })
            ).rejects.toThrow('Invalid credentials')
        })

        it('should throw error with invalid password', async () => {
            const userData = {
                username: 'logintest2',
                phone: '+251912345685',
                password: 'correctpassword',
            }

            await AuthService.register(userData)

            await expect(
                AuthService.login({
                    identifier: userData.phone,
                    password: 'wrongpassword',
                })
            ).rejects.toThrow('Invalid credentials')
        })
    })

    describe('refreshToken', () => {
        it('should issue a new access token and rotate the refresh token', async () => {
            const userData = {
                username: 'refreshuser',
                phone: '+251912300010',
                password: 'password123',
            }

            await AuthService.register(userData)
            const { refreshToken: oldToken } = await AuthService.login({
                identifier: userData.phone,
                password: userData.password,
            })

            const { user, refreshToken: newToken } = await AuthService.refreshToken(oldToken)

            expect(newToken).toBeDefined()
            expect(newToken).not.toBe(oldToken)
            expect(user.phone).toBe(userData.phone)
        })

        it('should reject an invalid refresh token', async () => {
            await expect(AuthService.refreshToken('invalid-token')).rejects.toThrow(
                'Invalid refresh token',
            )
        })

        it('should invalidate the old token after rotation', async () => {
            const userData = {
                username: 'rotateuser',
                phone: '+251912300020',
                password: 'password123',
            }

            await AuthService.register(userData)
            const { refreshToken: firstToken } = await AuthService.login({
                identifier: userData.phone,
                password: userData.password,
            })

            // Use the token once
            await AuthService.refreshToken(firstToken)

            // Try to use the same token again — must fail
            await expect(AuthService.refreshToken(firstToken)).rejects.toThrow(
                'Invalid refresh token',
            )
        })
    })

    describe('logout', () => {
        it('should delete the refresh token from DB', async () => {
            const userData = {
                username: 'logoutuser',
                phone: '+251912300030',
                password: 'password123',
            }

            await AuthService.register(userData)
            const { refreshToken } = await AuthService.login({
                identifier: userData.phone,
                password: userData.password,
            })

            await AuthService.logout(refreshToken)

            // Token must be gone
            await expect(AuthService.refreshToken(refreshToken)).rejects.toThrow(
                'Invalid refresh token',
            )
        })
    })

    describe('telegramAuth', () => {
        function makeTelegramPayload(overrides: Partial<Omit<TelegramAuthDto, 'hash'>> = {}): TelegramAuthDto {
            const base = {
                id: 123456789,
                first_name: 'Test',
                auth_date: Math.floor(Date.now() / 1000),
                ...overrides,
            }
            const dataCheckString = Object.entries(base)
                .filter(([, v]) => v !== undefined)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => `${k}=${v}`)
                .join('\n')
            const secretKey = crypto.createHash('sha256')
                .update(process.env.TELEGRAM_BOT_TOKEN ?? 'test_token')
                .digest()
            const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
            return { ...base, hash }
        }

        it('should return user + refreshToken for valid payload', async () => {
            const payload = makeTelegramPayload()
            const { user, refreshToken } = await AuthService.telegramAuth(payload)
            expect(user.telegramId).toBe(String(payload.id))
            expect(refreshToken).toBeDefined()
        })

        it('should throw for invalid hash', async () => {
            const payload = makeTelegramPayload()
            await expect(AuthService.telegramAuth({ ...payload, hash: 'badhash' }))
                .rejects.toThrow('Invalid Telegram auth data')
        })

        it('should throw if auth_date is older than 300 seconds', async () => {
            const payload = makeTelegramPayload({ auth_date: Math.floor(Date.now() / 1000) - 400 })
            await expect(AuthService.telegramAuth(payload)).rejects.toThrow('Telegram auth data expired')
        })

        it('should create a new user on first login', async () => {
            const payload = makeTelegramPayload({ id: 999001 })
            const { user } = await AuthService.telegramAuth(payload)
            expect(user.id).toBeDefined()
            const dbUser = await prisma.user.findUnique({ where: { telegramId: '999001' } })
            expect(dbUser).toBeTruthy()
        })

        it('should log in existing user without duplicating', async () => {
            const payload = makeTelegramPayload({ id: 999002 })
            const { user: u1 } = await AuthService.telegramAuth(payload)
            const payload2 = makeTelegramPayload({ id: 999002 })
            const { user: u2 } = await AuthService.telegramAuth(payload2)
            expect(u1.id).toBe(u2.id)
            const count = await prisma.user.count({ where: { telegramId: '999002' } })
            expect(count).toBe(1)
        })
    })

    describe('changePassword', () => {
        it('should change password and invalidate all refresh tokens', async () => {
            const userData = {
                username: 'changepwuser',
                phone: '+251912300040',
                password: 'oldpassword',
            }

            await AuthService.register(userData)
            const { refreshToken, user } = await AuthService.login({
                identifier: userData.phone,
                password: userData.password,
            })

            await AuthService.changePassword(user.id, {
                currentPassword: userData.password,
                newPassword: 'newpassword123',
            })

            // Old refresh token must be gone
            await expect(AuthService.refreshToken(refreshToken)).rejects.toThrow(
                'Invalid refresh token',
            )
        })

        it('should reject wrong current password', async () => {
            const userData = {
                username: 'changepwuser2',
                phone: '+251912300050',
                password: 'correctpassword',
            }

            const { user } = await AuthService.register(userData)

            await expect(
                AuthService.changePassword(user.id, {
                    currentPassword: 'wrongpassword',
                    newPassword: 'newpassword123',
                }),
            ).rejects.toThrow('Current password is incorrect')
        })
    })
})
