/**
 * What the withdrawal modal tells the player when the api refuses.
 *
 * The api's shared error handler answers `{ error: <status name>, message }`,
 * and the withdraw controller's own 409 answers `{ error: <message> }`. The
 * modal used to read `error` first, so a refusal with a real reason showed up
 * as "Forbidden" or "Error".
 */

/** WithdrawalHoldError in apps/api/src/services/wallet.service.ts. */
export const WITHDRAWAL_HOLD_CODE = 'withdrawal_hold_after_reset'

export function withdrawalErrorMessage(e: any, t: (key: string) => string): string {
  const data = e?.data
  // Localized copy, since the api's message is English. The copy names the
  // api's WITHDRAWAL_HOLD_AFTER_RESET_MS (24 hours); keep the two in step.
  if (data?.code === WITHDRAWAL_HOLD_CODE) return t('wallet.withdrawalHoldAfterReset')
  return data?.message ?? data?.error ?? e?.message ?? t('wallet.withdrawalFailed')
}
