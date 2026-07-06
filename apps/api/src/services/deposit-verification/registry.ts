import type { DepositVerifier } from './types'
import { TelebirrReceiptVerifier } from '../../gateways/payment/telebirr-receipt.verifier'

const telebirr = new TelebirrReceiptVerifier()

/** Method codes that map to the telebirr receipt verifier. */
const TELEBIRR_CODES = new Set(['telebirr', 'ethiotelecom'])

export function getVerifier(methodCode: string | null | undefined): DepositVerifier | null {
  if (!methodCode) return null
  return TELEBIRR_CODES.has(methodCode.toLowerCase()) ? telebirr : null
}
