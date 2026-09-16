/**
 * Ethiopian phone-number shapes, shared by the API and both Nuxt apps.
 *
 * Firebase phone sign-in speaks E.164 and nothing else: the browser must send
 * `+251911234567` to request an SMS, and the ID token comes back carrying the
 * same spelling. Accounts in this database predate that and hold whatever the
 * player typed at registration — `0911234567`, `911234567`, `251911234567` and
 * `+251911234567` all exist in production today.
 *
 * So there are two jobs here, and they are opposite ends of the same map:
 *  - `toE164` turns whatever a player types into the one spelling Firebase
 *    accepts.
 *  - `phoneVariants` turns a verified E.164 number back into every spelling an
 *    existing row might be stored under, so a returning player is matched to
 *    their account instead of being handed a second, empty one.
 *
 * Both brands (arada, betbawa) are Ethiopia-only, which is what makes the
 * local-format expansion safe to do without a full libphonenumber dependency.
 * A number that is not recognisably Ethiopian is passed through untouched
 * rather than guessed at.
 */

/** Ethiopia. The one country code these helpers expand local spellings for. */
export const ET_DIAL_CODE = '251'

/** `9XXXXXXXX` / `7XXXXXXXX` — the national part, without trunk prefix. */
const ET_NATIONAL_DIGITS = 9

/** Digits only, with every separator, bracket and leading `+` dropped. */
export function phoneDigits(raw: string | null | undefined): string {
    return (raw ?? '').replace(/\D/g, '')
}

/**
 * The Ethiopian national number (`911234567`) behind any spelling, or null when
 * the input is not one. Deliberately strict — it is what every other helper
 * here keys off, and a loose reading of it would link accounts that are not the
 * same person.
 */
export function etNationalNumber(raw: string | null | undefined): string | null {
    const digits = phoneDigits(raw)

    // 251911234567 / +251911234567
    if (digits.length === ET_DIAL_CODE.length + ET_NATIONAL_DIGITS && digits.startsWith(ET_DIAL_CODE)) {
        return digits.slice(ET_DIAL_CODE.length)
    }
    // 0911234567 — the trunk-prefixed form players type
    if (digits.length === ET_NATIONAL_DIGITS + 1 && digits.startsWith('0')) {
        return digits.slice(1)
    }
    // 911234567 — bare national number
    if (digits.length === ET_NATIONAL_DIGITS) return digits

    return null
}

/**
 * E.164 (`+251911234567`) for anything recognisably Ethiopian, otherwise null.
 * The web app calls this on what the player typed before handing it to
 * Firebase, so a `09…` entry and a `+251…` entry request the same SMS.
 */
export function toE164(raw: string | null | undefined): string | null {
    const national = etNationalNumber(raw)
    if (national) return `+${ET_DIAL_CODE}${national}`

    // Already international and not Ethiopian: keep it, but only if it looks
    // like an E.164 number at all. Guessing a country code for a bare local
    // number from somewhere else would be worse than refusing.
    const trimmed = (raw ?? '').trim()
    if (/^\+\d{8,15}$/.test(trimmed)) return trimmed

    return null
}

/**
 * Every spelling of `raw` that a `users.phone` row could plausibly hold, for an
 * exact-match lookup (`{ phone: { in: phoneVariants(x) } }`).
 *
 * Exact match against this list, never a `contains` — a suffix match on nine
 * digits is how one player gets signed into another player's account.
 */
export function phoneVariants(raw: string | null | undefined): string[] {
    const trimmed = (raw ?? '').trim()
    if (!trimmed) return []

    const variants = new Set<string>([trimmed])

    const national = etNationalNumber(trimmed)
    if (national) {
        variants.add(national)
        variants.add(`0${national}`)
        variants.add(`${ET_DIAL_CODE}${national}`)
        variants.add(`+${ET_DIAL_CODE}${national}`)
        return [...variants]
    }

    // Non-Ethiopian: only the two spellings that are the same number by
    // definition, never a re-parse.
    const digits = phoneDigits(trimmed)
    if (digits.length >= 8) {
        variants.add(digits)
        variants.add(`+${digits}`)
    }
    return [...variants]
}

/**
 * `0911 234 567` for display. Falls back to the input when the number is not
 * Ethiopian, so nothing is ever shown mangled.
 */
export function formatEtPhone(raw: string | null | undefined): string {
    const national = etNationalNumber(raw)
    if (!national) return (raw ?? '').trim()
    return `0${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`
}
