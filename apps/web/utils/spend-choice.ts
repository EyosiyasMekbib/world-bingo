/**
 * Which balance a provider game plays from. The backend reads
 * `wallet.spendAccount` on every provider callback and never falls back to the
 * other bucket, so the play page asks before launch whenever the player has a
 * bonus to choose from. Balances arrive as numbers or Decimal strings.
 */
export type SpendAccount = 'REAL' | 'BONUS'

export interface SpendWallet {
  realBalance: number | string
  bonusBalance: number | string
  spendAccount: SpendAccount
}

function balanceOf(wallet: SpendWallet, account: SpendAccount): number {
  return Number(account === 'BONUS' ? wallet.bonusBalance : wallet.realBalance) || 0
}

/** With no bonus there is nothing to choose: launch straight in. */
export function needsSpendChoice(wallet: SpendWallet | null | undefined): boolean {
  return !!wallet && balanceOf(wallet, 'BONUS') > 0
}

export function canSpend(wallet: SpendWallet, account: SpendAccount): boolean {
  return balanceOf(wallet, account) > 0
}

/** The current toggle, unless that bucket is empty and the other is not. */
export function preselectedAccount(wallet: SpendWallet): SpendAccount {
  const current = wallet.spendAccount
  const other: SpendAccount = current === 'BONUS' ? 'REAL' : 'BONUS'
  return !canSpend(wallet, current) && canSpend(wallet, other) ? other : current
}
