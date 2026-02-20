import prisma from '../lib/prisma'
import { LoginDto, RegisterDto } from '@world-bingo/shared-types'
import bcrypt from 'bcryptjs'

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

        const user = await prisma.user.create({
            data: {
                username: data.username,
                phone: data.phone,
                passwordHash,
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
        const user = await prisma.user.findUnique({
            where: { phone: data.phone },
        })

        if (!user) {
            throw new Error('Invalid credentials')
        }

        const isValid = await bcrypt.compare(data.password, user.passwordHash)

        if (!isValid) {
            throw new Error('Invalid credentials')
        }

        const { passwordHash: _, ...result } = user
        return result
    }
}
