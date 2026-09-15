/** The bucket the deposit_amount_entered event has always sent. Pure. */
export function amountBucket(amount: number): '<500' | '500-1000' | '1000-5000' | '5000+' {
  const n = Number(amount)
  if (!(n >= 500)) return '<500'
  if (n < 1000) return '500-1000'
  if (n < 5000) return '1000-5000'
  return '5000+'
}

export type DepositFormField = 'amount' | 'transactionId' | 'senderName' | 'senderAccount' | 'receipt'

/** The floors DepositModal's Submit enforced while disabled, as a list the page can show. Pure. */
export function missingDepositFields(
  form: { amount: number; transactionId: string; senderName: string; senderAccount: string },
  hasReceipt: boolean,
  minDeposit: number,
): DepositFormField[] {
  const missing: DepositFormField[] = []
  if (!(Number(form.amount) >= minDeposit)) missing.push('amount')
  if (form.transactionId.trim().length < 5) missing.push('transactionId')
  if (form.senderName.trim().length < 1) missing.push('senderName')
  if (form.senderAccount.trim().length < 10) missing.push('senderAccount')
  if (!hasReceipt) missing.push('receipt')
  return missing
}

export const SENDER_NAME_KEY = 'wb_deposit_sender_name'

/** The payer name from this browser's last submitted deposit, or ''. Storage access can throw. */
export function recallSenderName(): string {
  try {
    return localStorage.getItem(SENDER_NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

export function rememberSenderName(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  try {
    localStorage.setItem(SENDER_NAME_KEY, trimmed.slice(0, 100))
  } catch {
    // Storage unavailable: the player types it next time.
  }
}
