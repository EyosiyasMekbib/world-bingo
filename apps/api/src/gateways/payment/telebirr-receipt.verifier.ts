import type { DepositVerifier, ParsedReceipt, VerifyUnavailable } from '../../services/deposit-verification/types'
import { parseReceiptHtml } from '../../services/deposit-verification/telebirr-parser'
import { fetchReceiptHtml, type FetchReason } from '../../services/deposit-verification/receipt-fetcher'

type Fetcher = (id: string) => Promise<{ ok: true; html: string } | { ok: false; reason: FetchReason }>

export class TelebirrReceiptVerifier implements DepositVerifier {
  readonly code = 'telebirr'
  constructor(private readonly fetcher: Fetcher = fetchReceiptHtml) {}

  async verify(transactionId: string): Promise<ParsedReceipt | VerifyUnavailable> {
    const res = await this.fetcher(transactionId)
    // `in`-narrowing (not boolean-discriminant) so it holds under strictNullChecks:false.
    if ('reason' in res) return { unavailable: res.reason }
    return parseReceiptHtml(res.html)
  }
}
