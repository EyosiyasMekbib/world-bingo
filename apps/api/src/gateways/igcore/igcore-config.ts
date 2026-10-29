import { createHmac } from 'node:crypto'

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

/**
 * A cap from the environment: a finite number >= 0, else the default. `0`
 * passes through and means the cap is disabled. The value is trimmed first,
 * because `Number('  ')` is 0 and a blank variable must not silently disable
 * the cap. A typo must not become NaN either, which compares false against
 * everything and would also leave the cap off.
 */
function capFromEnv(raw: string | undefined, fallback: number): number {
    const trimmed = (raw ?? '').trim()
    if (!trimmed) return fallback
    const n = Number(trimmed)
    return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * A simulator-mode secret, derived from the JWT signing key. In simulator mode
 * the API plays both sides of the protocol, so it needs no IGCORE_* secrets of
 * its own, and every replica already shares the signing key. The HMAC keeps
 * the key itself out of the derived values. The key is used as configured
 * (base64 or raw, the same preference as lib/jwt-keys.ts): only equality across
 * replicas matters. Empty without a key, which leaves the integration
 * unconfigured.
 */
function simSecret(env: NodeJS.ProcessEnv, label: string): string {
    const key = env.JWT_PRIVATE_KEY_BASE64 || env.JWT_PRIVATE_KEY
    return key ? createHmac('sha256', key).update(`igcore-sim:${label}`).digest('hex') : ''
}

/**
 * Read on every call, never memoised, so tests can stub the environment.
 * Every default uses `||`, not `??`: docker compose forwards an unset variable
 * as an empty string, and `??` would let that empty string through.
 *
 * With IGCORE_SIMULATOR on, an unset API URL points at the local simulator and
 * unset credentials are derived (simSecret), so staging needs no env of its
 * own. Explicit values always win. No production compose file declares
 * IGCORE_SIMULATOR (compose-guard.test.ts), so production never derives.
 */
export function igcoreConfig(): IgcoreConfig {
    const env = process.env
    const simulator = env.IGCORE_SIMULATOR === 'true'
    return {
        apiUrl: env.IGCORE_API_URL || (simulator ? `http://127.0.0.1:${env.PORT || 8080}/v1/igcore-sim` : ''),
        apiVersion: env.IGCORE_API_VERSION || '1.0.0',
        username: env.IGCORE_USERNAME || (simulator ? 'igcore-sim' : ''),
        password: env.IGCORE_PASSWORD || (simulator ? simSecret(env, 'password') : ''),
        securityHash: env.IGCORE_SECURITY_HASH || (simulator ? simSecret(env, 'security-hash') : ''),
        currency: env.IGCORE_CURRENCY || 'ETB',
        defaultLang: env.IGCORE_DEFAULT_LANG || 'en',
        maxWinAmount: capFromEnv(env.IGCORE_MAX_WIN_AMOUNT, 1_000_000),
        maxTicketPayout: capFromEnv(env.IGCORE_MAX_TICKET_PAYOUT, 1_000_000),
        callbackDebug: env.IGCORE_CALLBACK_DEBUG === 'true',
        simulator,
        simPublicUrl: env.IGCORE_SIM_PUBLIC_URL || env.API_BASE_URL || '',
        simCallbackUrl: env.IGCORE_SIM_CALLBACK_URL || `http://127.0.0.1:${env.PORT || 8080}/v1/igcore`,
    }
}

/** True once everything the outbound client and the callback verifier need is present. */
export function igcoreConfigured(cfg: IgcoreConfig = igcoreConfig()): boolean {
    return Boolean(cfg.apiUrl && cfg.username && cfg.password && cfg.securityHash)
}
