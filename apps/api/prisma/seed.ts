import { PrismaClient } from '@prisma/client'
import { generateCartela, generateSerial } from '@world-bingo/game-logic'
import bcrypt from 'bcryptjs'
import { seedEtfcCard } from './seed-etfc'

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

    // 6c. Seed Atlas-V game provider (static catalog — no listing API in their
    // spec, see docs/superpowers/specs/2026-09-09-atlasv-integration-design.md)
    console.log('Seeding Atlas-V provider...')
    const atlasv = await prisma.gameProvider.upsert({
        where: { code: 'atlasv' },
        update: {},  // don't overwrite status if admin changed it
        create: {
            code: 'atlasv',
            name: 'Atlas-V',
            status: 'ACTIVE',
            isPrimary: false,
            apiBaseUrl: process.env.ATLASV_SERVER_URL ?? '',
            currency: process.env.ATLASV_DEFAULT_CURRENCY ?? 'ETB',
            config: { catalogSync: false },
        },
    })
    const atlasvVendor = await prisma.gameVendor.upsert({
        where: { providerId_code: { providerId: atlasv.id, code: 'atlasv-default' } },
        update: { categoryCode: 'CRASH,MINI,TABLE,SLOTS' },
        create: {
            providerId: atlasv.id,
            code: 'atlasv-default',
            name: 'Atlas-V',
            categoryCode: 'CRASH,MINI,TABLE,SLOTS',
            isActive: true,
        },
    })

    // Atlas-V's own "Games Info - Game List" export (no listing API to sync
    // from, so this is hand-maintained). gameCode is their GAME ID column;
    // categoryCode buckets their GAME TYPE column onto the lobby's existing
    // categories (CRASH/MINI/TABLE/SLOTS) rather than inventing new ones —
    // Fast Games/Plinko/Keno/Virtual Sport all land in MINI, Roulette/Video
    // Poker in TABLE.
    const ATLASV_GAMES: Array<{ gameCode: string; gameName: string; categoryCode: string }> = [
        { gameCode: 'wowbow', gameName: 'Wow Bow', categoryCode: 'CRASH' },
        { gameCode: 'pinkthunder', gameName: 'Pink Thunder', categoryCode: 'CRASH' },
        { gameCode: 'bluethunder', gameName: 'Blue Thunder', categoryCode: 'CRASH' },
        { gameCode: 'formula', gameName: 'Fast F1', categoryCode: 'CRASH' },
        { gameCode: 'penalty', gameName: 'Fast Penalty', categoryCode: 'MINI' },
        { gameCode: 'plinko', gameName: 'Plinko', categoryCode: 'MINI' },
        { gameCode: 'keno', gameName: 'Fast Keno', categoryCode: 'MINI' },
        { gameCode: 'boombasket', gameName: 'Boom Basket', categoryCode: 'MINI' },
        { gameCode: 'boomball', gameName: 'Boom Ball', categoryCode: 'MINI' },
        { gameCode: 'winball', gameName: 'Win Ball', categoryCode: 'MINI' },
        { gameCode: 'wof', gameName: 'Wheel of Fortune', categoryCode: 'TABLE' },
        { gameCode: 'goldminer', gameName: 'Gold Miner', categoryCode: 'CRASH' },
        { gameCode: 'goldengate', gameName: 'Golden Gate', categoryCode: 'MINI' },
        { gameCode: 'striker', gameName: 'Striker', categoryCode: 'MINI' },
        { gameCode: 'darts', gameName: 'Fast Darts', categoryCode: 'MINI' },
        { gameCode: 'jacksorbetter', gameName: 'Jacks or Better', categoryCode: 'TABLE' },
        { gameCode: 'jokerwild', gameName: 'Joker Wild', categoryCode: 'TABLE' },
        { gameCode: 'greyhoundracing', gameName: 'Greyhound Racing', categoryCode: 'MINI' },
        { gameCode: 'horseracing', gameName: 'Horse Racing', categoryCode: 'MINI' },
        { gameCode: 'rocketstar', gameName: 'Rocket Star', categoryCode: 'CRASH' },
        { gameCode: 'chukchaman', gameName: 'Chukcha Man', categoryCode: 'SLOTS' },
        { gameCode: 'tavern', gameName: 'Tavern', categoryCode: 'SLOTS' },
        { gameCode: 'fairyland', gameName: 'Fairy Land', categoryCode: 'SLOTS' },
        { gameCode: 'monkeyboy', gameName: 'Monkey Boy', categoryCode: 'SLOTS' },
        { gameCode: 'juicyfruits', gameName: 'Juicy Fruits', categoryCode: 'SLOTS' },
        { gameCode: 'dragon', gameName: 'DragOn', categoryCode: 'SLOTS' },
        { gameCode: 'hotkeno', gameName: 'Hot Keno', categoryCode: 'MINI' },
    ]

    for (const g of ATLASV_GAMES) {
        await prisma.providerGame.upsert({
            where: { providerId_gameCode: { providerId: atlasv.id, gameCode: g.gameCode } },
            // Catalog metadata stays in sync with the source list on every reseed,
            // same as GameCatalogService.syncGames does for synced providers — but
            // isActive is never touched here, so an admin's manual disable (PATCH
            // /admin/providers/:code/games/:gameCode/status) survives a reseed.
            update: {
                gameName: g.gameName,
                categoryCode: g.categoryCode,
                languageCodes: ['en', 'am'],
                platformCodes: ['WEB', 'H5'],
                currencyCodes: [process.env.ATLASV_DEFAULT_CURRENCY ?? 'ETB'],
            },
            create: {
                providerId: atlasv.id,
                vendorId: atlasvVendor.id,
                gameCode: g.gameCode,
                gameName: g.gameName,
                categoryCode: g.categoryCode,
                languageCodes: ['en', 'am'],
                platformCodes: ['WEB', 'H5'],
                currencyCodes: [process.env.ATLASV_DEFAULT_CURRENCY ?? 'ETB'],
                isActive: true,
            },
        })
    }
    // Unlike GameCatalogService.syncGames (which re-projects the admin's
    // featured-games pins onto newly synced rows every time it runs), this
    // hand-maintained catalog has no equivalent trigger — a pin saved before
    // a game's row existed (or before a rename, e.g. 'Keno' -> 'Fast Keno')
    // would otherwise sit orphaned (0 matches) until an admin happens to
    // re-save the featured-games list for an unrelated reason.
    //
    // Reimplemented inline (matches FeaturedGameService.applyRanks() — keep
    // the two in sync) rather than imported: that service module also pulls
    // in the live Redis client from lib/redis.ts, which this script never
    // closes. An open Redis handle keeps the Node process alive forever, so
    // `tsx prisma/seed.ts` would never exit — entrypoint.sh's run_seed()
    // would hang waiting for it, and the container would never reach
    // "Starting API server", failing its healthcheck with nothing ever
    // listening on the port. Confirmed live on aradabingo production.
    const pins = await prisma.featuredGame.findMany({
        orderBy: { position: 'asc' },
        select: { nameKey: true, position: true },
    })
    const pinKeys = pins.map((p) => p.nameKey)
    const pinRanks = pins.map((p) => p.position)
    await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE provider_games SET "featuredRank" = NULL WHERE "featuredRank" IS NOT NULL`
        if (pinKeys.length === 0) return
        await tx.$executeRaw`
            UPDATE provider_games g
            SET "featuredRank" = v.rank
            FROM (
                SELECT unnest(${pinKeys}::text[]) AS key, unnest(${pinRanks}::int[]) AS rank
            ) v
            WHERE regexp_replace(lower(g."gameName"), '[^a-z0-9]', '', 'g') = v.key
        `
    })
    console.log(`Atlas-V provider seeded (${ATLASV_GAMES.length} games)`)

    // 7. Seed default payment methods
    console.log('Seeding Payment Methods...')
    const defaultMethods = [
        { code: 'telebirr', name: 'TeleBirr', type: 'DEPOSIT' as const, merchantAccount: '', instructions: 'Send via TeleBirr to the merchant number. Complete within 15 minutes.', icon: '📱', logoUrl: '/payment-logos/telebirr.svg', enabled: true, sortOrder: 0 },
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
    // Hosted checkout ships OFF. An operator enables it once this brand's Custom
    // URL and webhook are configured in the ZareCash console. sortOrder -1 keeps it
    // above the manual methods without rewriting their operator-chosen ordering.
    await prisma.paymentMethod.upsert({
        where: { code: 'zarecash' },
        update: {},
        create: {
            code: 'zarecash',
            name: 'ZareCash',
            type: 'DEPOSIT' as const,
            gateway: 'zarecash',
            hostedCheckout: true,
            icon: '⚡',
            // The card prefers this over `icon`; the emoji stays as the fallback
            // for any deployment that has not shipped the asset.
            logoUrl: '/payment-logos/zarecash.svg',
            instructions: 'Pay on the ZareCash page — we confirm your deposit automatically.',
            sortOrder: -1,
            enabled: false,
        },
    })

    console.log(`Payment methods seeded (${defaultMethods.length + 1} methods)`)

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

    // ── Prediction markets ───────────────────────────────────────────────────
    // The ETFC card seeds with everything else so a fresh environment comes up
    // complete. Every market is DRAFT and the whole feature sits behind
    // `feature_prediction_market` (default false), so this adds nothing a player
    // can see until an admin both publishes a market and turns the flag on.
    // Failure here must not abort the rest of the seed — the bingo tables above
    // matter more than the fight card.
    try {
        await seedEtfcCard()
    } catch (err) {
        console.warn('⚠  ETFC prediction card seed failed, continuing:', (err as Error).message)
    }
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect()
    })
