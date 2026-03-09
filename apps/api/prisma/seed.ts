import { PrismaClient } from '@prisma/client'
import { generateCartela, generateSerial } from '@world-bingo/game-logic'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

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
                    create: { balance: 10000 }
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

    // 3. Seed Game Templates (preconfigured always-on games)
    console.log('Seeding Game Templates...')
    const templateCount = await prisma.gameTemplate.count()
    if (templateCount === 0) {
        const templates = [
            {
                title: 'Quick 10 ETB',
                ticketPrice: 10,
                maxPlayers: 70,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE' as const,
                countdownSecs: 60,
                active: true,
            },
            {
                title: 'Classic 20 ETB',
                ticketPrice: 20,
                maxPlayers: 70,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE' as const,
                countdownSecs: 60,
                active: true,
            },
            {
                title: 'Premium 50 ETB',
                ticketPrice: 50,
                maxPlayers: 70,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE' as const,
                countdownSecs: 60,
                active: true,
            },
            {
                title: 'High Roller 100 ETB',
                ticketPrice: 100,
                maxPlayers: 50,
                minPlayers: 2,
                houseEdgePct: 8,
                pattern: 'FULL_CARD' as const,
                countdownSecs: 60,
                active: true,
            },
        ]

        for (const t of templates) {
            await prisma.gameTemplate.create({ data: t })
        }
        console.log(`Seeded ${templates.length} Game Templates`)
    }

    // 4. Seed Admin Wallet (singleton house wallet)
    console.log('Seeding Admin Wallet...')
    const adminWalletCount = await prisma.adminWallet.count()
    if (adminWalletCount === 0) {
        await prisma.adminWallet.create({ data: { balance: 0 } })
        console.log('Admin wallet created')
    }

    // 5. Seed default feature flags + game settings
    console.log('Seeding Feature Flags...')
    const defaultFlags = [
        { key: 'feature_referrals', value: 'false' },
        { key: 'feature_tournaments', value: 'false' },
        { key: 'ball_interval_secs', value: '3' },
    ]
    for (const flag of defaultFlags) {
        await prisma.siteSetting.upsert({
            where: { key: flag.key },
            update: {},             // don't overwrite existing values
            create: flag,
        })
    }
    console.log('Feature flags seeded')

    // 6. Create one WAITING game per active template so the lobby isn't empty
    console.log('Creating initial games from templates...')
    const templates = await prisma.gameTemplate.findMany({ where: { active: true } })
    for (const t of templates) {
        const existingWaiting = await prisma.game.count({
            where: { templateId: t.id, status: 'WAITING' },
        })
        if (existingWaiting === 0) {
            await prisma.game.create({
                data: {
                    title: t.title,
                    ticketPrice: t.ticketPrice,
                    maxPlayers: t.maxPlayers,
                    minPlayers: t.minPlayers,
                    houseEdgePct: t.houseEdgePct,
                    pattern: t.pattern,
                    status: 'WAITING',
                    calledBalls: [],
                    templateId: t.id,
                },
            })
            console.log(`  Created WAITING game for "${t.title}"`)
        }
    }
    console.log('Initial games created')
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect()
    })
