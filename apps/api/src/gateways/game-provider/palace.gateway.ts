import prisma from '../../lib/prisma.js'
import type {
    GameProviderGateway,
    GameListResult,
    LaunchGameParams,
    TransactionDetail,
    TransactionListResult,
    Vendor,
} from './game-provider.interface.js'

const BASE_URL = (process.env.PALACE_API_BASE_URL ?? 'https://agent.goldslotpalase.com').replace(/\/$/, '')
const API_TOKEN = process.env.PALACE_API_TOKEN ?? ''

async function request<T>(path: string, body: object): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Palace ${path} responded ${res.status}`)
    const json = (await res.json()) as { code: number; message: string; data?: T }
    if (json.code !== 0) throw new Error(`Palace error: ${json.code} — ${json.message}`)
    if (json.data == null) throw new Error(`Palace ${path} returned no data`)
    return json.data as T
}

export class PalaceGateway implements GameProviderGateway {
    readonly providerCode = 'palace'

    async getVendors(currency: string, _language: string): Promise<Vendor[]> {
        const data = await request<Array<{
            provider_id: number
            provider_name: string
            status: number
        }>>('/v4/game/providers', { lang: 1 })

        return data
            .filter((p) => p.status === 1)
            .map((p) => ({
                code: `palace:${p.provider_id}`,
                name: p.provider_name,
                currencyCodes: [currency],
                categoryCodes: ['SLOTS'],
            }))
    }

    async getGames(
        vendorCode: string,
        _page: number,
        _pageSize: number,
        _currency: string,
        _language: string,
    ): Promise<GameListResult> {
        const providerId = parseInt(vendorCode.replace('palace:', ''), 10)
        if (isNaN(providerId)) throw new Error(`Invalid Palace vendor code: ${vendorCode}`)

        const data = await request<Array<{
            provider_id: number
            game_code: string
            game_name: string
            game_image: string | null
            launch_enable: boolean
            category: string
        }>>('/v4/game/games', { provider_id: providerId, lang: 1 })

        const games = data
            .filter((g) => g.launch_enable)
            .map((g) => ({
                gameCode: g.game_code,
                gameName: g.game_name,
                categoryCode: (g.category ?? 'SLOTS').toUpperCase().replace(/\s+/g, '_'),
                imageSquare: g.game_image ?? null,
                imageLandscape: null,
                languageCodes: ['en', 'am'],
                platformCodes: ['WEB', 'H5'],
                currencyCodes: ['ETB'],
            }))

        return { games, currentPage: 1, totalItems: games.length, totalPages: 1 }
    }

    async getGameUrl(params: LaunchGameParams): Promise<{ gameUrl: string; token: string }> {
        const userCode = await this.getUserCode(params.username)
        const providerId = await this.resolveProviderId(params.gameCode)

        const data = await request<{ game_url: string }>('/v4/game/game-url', {
            user_code: parseInt(userCode, 10),
            provider_id: providerId,
            game_symbol: params.gameCode,
            lang: 1,
            return_url: params.lobbyUrl,
            win_ratio: 0,
        })

        return { gameUrl: data.game_url, token: '' }
    }

    async terminateSession(_username: string): Promise<void> {
        // Palace has no session termination endpoint in seamless mode
    }

    async getTransactions(fromTime: number, toTime: number, page: number): Promise<TransactionListResult> {
        const toDate = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19)
        const offset = (page - 1) * 1000

        const data = await request<{
            total: number
            list: Array<{
                trans_id: number
                user_code: number
                round_id: string
                trans_type: number
                provider_id: number
                game_code: string
                prebalance: number
                trans_amount: number
                balance: number
                regdate: string
            }>
        }>('/v4/game/transaction', {
            start_time: toDate(fromTime),
            end_time: toDate(toTime),
            offset,
            limit: 1000,
        })

        const transactions = (data.list ?? []).map((t) => ({
            betId: String(t.trans_id),
            roundId: t.round_id,
            externalTransactionId: String(t.trans_id),
            username: String(t.user_code),
            currencyCode: 'ETB',
            gameCode: t.game_code,
            vendorCode: `palace:${t.provider_id}`,
            gameCategoryCode: 'SLOTS',
            betAmount: t.trans_type === 1 ? t.trans_amount : 0,
            winAmount: t.trans_type === 2 ? t.trans_amount : 0,
            winLoss: t.trans_type === 2 ? t.trans_amount : -t.trans_amount,
            effectiveTurnover: t.trans_type === 1 ? t.trans_amount : 0,
            jackpotAmount: 0,
            status: 1,
            vendorBetTime: new Date(t.regdate).getTime(),
            vendorSettleTime: new Date(t.regdate).getTime(),
            isFreeSpin: false,
            vendorBetId: String(t.trans_id),
        }))

        const totalPages = Math.ceil((data.total ?? 0) / 1000) || 1
        return { transactions, currentPage: page, totalItems: data.total ?? 0, totalPages }
    }

    async getTransactionDetail(betId: string, _fromTime: number, _toTime: number): Promise<TransactionDetail> {
        const data = await request<Array<{
            trans_id: number
            user_code: number
            round_id: string
            trans_type: number
            provider_id: number
            game_code: string
            prebalance: number
            trans_amount: number
            balance: number
            regdate: string
        }>>('/v4/game/transaction-id', { last_id: parseInt(betId, 10) - 1, limit: 1 })

        const t = data[0]
        if (!t) throw new Error(`Palace transaction ${betId} not found`)
        if (String(t.trans_id) !== betId) throw new Error(`Palace transaction ${betId} not found (cursor returned ${t.trans_id})`)

        return {
            betId: String(t.trans_id),
            roundId: t.round_id,
            externalTransactionId: String(t.trans_id),
            username: String(t.user_code),
            currencyCode: 'ETB',
            gameCode: t.game_code,
            vendorCode: `palace:${t.provider_id}`,
            gameCategoryCode: 'SLOTS',
            betAmount: t.trans_type === 1 ? t.trans_amount : 0,
            winAmount: t.trans_type === 2 ? t.trans_amount : 0,
            winLoss: t.trans_type === 2 ? t.trans_amount : -t.trans_amount,
            effectiveTurnover: t.trans_type === 1 ? t.trans_amount : 0,
            jackpotAmount: 0,
            refundAmount: 0,
            status: 1,
            vendorBetTime: new Date(t.regdate).getTime(),
            vendorSettleTime: new Date(t.regdate).getTime(),
            isFreeSpin: false,
            vendorBetId: String(t.trans_id),
        }
    }

    /** Lazily provision or retrieve Palace user_code for a given username or UUID-without-dashes. */
    async getUserCode(username: string): Promise<string> {
        const provider = await prisma.gameProvider.findUnique({ where: { code: 'palace' } })
        if (!provider) throw new Error('Palace provider not seeded in DB')

        let user: { id: string } | null = null
        if (/^[0-9a-f]{32}$/i.test(username)) {
            const id = `${username.slice(0,8)}-${username.slice(8,12)}-${username.slice(12,16)}-${username.slice(16,20)}-${username.slice(20)}`
            user = await prisma.user.findUnique({ where: { id }, select: { id: true } })
        } else {
            user = await prisma.user.findUnique({ where: { username }, select: { id: true } })
        }
        if (!user) throw new Error(`User not found: ${username}`)

        const existing = await prisma.providerUserAccount.findUnique({
            where: { providerId_userId: { providerId: provider.id, userId: user.id } },
        })
        if (existing) return existing.externalUserCode

        const data = await request<{ user_code: number }>('/v4/user/create', { name: username })
        try {
            await prisma.providerUserAccount.create({
                data: { providerId: provider.id, userId: user.id, externalUserCode: String(data.user_code) },
            })
        } catch {
            // Unique constraint: concurrent request already created the record
            const conflict = await prisma.providerUserAccount.findUnique({
                where: { providerId_userId: { providerId: provider.id, userId: user.id } },
            })
            if (conflict) return conflict.externalUserCode
        }
        return String(data.user_code)
    }

    private async resolveProviderId(gameCode: string): Promise<number> {
        const provider = await prisma.gameProvider.findUnique({ where: { code: 'palace' } })
        if (!provider) throw new Error('Palace provider not seeded')

        const game = await prisma.providerGame.findUnique({
            where: { providerId_gameCode: { providerId: provider.id, gameCode } },
            include: { vendor: true },
        })
        if (!game) throw new Error(`Palace game not found in DB: ${gameCode}`)

        const providerId = parseInt(game.vendor.code.replace('palace:', ''), 10)
        if (isNaN(providerId)) throw new Error(`Invalid vendor code for game ${gameCode}: ${game.vendor.code}`)
        return providerId
    }
}
