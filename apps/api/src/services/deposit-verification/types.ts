export interface ParsedReceipt {
  receiverName: string
  receiverNumberMasked: string
  settledAmount: number
  totalPaid: number | null
  status: string
  receiptNumber: string
  receiptTime: Date | null
  payerName: string | null
  payerNumberMasked: string | null
}

export type VerifyUnavailableReason =
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UNREACHABLE'
  | 'PARSE_FAILED'
  | 'PIN_MISMATCH'

export interface VerifyUnavailable {
  unavailable: VerifyUnavailableReason
}

export function isUnavailable(r: ParsedReceipt | VerifyUnavailable): r is VerifyUnavailable {
  return (r as VerifyUnavailable).unavailable !== undefined
}

export interface DepositVerifier {
  code: string
  verify(transactionId: string): Promise<ParsedReceipt | VerifyUnavailable>
  /**
   * Parse already-fetched receipt markup (e.g. supplied by an in-Ethiopia
   * approver's browser) WITHOUT performing the network fetch. Same parse path
   * `verify` uses on the bytes it fetches itself.
   */
  parse(html: string): ParsedReceipt | VerifyUnavailable
}

export interface ActiveAccount {
  name: string
  account: string
}

export interface ExpectedDeposit {
  statedAmount: number
  paymentTransactionId: string
  activeAccounts: ActiveAccount[]
}

export interface VerifyConfig {
  maxAutoAmount: number
  maxAgeHours: number
  requirePayerMatch: boolean
  now: Date
}

export interface Decision {
  decision: 'AUTO_CREDIT' | 'MANUAL'
  creditAmount: number | null
  reasons: string[]
}
