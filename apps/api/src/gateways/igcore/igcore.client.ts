import redis from '../../lib/redis.js'
import { igcoreConfig, igcoreConfigured } from './igcore-config.js'

const TOKEN_KEY = 'igcore:token'
const REQUEST_TIMEOUT_MS = 10_000
const MIN_TOKEN_TTL_S = 60
/** Refresh this long before IGCORE would expire the token. */
const TOKEN_SAFETY_MARGIN_S = 300
const MAX_ERROR_BODY_CHARS = 200

/**
 * `code` is IGCORE's own `error` string verbatim (`invalid params`,
 * `currency is not allowed`, `Unauthorized`, ...), or one of ours:
 * `NOT_CONFIGURED`, `HTTP_<status>`, `NETWORK`, `BAD_RESPONSE`.
 */
export class IgcoreApiError extends Error {
    readonly code: string

    constructor(code: string, message?: string) {
        super(message ?? `IGCORE error: ${code}`)
        this.name = 'IgcoreApiError'
        this.code = code
    }
}

function isUnauthorized(data: unknown): boolean {
    return (data as { error?: unknown } | null)?.error === 'Unauthorized'
}

/** Throws the operator's own error string, if the body carries one. */
function throwIfOperatorError(data: unknown): void {
    const error = (data as { error?: unknown } | null)?.error
    if (typeof error === 'string' && error) throw new IgcoreApiError(error)
}

export class IgcoreClient {
    private baseUrl(): string {
        const cfg = igcoreConfig()
        return `${cfg.apiUrl.replace(/\/+$/, '')}/${cfg.apiVersion}`
    }

    private assertConfigured(): void {
        if (!igcoreConfigured()) {
            throw new IgcoreApiError(
                'NOT_CONFIGURED',
                'IGCORE is not configured: set IGCORE_API_URL, IGCORE_USERNAME, IGCORE_PASSWORD and IGCORE_SECURITY_HASH',
            )
        }
    }

    /**
     * One JSON POST. Returns the parsed body, which may itself be an
     * `{ error }` answer: IGCORE reports Unauthorized and operator refusals with
     * HTTP 200. Transport failures and non-2xx statuses throw here.
     */
    private async post(path: string, body: Record<string, unknown>, token?: string): Promise<unknown> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (token) headers.Authorization = `Bearer ${token}`

        let res: Response
        try {
            res = await fetch(`${this.baseUrl()}${path}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
        } catch (err: any) {
            throw new IgcoreApiError('NETWORK', `IGCORE is unreachable: ${err?.message ?? 'network error'}`)
        }

        if (!res.ok) {
            // IGCORE answers 400/404/500 with an empty body; keep whatever does come back, trimmed.
            let bodyText = ''
            try {
                bodyText = await res.text()
            } catch {
                // No readable body: report the bare status.
            }
            throw new IgcoreApiError(
                `HTTP_${res.status}`,
                `IGCORE ${path} returned HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, MAX_ERROR_BODY_CHARS)}` : ''}`,
            )
        }

        try {
            return await res.json()
        } catch {
            throw new IgcoreApiError('BAD_RESPONSE', `IGCORE ${path} returned a non-JSON response`)
        }
    }

    /**
     * The bearer token, from Redis when cached. `force` skips the cache and
     * always authenticates, replacing whatever was cached.
     */
    async getToken(force = false): Promise<string> {
        this.assertConfigured()

        if (!force) {
            const cached = await redis.get(TOKEN_KEY)
            if (cached) return cached
        }

        const cfg = igcoreConfig()
        const data = (await this.post('/auth', { username: cfg.username, password: cfg.password })) as {
            token?: unknown
            expires_in?: unknown
            error?: unknown
        } | null
        throwIfOperatorError(data)
        if (!data || typeof data.token !== 'string' || !data.token) {
            throw new IgcoreApiError('BAD_RESPONSE', 'IGCORE /auth returned no token')
        }

        const expiresIn = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) ? data.expires_in : 0
        const ttl = Math.max(MIN_TOKEN_TTL_S, Math.floor(expiresIn) - TOKEN_SAFETY_MARGIN_S)
        await redis.setex(TOKEN_KEY, ttl, data.token)
        return data.token
    }

    /**
     * An authenticated call. A missing or expired token answers HTTP 200
     * `{"error":"Unauthorized"}`: drop the cached token, authenticate afresh
     * and repeat once. A second Unauthorized is a real refusal and throws.
     */
    private async authed(path: string, body: Record<string, unknown>): Promise<unknown> {
        let data = await this.post(path, body, await this.getToken())
        if (isUnauthorized(data)) {
            await redis.del(TOKEN_KEY)
            data = await this.post(path, body, await this.getToken(true))
        }
        throwIfOperatorError(data)
        return data
    }

    /** Opens a player session. The returned `url` is what the player's iframe loads. */
    async startSession(p: { userId: string; currency: string; lang?: string }): Promise<{ url: string }> {
        this.assertConfigured()
        const data = (await this.authed('/start-session', {
            user_id: p.userId,
            currency: p.currency,
            lang: p.lang || igcoreConfig().defaultLang,
        })) as { url?: unknown } | null
        if (!data || typeof data.url !== 'string' || !data.url) {
            throw new IgcoreApiError('BAD_RESPONSE', 'IGCORE /start-session returned no url')
        }
        return { url: data.url }
    }
}
