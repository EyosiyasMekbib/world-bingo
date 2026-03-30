// ─── Types ───────────────────────────────────────────────────────────────────

export interface Vendor {
    code: string
    name: string
    currencyCodes: string[]
    categoryCodes: string[]
}

export interface ProviderGameInfo {
    gameCode: string
    gameName: string
    categoryCode: string
    imageSquare: string | null
    imageLandscape: string | null
    languageCodes: string[]
    platformCodes: string[]
    currencyCodes: string[]
}

export interface GameListResult {
    games: ProviderGameInfo[]
    currentPage: number
    totalItems: number
    totalPages: number
}

export interface LaunchGameParams {
    username: string
    gameCode: string
    language: string
    platform: 'web' | 'H5'
    currency: string
    lobbyUrl: string
    ipAddress: string
}

export interface TransactionRecord {
    betId: string
    roundId: string
    externalTransactionId: string
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
    status: number
    vendorBetTime: number
    vendorSettleTime: number
    isFreeSpin: boolean
    vendorBetId: string
}

export interface TransactionListResult {
    transactions: TransactionRecord[]
    currentPage: number
    totalItems: number
    totalPages: number
}

export interface TransactionDetail extends TransactionRecord {
    detailUrl?: string
    refundAmount: number
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface GameProviderGateway {
    readonly providerCode: string

    getVendors(currency: string, language: string): Promise<Vendor[]>

    getGames(
        vendorCode: string,
        page: number,
        pageSize: number,
        currency: string,
        language: string,
    ): Promise<GameListResult>

    getGameUrl(params: LaunchGameParams): Promise<{ gameUrl: string; token: string }>

    terminateSession(username: string): Promise<void>

    getTransactions(fromTime: number, toTime: number, page: number): Promise<TransactionListResult>

    getTransactionDetail(betId: string, fromTime: number, toTime: number): Promise<TransactionDetail>
}
