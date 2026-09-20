/**
 * The agent API contract. Every money figure is a decimal STRING and is kept
 * that way all the way to the screen; see utils/money.ts.
 */

export type AgentProfile = {
  id: string
  shopName: string
  displayName: string
  float: string
  today: { count: number; volume: string }
  limits: { min: string; max: string }
}

export type DepositRequest = {
  code: string
  amount: string
  expiresAt: string
  player: {
    name: string
    phoneTail: string
    since: string
    depositCount: number
  }
}

export type FulfillResult = {
  reference: string
  amount: string
  code: string
  fulfilledAt: string
  floatAfter: string
  player: { name: string }
}

export type LedgerType = 'TOP_UP' | 'COMMISSION' | 'FULFILLMENT' | 'ADJUSTMENT'

export type LedgerRow = {
  id: string
  type: LedgerType
  amount: string
  balanceAfter: string
  note?: string | null
  createdAt: string
  requestCode?: string | null
  playerMaskedName?: string | null
  actorName?: string | null
}

export type LedgerResponse = {
  rows: LedgerRow[]
  total: number
  summary: {
    fulfilled7d: string
    deposits7d: string
    toppedUp7d: string
    float: string
  }
}

export type LedgerQuery = {
  from?: string
  to?: string
  type?: LedgerType | ''
  page?: number
  pageSize?: number
}

/**
 * The four refusals the counter screen has to explain, plus a catch-all.
 * The API signals them with an HTTP status and an `error` code in the body;
 * both are read, because a proxy that mangles one rarely mangles the other.
 */
export type AgentRefusal =
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_FULFILLED'; fulfilledAt?: string }
  | { kind: 'EXPIRED'; expiredAt?: string }
  | { kind: 'INSUFFICIENT_FLOAT'; float?: string; required?: string }
  | { kind: 'UNKNOWN'; message: string }

type ErrorBody = {
  error?: string
  message?: string
  fulfilledAt?: string
  expiredAt?: string
  float?: string
  required?: string
}

export const toAgentRefusal = (error: unknown, fallback: string): AgentRefusal => {
  const err = error as { statusCode?: number; status?: number; data?: ErrorBody } | undefined
  const body = err?.data ?? {}
  const status = err?.statusCode ?? err?.status
  const code = body.error ?? ''

  if (code === 'NOT_FOUND' || status === 404) return { kind: 'NOT_FOUND' }
  if (code === 'ALREADY_FULFILLED' || status === 409) {
    return { kind: 'ALREADY_FULFILLED', fulfilledAt: body.fulfilledAt }
  }
  if (code === 'EXPIRED' || status === 410) {
    return { kind: 'EXPIRED', expiredAt: body.expiredAt }
  }
  if (code === 'INSUFFICIENT_FLOAT' || status === 422) {
    return { kind: 'INSUFFICIENT_FLOAT', float: body.float, required: body.required }
  }
  return { kind: 'UNKNOWN', message: body.message || body.error || fallback }
}

export const useAgentApi = () => {
  const { apiFetch } = useAgentAuth()

  return {
    getProfile: () => apiFetch<AgentProfile>('/agent/me'),

    lookupRequest: (code: string) =>
      apiFetch<DepositRequest>(`/agent/requests/${encodeURIComponent(code)}`),

    fulfillRequest: (code: string) =>
      apiFetch<FulfillResult>(`/agent/requests/${encodeURIComponent(code)}/fulfill`, {
        method: 'POST',
      }),

    getLedger: (query: LedgerQuery = {}) => {
      const params = new URLSearchParams()
      if (query.from) params.set('from', query.from)
      if (query.to) params.set('to', query.to)
      if (query.type) params.set('type', query.type)
      params.set('page', String(query.page ?? 1))
      params.set('pageSize', String(query.pageSize ?? 25))
      return apiFetch<LedgerResponse>(`/agent/ledger?${params.toString()}`)
    },
  }
}
