export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function amountsEqualCents(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100)
}

export function parseReceiptAmount(raw: string): number | null {
  if (!raw) return null
  const cleaned = raw.replace(/,/g, '').replace(/[^0-9.]/g, ' ').trim()
  const m = cleaned.match(/[0-9]+(?:\.[0-9]+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

export function parseReceiptDate(raw: string): Date | null {
  if (!raw) return null
  const m = raw.trim().match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return null
  const [, dd, mm, yyyy, hh, mi, ss] = m
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Reduce any Ethiopian phone/merchant number to its national 9-digit core (drops 251 / leading 0). */
function digitsCore(num: string): string {
  const digits = (num || '').replace(/\D/g, '')
  if (digits.startsWith('251')) return digits.slice(3)
  if (digits.startsWith('0')) return digits.slice(1)
  return digits
}

/**
 * Masked receipt numbers look like "2519****2107": a visible prefix, masked middle,
 * visible last-4. We match by comparing the visible prefix and last-4 against our
 * stored full number (after normalizing both to the 9-digit national core plus the
 * 251 country code that the receipt shows).
 */
export function maskedNumberMatches(fullAccount: string, masked: string): boolean {
  if (!fullAccount || !masked) return false
  const maskMatch = masked.replace(/\s/g, '').match(/^(\d+)\*+(\d+)$/)
  if (!maskMatch) return false
  const [, prefix, suffix] = maskMatch

  // Full country-code form the receipt uses: 251 + 9-digit national core.
  const full = '251' + digitsCore(fullAccount)
  return full.startsWith(prefix) && full.endsWith(suffix)
}
