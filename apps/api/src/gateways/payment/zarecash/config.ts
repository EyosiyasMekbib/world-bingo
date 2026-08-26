/**
 * ZareCash configuration.
 *
 * Read lazily (not at module load) so dotenv has run first, matching the
 * pattern in gateways/game-provider/signature.middleware.ts.
 */

export interface ZareCashConfig {
    enabled: boolean
    baseUrl: string
    apiKey: string
    webhookSecret: string
    mode: 'test' | 'live'
    timeoutMs: number
}

export function isZareCashEnabled(): boolean {
    return (process.env.ZARECASH_ENABLED ?? '').trim().toLowerCase() === 'true'
}

export function zarecashConfig(): ZareCashConfig {
    const enabled = isZareCashEnabled()
    const baseUrl = (process.env.ZARECASH_BASE_URL ?? 'https://api.zarecash.com').trim().replace(/\/+$/, '')
    const apiKey = (process.env.ZARECASH_API_KEY ?? '').trim()
    const webhookSecret = (process.env.ZARECASH_WEBHOOK_SECRET ?? '').trim()
    const mode = (process.env.ZARECASH_MODE ?? 'test').trim()
    const timeoutMs = Number(process.env.ZARECASH_TIMEOUT_MS ?? '10000')

    if (enabled) {
        if (!apiKey) throw new Error('ZARECASH_API_KEY is required when ZARECASH_ENABLED=true')
        if (!webhookSecret) throw new Error('ZARECASH_WEBHOOK_SECRET is required when ZARECASH_ENABLED=true')
        if (mode !== 'test' && mode !== 'live') {
            throw new Error(`ZARECASH_MODE must be "test" or "live", got "${mode}"`)
        }
    }

    return { enabled, baseUrl, apiKey, webhookSecret, mode: mode as 'test' | 'live', timeoutMs }
}
