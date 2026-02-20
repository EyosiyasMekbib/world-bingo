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

            // Verify password hash is not in response
            expect(user).not.toHaveProperty('passwordHash')
            
            // But it exists in the database
            const dbUser = await prisma.user.findUnique({
                where: { id: user.id },
            })
            expect(dbUser?.passwordHash).toBeDefined()
        })
    })

    describe('login', () => {
        it('should login with valid credentials', async () => {
            const userData = {
                username: 'logintest',
                phone: '+251912345684',
                password: 'password123',
            }

            await AuthService.register(userData)

            const user = await AuthService.login({
                phone: userData.phone,
                password: userData.password,
            })

            expect(user.phone).toBe(userData.phone)
            // passwordHash should not exist on the returned user object
            expect('passwordHash' in user).toBe(false)
        })

        it('should throw error with invalid phone', async () => {
            await expect(
                AuthService.login({
                    phone: '+251999999999',
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
                    phone: userData.phone,
                    password: 'wrongpassword',
                })
            ).rejects.toThrow('Invalid credentials')
        })

        it('should not return password hash in response', async () => {
            const userData = {
                username: 'logintest3',
                phone: '+251912345686',
                password: 'password123',
            }

            await AuthService.register(userData)

            const user = await AuthService.login({
                phone: userData.phone,
                password: userData.password,
            })

            expect(user).not.toHaveProperty('passwordHash')
        })
    })
})
