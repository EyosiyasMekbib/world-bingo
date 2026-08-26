/**
 * ZareCash HTTP client.
 *
 * Knows the contract and nothing about our domain. Every mutating call takes a
 * caller-supplied Idempotency-Key — derived from our own transaction id, so a
 * retry is always safe.
 */

import { zarecashConfig, type ZareCashConfig } from './config.js'
import {
  ZareCashError,
  PERMANENT_ERROR_CODES,
  type CreateDepositInput,
  type CreateWithdrawalInput,
  type ZareCashDeposit,
  type ZareCashWithdrawal,
  type ZareCashFloat,
  type ZareCashEventEnvelope,
} from './types.js'

/** Drops undefined values so we never send `"destinationName": undefined`. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

export class ZareCashClient {
  private readonly cfg: ZareCashConfig

  constructor(cfg?: ZareCashConfig) {
    this.cfg = cfg ?? zarecashConfig()
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; expectBody?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { 'x-api-key': this.cfg.apiKey }
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs)

    let res: Response
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      })
    } catch (err) {
      throw new ZareCashError({
        code: 'network_error',
        message: (err as Error)?.message ?? 'request failed',
        status: 0,
        permanent: false,
      })
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    const parsed: any = text ? safeJson(text) : null

    if (!res.ok) {
      const code = parsed?.error ?? `http_${res.status}`
      const retryHeader = res.headers.get('retry-after')
      throw new ZareCashError({
        code,
        message: parsed?.message ?? `ZareCash ${method} ${path} failed with ${res.status}`,
        status: res.status,
        permanent: PERMANENT_ERROR_CODES.has(code),
        retryAfterSeconds:
          parsed?.retryAfterSeconds ?? (retryHeader ? Number(retryHeader) : undefined),
      })
    }

    // A 2xx whose body is empty or unparseable is NOT a success we can act on.
    // Returning `null as T` here pushed a lie into every caller: `assertMode`
    // read `float.mode` off it and died on a TypeError, which — sitting inside
    // index.ts's exit-on-throw block — took the whole API down over a truncated
    // response from a payment provider. Fail here, at the source, as the
    // retryable transport fault it actually is.
    if (parsed === null && opts.expectBody !== false) {
      throw new ZareCashError({
        code: 'invalid_response',
        message: `ZareCash ${method} ${path} returned ${res.status} with an empty or unparseable body`,
        status: res.status,
        permanent: false,
      })
    }

    return parsed as T
  }

  createDeposit(input: CreateDepositInput, idempotencyKey: string): Promise<ZareCashDeposit> {
    return this.request<ZareCashDeposit>('POST', '/v1/deposits', {
      body: compact(input as any),
      idempotencyKey,
    })
  }

  createWithdrawal(
    input: CreateWithdrawalInput,
    idempotencyKey: string,
  ): Promise<ZareCashWithdrawal> {
    return this.request<ZareCashWithdrawal>('POST', '/v1/withdrawals', {
      body: compact(input as any),
      idempotencyKey,
    })
  }

  getFloat(): Promise<ZareCashFloat> {
    return this.request<ZareCashFloat>('GET', '/v1/float')
  }

  listEvents(params: { cursor?: string; limit?: number } = {}): Promise<{
    data: ZareCashEventEnvelope[]
    nextCursor: string | null
  }> {
    const qs = new URLSearchParams()
    if (params.cursor) qs.set('cursor', params.cursor)
    qs.set('limit', String(params.limit ?? 100))
    return this.request('GET', `/v1/events?${qs.toString()}`)
  }

  // Freeze/unfreeze are fire-and-forget containment calls whose response body we
  // never read, so an empty one is genuinely fine — they opt out of the
  // empty-body check the value-returning calls above depend on.
  freezePlayer(ref: string, reason: string): Promise<unknown> {
    return this.request('POST', `/v1/players/${encodeURIComponent(ref)}/freeze`, {
      body: { reason },
      idempotencyKey: `freeze_${ref}_${Date.now()}`,
      expectBody: false,
    })
  }

  unfreezePlayer(ref: string, reason: string): Promise<unknown> {
    return this.request('POST', `/v1/players/${encodeURIComponent(ref)}/unfreeze`, {
      body: { reason },
      idempotencyKey: `unfreeze_${ref}_${Date.now()}`,
      expectBody: false,
    })
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

let singleton: ZareCashClient | null = null
export function zarecashClient(): ZareCashClient {
  if (!singleton) singleton = new ZareCashClient()
  return singleton
}
/** Test seam — drops the cached singleton so a new config is picked up. */
export function resetZareCashClient(): void {
  singleton = null
}
