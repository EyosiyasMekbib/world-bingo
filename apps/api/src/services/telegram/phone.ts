/**
 * Ethiopian phone normalisation for the Telegram shared-contact link flow.
 *
 * Registration stores `phone` exactly as the player typed it (no
 * normalisation happens there today — see CLAUDE.md), so three different
 * players could have "0912345678", "912345678" or "+251912345678" sitting
 * in the same column for what is the same number. Telegram, by contrast,
 * always hands back a single canonical form from `contact.phone_number`
 * (country code, digits only, no `+`). Matching therefore has to go the
 * OTHER way: normalise what Telegram sent, then generate every raw form a
 * player might have typed, and look up all of them.
 */

/** Canonical form: "251" + 9-digit subscriber number, digits only. */
export type CanonicalPhone = string & { readonly __brand: 'CanonicalPhone' }

/** Ethiopian mobile subscriber numbers start with 9 (most carriers) or 7
 *  (Safaricom Ethiopia and newer ranges). Anything else is not a mobile
 *  number this flow can match. */
const MOBILE_PREFIX = /^[79]\d{8}$/

/**
 * Normalises any of the forms a player or Telegram might supply into
 * "251XXXXXXXXX", or returns null when the input is not a recognisable
 * Ethiopian mobile number. Never throws — every caller is handling
 * user-supplied text.
 */
export function normalizeEthiopianPhone(raw: string | null | undefined): CanonicalPhone | null {
  if (!raw) return null
  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) return null

  let subscriber: string | null = null
  if (digits.startsWith('251') && digits.length === 12) {
    subscriber = digits.slice(3)
  } else if (digits.startsWith('0') && digits.length === 10) {
    subscriber = digits.slice(1)
  } else if (digits.length === 9) {
    subscriber = digits
  }

  if (!subscriber || !MOBILE_PREFIX.test(subscriber)) return null
  return (`251${subscriber}`) as CanonicalPhone
}

/**
 * Every raw form a player could plausibly have typed into the registration
 * field for this canonical number — what AuthService.register stores
 * verbatim, unnormalised. Used to build a `phone IN (...)` match.
 */
export function candidateRawForms(canonical: CanonicalPhone): string[] {
  const subscriber = canonical.slice(3)
  return [canonical, `+${canonical}`, `0${subscriber}`, subscriber]
}

/** Last 4 digits only — what the staff Telegram topic header shows. The
 *  full number is deliberately never posted into the group (see
 *  docs/telegram-support-bot.md §7.3). */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return 'no phone on file'
  const digits = phone.replace(/[^\d]/g, '')
  if (digits.length < 4) return '••••'
  return `••••${digits.slice(-4)}`
}
