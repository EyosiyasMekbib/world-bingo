import { signAtlasVBody } from './atlasv-signature.js'
import type {
    GameProviderGateway,
    GameListResult,
    LaunchGameParams,
    TransactionDetail,
    TransactionListResult,
    Vendor,
} from './game-provider.interface.js'

const SERVER_URL = (process.env.ATLASV_SERVER_URL ?? '').replace(/\/$/, '')
const GAME_SERVER_URL = (process.env.ATLASV_GAME_SERVER_URL || process.env.ATLASV_SERVER_URL || '').replace(/\/$/, '')
const CASINO_ID = process.env.ATLASV_CASINO_ID ?? ''
const PARTNER_ID = process.env.ATLASV_PARTNER_ID ?? '1'

export class AtlasVApiError extends Error {
    readonly statusCode: number
    readonly code: string

    constructor(opts: { message: string; statusCode: number; code: string }) {
        super(opts.message)
        this.name = 'AtlasVApiError'
        this.statusCode = opts.statusCode
        this.code = opts.code
    }
}

async function request<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
    const signed = signAtlasVBody(body)
    let res: Response
    try {
        res = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/javascript' },
            body: JSON.stringify(signed),
        })
    } catch (err: any) {
        throw new AtlasVApiError({
            message: `Atlas-V is unreachable: ${err?.message ?? 'network error'}`,
            statusCode: 502,
            code: 'ATLASV_UNREACHABLE',
        })
    }
    if (!res.ok) {
        throw new AtlasVApiError({
            message: `Atlas-V upstream returned HTTP ${res.status}`,
            statusCode: 502,
            code: 'ATLASV_UPSTREAM_HTTP_ERROR',
        })
    }
    try {
        return (await res.json()) as T
    } catch {
        throw new AtlasVApiError({
            message: `Atlas-V ${path} returned a non-JSON response`,
            statusCode: 502,
            code: 'ATLASV_INVALID_RESPONSE',
        })
    }
}

export class AtlasVGateway implements GameProviderGateway {
    readonly providerCode = 'atlasv'

    async getVendors(_currency: string, _language: string): Promise<Vendor[]> {
        throw new AtlasVApiError({ message: 'Atlas-V has no vendor listing API', statusCode: 501, code: 'ATLASV_NOT_SUPPORTED' })
    }

    async getGames(
        _vendorCode: string,
        _page: number,
        _pageSize: number,
        _currency: string,
        _language: string,
    ): Promise<GameListResult> {
        throw new AtlasVApiError({ message: 'Atlas-V has no game listing API', statusCode: 501, code: 'ATLASV_NOT_SUPPORTED' })
    }

    async getGameUrl(params: LaunchGameParams): Promise<{ gameUrl: string; token: string }> {
        const data = await request<{ url?: string }>(SERVER_URL, '/init', {
            game: params.gameCode,
            partner_id: PARTNER_ID,
            casino_id: CASINO_ID,
            language: params.language,
            currency: params.currency,
            player_id: params.username,
        })
        if (!data?.url) {
            throw new AtlasVApiError({ message: 'Atlas-V /init returned no url', statusCode: 502, code: 'ATLASV_EMPTY_RESPONSE' })
        }
        return { gameUrl: data.url, token: '' }
    }

    async terminateSession(_username: string): Promise<void> {
        // No session-termination endpoint in the Atlas-V spec.
    }

    async getTransactions(_fromTime: number, _toTime: number, _page: number): Promise<TransactionListResult> {
        throw new AtlasVApiError({ message: 'Atlas-V has no transaction reporting API', statusCode: 501, code: 'ATLASV_NOT_SUPPORTED' })
    }

    async getTransactionDetail(_betId: string, _fromTime: number, _toTime: number): Promise<TransactionDetail> {
        throw new AtlasVApiError({ message: 'Atlas-V has no transaction reporting API', statusCode: 501, code: 'ATLASV_NOT_SUPPORTED' })
    }

    /** Atlas-V-specific: not part of the shared GameProviderGateway interface. */
    async createFreeSpins(playerId: string, endDate: string, freespinsCount: number): Promise<void> {
        await request(GAME_SERVER_URL, '/freespin', {
            casino_id: CASINO_ID,
            player_id: playerId,
            end_date: endDate,
            freespins_count: freespinsCount,
        })
    }
}
