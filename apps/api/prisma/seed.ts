import prisma from '../src/lib/prisma'
import { generateCartela, generateSerial } from '@world-bingo/game-logic'
import bcrypt from 'bcryptjs'

async function main() {
    console.log('Seeding Database...')

    // 1. Seed Admin User
    const adminCount = await prisma.user.count({
        where: { role: 'SUPER_ADMIN' }
    })

    if (adminCount === 0) {
        console.log('Creating default admin...')
        const passwordHash = await bcrypt.hash('password123', 10)
        await prisma.user.create({
            data: {
                username: 'kira',
                phone: '+251911223344',
                passwordHash,
                role: 'SUPER_ADMIN',
                wallet: {
                    create: { balance: 0 }
                }
            }
        })
        console.log('Admin created: kira / password123 / +251911223344')
    }

    // 2. Seed Cartelas
    console.log('Seeding Cartelas...')
    const cartelaCount = await prisma.cartela.count()
    if (cartelaCount === 0) {
        const batch = []
        for (let i = 0; i < 100; i++) {
            const grid = generateCartela()
            const serial = generateSerial(grid)
            batch.push({
                serial: `${serial}-${i}`,
                grid: grid as any
            })
        }
        await prisma.cartela.createMany({ data: batch })
        console.log('Seeded 100 Cartelas')
    }
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect()
    })
