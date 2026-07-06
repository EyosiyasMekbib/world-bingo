import type { ParsedReceipt, ExpectedDeposit, VerifyConfig, Decision } from './types'
import { normalizeName, amountsEqualCents, maskedNumberMatches } from './matching'

function isSuccess(status: string): boolean {
  const s = status.toLowerCase()
  return s.includes('complet') || s.includes('success')
}

export function evaluate(parsed: ParsedReceipt, expected: ExpectedDeposit, config: VerifyConfig): Decision {
  const reasons: string[] = []

  // 1. Status must be a success.
  if (!isSuccess(parsed.status)) reasons.push('BAD_STATUS')

  // 2. Receipt number must match the id we looked up.
  if (normalizeName(parsed.receiptNumber) !== normalizeName(expected.paymentTransactionId)) {
    reasons.push('ID_MISMATCH')
  }

  // 3. Receiver must be one of our active accounts (name AND masked number).
  const receiverOk = expected.activeAccounts.some(
    (a) =>
      normalizeName(a.name) === normalizeName(parsed.receiverName) &&
      maskedNumberMatches(a.account, parsed.receiverNumberMasked),
  )
  if (!receiverOk) reasons.push('RECEIVER_MISMATCH')

  // 4. Settled amount must equal the stated amount.
  if (!amountsEqualCents(parsed.settledAmount, expected.statedAmount)) reasons.push('AMOUNT_MISMATCH')

  // 5. Optional freshness window.
  if (config.maxAgeHours > 0) {
    if (!parsed.receiptTime) {
      reasons.push('STALE_RECEIPT')
    } else {
      const ageHours = (config.now.getTime() - parsed.receiptTime.getTime()) / 3_600_000
      if (ageHours > config.maxAgeHours) reasons.push('STALE_RECEIPT')
    }
  }

  // 6. Optional payer presence gate (name comparison to the depositing player is done upstream).
  if (config.requirePayerMatch) {
    if (!parsed.payerName) reasons.push('PAYER_MISMATCH')
  }

  // 7. Cap (only meaningful if the rest is clean).
  const overCap = parsed.settledAmount > config.maxAutoAmount
  if (reasons.length === 0 && overCap) reasons.push('OVER_CAP')

  if (reasons.length === 0) {
    return { decision: 'AUTO_CREDIT', creditAmount: parsed.settledAmount, reasons: ['CLEAN_MATCH'] }
  }
  return { decision: 'MANUAL', creditAmount: null, reasons }
}
