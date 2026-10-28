export interface IgcoreConfig {
    apiUrl: string
    apiVersion: string
    username: string
    password: string
    securityHash: string
    currency: string
    defaultLang: string
    maxWinAmount: number
    maxTicketPayout: number
    callbackDebug: boolean
    simulator: boolean
    simPublicUrl: string
    simCallbackUrl: string
}

/** A positive finite number from the environment, else the default. A typo in a cap must not turn into NaN, which compares false against everything. */
function positiveNumber(raw: string | undefined, fallback: number): number {
    const n = Number(raw || fallback)
    return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Read on every call, never memoised, so tests can stub the environment.
 * Every default uses `||`, not `??`: docker compose forwards an unset variable
 * as an empty string, and `??` would let that empty string through.
 */
export function igcoreConfig(): IgcoreConfig {
    const env = process.env
    return {
        apiUrl: env.IGCORE_API_URL || '',
        apiVersion: env.IGCORE_API_VERSION || '1.0.0',
        username: env.IGCORE_USERNAME || '',
        password: env.IGCORE_PASSWORD || '',
        securityHash: env.IGCORE_SECURITY_HASH || '',
        currency: env.IGCORE_CURRENCY || 'ETB',
        defaultLang: env.IGCORE_DEFAULT_LANG || 'en',
        maxWinAmount: positiveNumber(env.IGCORE_MAX_WIN_AMOUNT, 1_000_000),
        maxTicketPayout: positiveNumber(env.IGCORE_MAX_TICKET_PAYOUT, 1_000_000),
        callbackDebug: env.IGCORE_CALLBACK_DEBUG === 'true',
        simulator: env.IGCORE_SIMULATOR === 'true',
        simPublicUrl: env.IGCORE_SIM_PUBLIC_URL || env.API_BASE_URL || '',
        simCallbackUrl: env.IGCORE_SIM_CALLBACK_URL || `http://127.0.0.1:${env.PORT || 8080}/v1/igcore`,
    }
}

/** True once everything the outbound client and the callback verifier need is present. */
export function igcoreConfigured(cfg: IgcoreConfig = igcoreConfig()): boolean {
    return Boolean(cfg.apiUrl && cfg.username && cfg.password && cfg.securityHash)
}
