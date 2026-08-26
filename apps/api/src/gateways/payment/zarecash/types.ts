/** Shapes from the ZareCash integration contract (/llms.txt + /v1/openapi.json). */

export type ZareCashMode = 'test' | 'live'
export type ZareCashDepositStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED'
export type ZareCashWithdrawalState =
  | 'pending'
  | 'queued_float'
  | 'risk_hold'
  | 'rejected'
  | 'approved'
  | 'cancelled'

export interface CreateDepositInput {
  playerRef: string
  amount: number
  methodCode: string
  receiptRef: string
  payerName?: string
  payerAccount?: string
}

export interface CreateWithdrawalInput {
  playerRef: string
  amount: number
  methodCode: string
  destinationAccount: string
  destinationName?: string
}

export interface ZareCashDeposit {
  id: string
  status: ZareCashDepositStatus
  playerRef: string
  mode: ZareCashMode
  statedAmount: number
  /** Null until a reviewer sets it. Always prefer this over the amount we sent. */
  approvedAmount: number | null
  amount: number
  receiptRef: string
  verdict: string
}

export interface ZareCashWithdrawal {
  id: string
  state: ZareCashWithdrawalState
  playerRef: string
  amount: number
  destinationAccount: string
  destinationName: string | null
  settlementRef: string | null
}

export interface ZareCashFloat {
  mode: ZareCashMode
  balance: number
  reserved: number
  available: number
  lowFloatThreshold: number
  queuedWithdrawals: number
}

export interface ZareCashEventEnvelope {
  id: string
  type: string
  created: number
  data: Record<string, unknown>
}

/**
 * `permanent` means retrying is pointless — the request will never succeed as
 * written. Workers refund a debited player on a permanent withdrawal failure and
 * retry on everything else.
 */
export class ZareCashError extends Error {
  readonly code: string
  readonly status: number
  readonly permanent: boolean
  readonly retryAfterSeconds?: number

  constructor(opts: {
    code: string
    message: string
    status: number
    permanent: boolean
    retryAfterSeconds?: number
  }) {
    super(opts.message)
    this.name = 'ZareCashError'
    this.code = opts.code
    this.status = opts.status
    this.permanent = opts.permanent
    this.retryAfterSeconds = opts.retryAfterSeconds
  }
}

/**
 * Errors that will never succeed on retry. `withdrawal_pending` is deliberately
 * absent: it means our state and ZareCash's disagree, which the sweep resolves —
 * refunding on it could double-pay a payout that is genuinely in flight.
 */
export const PERMANENT_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_amount',
  'idempotency_key_required',
  'method_unavailable',
  'amount_out_of_range',
  'player_frozen',
  'duplicate_receipt',
  'not_live',
])
