import crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type {
    GameProviderGateway,
    GameListResult,
    LaunchGameParams,
    TransactionDetail,
    TransactionListResult,
    Vendor,
} from './game-provider.interface.js'

const API_KEY = process.env.GASEA_API_KEY ?? ''
const API_SECRET = process.env.GASEA_API_SECRET ?? ''
const BASE_URL = (process.env.GASEA_API_BASE_URL ?? '').replace(/\/$/, '')

function sign(body: object): string {
    return crypto
        .createHmac('sha256', API_SECRET)
        .update(JSON.stringify(body))
        .digest('hex')
}

async function request<T>(path: string, body: object): Promise<T> {
    const fullBody = { ...body, traceId: randomUUID() }
    const signature = sign(fullBody)

    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
            'X-Signature': signature,
        },
        body: JSON.stringify(fullBody),
    })

    if (!res.ok) {
        throw new Error(`GASea ${path} responded ${res.status}`)
    }

    const json = (await res.json()) as { status: string; data?: T; message?: string }

    if (json.status !== 'SC_OK') {
        throw new Error(`GASea error: ${json.status} — ${json.message ?? ''}`)
    }

    return json.data as T
}

// ─── Headers index map from /game/list response ───────────────────────────────
// GASea returns games as arrays; the headers object maps field name → index.
const GAME_HEADERS = {
    gameCode: 0,
    gameName: 1,
    categoryCode: 2,
    imageSquare: 3,
    imageLandscape: 4,
    languageCode: 5,
    platformCode: 6,
    currencyCode: 7,
} as const

export class GaseaGateway implements GameProviderGateway {
    readonly providerCode = 'gasea'

    async getVendors(currency: string, language: string): Promise<Vendor[]> {
        const data = await request<Array<{
            code: string
            name: string
            currencyCode: string
            categoryCode: string
        }>>('/game/vendors', { currency, displayLanguage: language })

        return data.map((v) => ({
            code: v.code,
            name: v.name,
            currencyCodes: v.currencyCode ? v.currencyCode.split(',') : [],
            categoryCodes: v.categoryCode ? v.categoryCode.split(',') : [],
        }))
    }

    async getGames(
        vendorCode: string,
        page: number,
        pageSize: number,
        currency: string,
        language: string,
    ): Promise<GameListResult> {
        const data = await request<{
            games: string[][]
            currentPage: number
            totalItems: number
            totalPages: number
        }>('/game/list', {
            vendorCode,
            pageNo: page,
            pageSize,
            currency,
            displayLanguage: language,
        })

        const games = data.games.map((row) => ({
            gameCode: row[GAME_HEADERS.gameCode] ?? '',
            gameName: row[GAME_HEADERS.gameName] ?? '',
            categoryCode: row[GAME_HEADERS.categoryCode] ?? '',
            imageSquare: row[GAME_HEADERS.imageSquare] ?? null,
            imageLandscape: row[GAME_HEADERS.imageLandscape] ?? null,
            languageCodes: row[GAME_HEADERS.languageCode]?.split(',') ?? [],
            platformCodes: row[GAME_HEADERS.platformCode]?.split(',') ?? [],
            currencyCodes: row[GAME_HEADERS.currencyCode]?.split(',') ?? [],
        }))

        return {
            games,
            currentPage: data.currentPage,
            totalItems: data.totalItems,
            totalPages: data.totalPages,
        }
    }

    async getGameUrl(params: LaunchGameParams): Promise<{ gameUrl: string; token: string }> {
        return request<{ gameUrl: string; token: string }>('/game/url', {
            username: params.username,
            gameCode: params.gameCode,
            language: params.language,
            platform: params.platform,
            currency: params.currency,
            lobbyUrl: params.lobbyUrl,
            ipAddress: params.ipAddress,
        })
    }

    async terminateSession(username: string): Promise<void> {
        await request('/game/terminate', { username })
    }

