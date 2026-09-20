/**
 * Money formatting for values the API sends as decimal STRINGS.
 *
 * Nothing here parses a value into a JavaScript number. `0.1 + 0.2` is the
 * reason: an agent's float and a player's deposit are the same money, and a
 * figure that drifts by a hundredth on screen is a figure the shop will argue
 * about. The string is split on the decimal point and regrouped as text, so
 * what is displayed is exactly what the API said, only easier to read.
 */

type MoneyParts = {
  negative: boolean
  whole: string
  fraction: string
}

const splitAmount = (value: string): MoneyParts | null => {
  const raw = (value ?? '').trim()
  if (!raw) return null

  const negative = raw.startsWith('-')
  const unsigned = raw.replace(/^[+-]/, '')
  if (!/^\d*(\.\d*)?$/.test(unsigned) || unsigned === '' || unsigned === '.') return null

  const [wholeRaw = '', fractionRaw = ''] = unsigned.split('.')
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0'
  const fraction = `${fractionRaw}00`.slice(0, 2)

  return { negative, whole, fraction }
}

const groupThousands = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/**
 * "12345.5" -> "12,345.50". Returns the fallback for anything that is not a
 * plain decimal, so a surprise from the API shows as a dash rather than NaN.
 */
export const formatMoney = (value: string | null | undefined, fallback = '-'): string => {
  const parts = splitAmount(value ?? '')
  if (!parts) return fallback
  return `${parts.negative ? '-' : ''}${groupThousands(parts.whole)}.${parts.fraction}`
}

/** Same, with the currency suffix the shop reads out loud. */
export const formatBirr = (value: string | null | undefined, fallback = '-'): string => {
  const formatted = formatMoney(value, '')
  return formatted ? `${formatted} ETB` : fallback
}

/**
 * A whole-number tally (a row count, not an amount). Grouped the same way so a
 * column of counts lines up with the column of money beside it.
 */
export const formatCount = (value: string | number | null | undefined, fallback = '-'): string => {
  if (value === null || value === undefined || value === '') return fallback
  const raw = String(value).trim()
  if (!/^-?\d+$/.test(raw)) {
    // Not an integer: it is probably a decimal amount after all, so show it
    // as money rather than as a dash.
    return formatMoney(raw, fallback)
  }
  const negative = raw.startsWith('-')
  return `${negative ? '-' : ''}${groupThousands(raw.replace('-', ''))}`
}

/** Always carries an explicit sign, for ledger rows. */
export const formatSigned = (value: string | null | undefined, fallback = '-'): string => {
  const parts = splitAmount(value ?? '')
  if (!parts) return fallback
  const isZero = parts.whole === '0' && parts.fraction === '00'
  const sign = isZero ? '' : parts.negative ? '-' : '+'
  return `${sign}${groupThousands(parts.whole)}.${parts.fraction}`
}

/** True when the string is a negative, non-zero amount. */
export const isNegativeAmount = (value: string | null | undefined): boolean => {
  const parts = splitAmount(value ?? '')
  if (!parts) return false
  return parts.negative && !(parts.whole === '0' && parts.fraction === '00')
}

/**
 * Subtract one decimal string from another without touching floats, so the
 * "float after" preview on the confirm panel matches the figure the API will
 * return. Both sides are scaled to integer hundredths via BigInt.
 */
const toHundredths = (value: string): bigint | null => {
  const parts = splitAmount(value)
  if (!parts) return null
  const magnitude = BigInt(`${parts.whole}${parts.fraction}`)
  return parts.negative ? -magnitude : magnitude
}

const fromHundredths = (value: bigint): string => {
  const negative = value < 0n
  const magnitude = (negative ? -value : value).toString().padStart(3, '0')
  const whole = magnitude.slice(0, -2)
  const fraction = magnitude.slice(-2)
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

export const subtractMoney = (
  a: string | null | undefined,
  b: string | null | undefined,
): string | null => {
  const left = toHundredths(a ?? '')
  const right = toHundredths(b ?? '')
  if (left === null || right === null) return null
  return fromHundredths(left - right)
}

/** Compares two decimal strings. Returns true when `a` is strictly less than `b`. */
export const isLessThan = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const left = toHundredths(a ?? '')
  const right = toHundredths(b ?? '')
  if (left === null || right === null) return false
  return left < right
}
