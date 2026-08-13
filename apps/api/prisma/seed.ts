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
        // SUPER_ADMIN is the most privileged principal on the platform and, since
        // the privilege-escalation fix, cannot be re-minted through the API — so a
        // predictable password here is the single highest-value target an attacker
        // has. It is read from the environment, never hardcoded, and never logged.
        const isDev = (process.env.NODE_ENV ?? 'development') === 'development'
        const seedPassword = process.env.SEED_SUPER_ADMIN_PASSWORD

        if (!seedPassword && !isDev) {
            throw new Error(
                'SEED_SUPER_ADMIN_PASSWORD must be set to seed a SUPER_ADMIN outside development. ' +
                'Refusing to create a privileged account with a default password.',
            )
        }

        const password = seedPassword ?? 'dev-only-change-me'
        const username = process.env.SEED_SUPER_ADMIN_USERNAME ?? 'kira'
        const phone = process.env.SEED_SUPER_ADMIN_PHONE ?? '+251911223344'

        console.log('Creating default admin...')
        const passwordHash = await bcrypt.hash(password, 10)
        await prisma.user.create({
            data: {
                username,
                phone,
                passwordHash,
                role: 'SUPER_ADMIN',
                wallet: {
                    // Funded in local dev only. Outside dev this must be 0: the
                    // balance is written straight to the wallet with no matching
                    // Transaction row, so a funded prod seed puts unaudited money
                    // on the most privileged account on the platform.
                    create: { realBalance: isDev ? 10000 : 0 }
                }
            }
        })
        // Deliberately does NOT print the password.
        console.log(`Admin created: ${username} (${phone})`)
        if (!seedPassword) {
            console.warn(
                '⚠  Seeded with the development default password. NEVER use this outside local dev — ' +
                'set SEED_SUPER_ADMIN_PASSWORD and re-seed, or rotate the password immediately.',
            )
        }
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

    // 4. Seed House Wallet (singleton)
    console.log('Seeding House Wallet...')
    await prisma.$executeRaw`
        INSERT INTO house_wallet (id, balance, "updatedAt")
        VALUES ('house', 0, NOW())
        ON CONFLICT (id) DO NOTHING
    `
    console.log('House wallet seeded')

    // 5. Seed default feature flags + game settings
    console.log('Seeding Feature Flags...')
    const defaultFlags = [
        { key: 'feature_referrals', value: 'false' },
        { key: 'feature_tournaments', value: 'false' },
        { key: 'feature_third_party_games', value: 'false' },
        { key: 'ball_interval_secs', value: '3' },
        { key: 'first_deposit_bonus_amount', value: '0' },
        { key: 'bot_max_spend_etb', value: '500' },
    ]
    for (const flag of defaultFlags) {
        await prisma.siteSetting.upsert({
            where: { key: flag.key },
            update: {},             // don't overwrite existing values
            create: flag,
        })
    }
    console.log('Feature flags seeded')

    // 6. Seed GASea game provider (credentials come from env vars at runtime)
    console.log('Seeding GASea provider...')
    await prisma.gameProvider.upsert({
        where: { code: 'gasea' },
        update: {},  // don't overwrite status if admin changed it
        create: {
            code: 'gasea',
            name: 'GASea',
            status: 'ACTIVE',
            apiBaseUrl: process.env.GASEA_API_BASE_URL ?? '',
            currency: process.env.GASEA_DEFAULT_CURRENCY ?? 'ETB',
            config: {},
        },
    })
    console.log('GASea provider seeded')

    // 6b. Seed Palace Casino game provider
    console.log('Seeding Palace Casino provider...')
    await prisma.gameProvider.upsert({
        where: { code: 'palace' },
        update: {},  // don't overwrite status if admin changed it
        create: {
            code: 'palace',
            name: 'Palace Casino',
            status: 'ACTIVE',
            isPrimary: false,
            apiBaseUrl: process.env.PALACE_API_BASE_URL ?? '',
            currency: process.env.PALACE_CURRENCY ?? 'ETB',
            config: {},
        },
    })
    console.log('Palace Casino provider seeded')

    // 7. Seed default payment methods
    console.log('Seeding Payment Methods...')
    const defaultMethods = [
        { code: 'telebirr', name: 'TeleBirr', type: 'DEPOSIT' as const, merchantAccount: '', instructions: 'Send via TeleBirr to the merchant number. Complete within 15 minutes.', icon: '📱', enabled: true, sortOrder: 0 },
        { code: 'telebirr_withdrawal', name: 'TeleBirr', type: 'WITHDRAWAL' as const, merchantAccount: null, instructions: null, icon: '📱', enabled: true, sortOrder: 0 },
        { code: 'cbe', name: 'CBE Birr', type: 'WITHDRAWAL' as const, merchantAccount: null, instructions: null, icon: '🏦', enabled: true, sortOrder: 1 },
        { code: 'awash', name: 'Awash Bank', type: 'WITHDRAWAL' as const, merchantAccount: null, instructions: null, icon: '🏦', enabled: true, sortOrder: 2 },
        { code: 'dashen', name: 'Dashen Bank', type: 'WITHDRAWAL' as const, merchantAccount: null, instructions: null, icon: '🏦', enabled: true, sortOrder: 3 },
        { code: 'amhara', name: 'Amhara Bank', type: 'WITHDRAWAL' as const, merchantAccount: null, instructions: null, icon: '🏦', enabled: true, sortOrder: 4 },
    ]
    for (const method of defaultMethods) {
        await prisma.paymentMethod.upsert({
            where: { code: method.code },
            update: {},  // don't overwrite existing values
            create: method,
        })
    }
    console.log(`Payment methods seeded (${defaultMethods.length} methods)`)

    // 8. Create one WAITING game per active template so the lobby isn't empty
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
