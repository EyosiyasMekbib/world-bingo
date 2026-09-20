/**
 * Date and time rendering. Fixed to en-GB so the shop always reads a 24 hour
 * clock and a day/month order, whatever the laptop's locale happens to be:
 * an agent comparing a receipt against a row should never have to work out
 * whether 05/06 is May or June.
 */
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const DATE = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

const parse = (value: string | null | undefined): Date | null => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export const formatTime = (value: string | null | undefined, fallback = '-') => {
  const date = parse(value)
  return date ? TIME.format(date) : fallback
}

export const formatDateTime = (value: string | null | undefined, fallback = '-') => {
  const date = parse(value)
  return date ? DATE_TIME.format(date) : fallback
}

export const formatDate = (value: string | null | undefined, fallback = '-') => {
  const date = parse(value)
  return date ? DATE.format(date) : fallback
}

/** `YYYY-MM-DD` in the laptop's own timezone, for the ledger date filters. */
export const isoDay = (date = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
