import { describe, it, expect, beforeEach } from 'vitest'
import { AuthService } from '../services/auth.service'
import { prisma } from './setup'

describe('AuthService', () => {
    describe('register', () => {
        it('should create a new user with wallet', async () => {
            const userData = {
                username: 'testuser',
                phone: '+251912345678',
                password: 'password123',
            }

            const user = await AuthService.register(userData)

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

            const user = await AuthService.register(userData)

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

            const user = await AuthService.register(userData)

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

            const user = await AuthService.register(userData)

            await expect(
                AuthService.changePassword(user.id, {
                    currentPassword: 'wrongpassword',
                    newPassword: 'newpassword123',
                }),
            ).rejects.toThrow('Current password is incorrect')
        })
    })
})