    async getTransactions(fromTime: number, toTime: number, page: number): Promise<TransactionListResult> {
        const TX_HEADERS = {
            betId: 0, roundId: 1, externalTransactionId: 2, username: 3,
            currencyCode: 4, gameCode: 5, vendorCode: 6, gameCategoryCode: 7,
            betAmount: 8, winAmount: 9, winLoss: 10, effectiveTurnover: 11,
            jackpotAmount: 12, status: 13, vendorBetTime: 14, vendorSettleTime: 15,
            isFreeSpin: 16, vendorBetId: 17,
        }

        const data = await request<{
            transactions: (string | number)[][]
            currentPage: number
            totalItems: number
            totalPages: number
        }>('/transaction/list', { fromTime, toTime, pageNo: page, pageSize: 2000 })

        const transactions = data.transactions.map((row) => ({
            betId: String(row[TX_HEADERS.betId] ?? ''),
            roundId: String(row[TX_HEADERS.roundId] ?? ''),
            externalTransactionId: String(row[TX_HEADERS.externalTransactionId] ?? ''),
            username: String(row[TX_HEADERS.username] ?? ''),
            currencyCode: String(row[TX_HEADERS.currencyCode] ?? ''),
            gameCode: String(row[TX_HEADERS.gameCode] ?? ''),
            vendorCode: String(row[TX_HEADERS.vendorCode] ?? ''),
            gameCategoryCode: String(row[TX_HEADERS.gameCategoryCode] ?? ''),
            betAmount: Number(row[TX_HEADERS.betAmount] ?? 0),
            winAmount: Number(row[TX_HEADERS.winAmount] ?? 0),
            winLoss: Number(row[TX_HEADERS.winLoss] ?? 0),
            effectiveTurnover: Number(row[TX_HEADERS.effectiveTurnover] ?? 0),
            jackpotAmount: Number(row[TX_HEADERS.jackpotAmount] ?? 0),
            status: Number(row[TX_HEADERS.status] ?? 0),
            vendorBetTime: Number(row[TX_HEADERS.vendorBetTime] ?? 0),
            vendorSettleTime: Number(row[TX_HEADERS.vendorSettleTime] ?? 0),
            isFreeSpin: row[TX_HEADERS.isFreeSpin] === 'TRUE',
            vendorBetId: String(row[TX_HEADERS.vendorBetId] ?? ''),
        }))

        return {
            transactions,
            currentPage: data.currentPage,
            totalItems: data.totalItems,
            totalPages: data.totalPages,
        }
    }

    async getTransactionDetail(betId: string, fromTime: number, toTime: number): Promise<TransactionDetail> {
        const data = await request<{
            betDetail: {
                betId: string
                externalTransactionId: string
                roundId: string
                username: string
                currencyCode: string
                gameCode: string
                vendorCode: string
                gameCategoryCode: string
                betAmount: number
                winAmount: number
                winLoss: number
                effectiveTurnover: number
                jackpotAmount: number
                refundAmount: number
                status: number
                isFreeSpin: string
                vendorBetTime: number
                vendorSettleTime: number
            }
            detailUrl?: string
        }>('/v2/transaction/detail', { betId, fromTime, toTime })

        const d = data.betDetail
        return {
            betId: d.betId,
            roundId: d.roundId,
            externalTransactionId: d.externalTransactionId,
            username: d.username,
            currencyCode: d.currencyCode,
            gameCode: d.gameCode,
            vendorCode: d.vendorCode,
            gameCategoryCode: d.gameCategoryCode,
            betAmount: d.betAmount,
            winAmount: d.winAmount,
            winLoss: d.winLoss,
            effectiveTurnover: d.effectiveTurnover,
            jackpotAmount: d.jackpotAmount,
            refundAmount: d.refundAmount,
            status: d.status,
            vendorBetTime: d.vendorBetTime,
            vendorSettleTime: d.vendorSettleTime,
            isFreeSpin: d.isFreeSpin === 'TRUE',
            vendorBetId: d.betId,
            detailUrl: data.detailUrl,
        }
    }
}
