import { describe, it, expect } from 'vitest'
import {
  normalizeName,
  amountsEqualCents,
  parseReceiptAmount,
  parseReceiptDate,
  maskedNumberMatches,
} from '../services/deposit-verification/matching'

describe('normalizeName', () => {
  it('is case/whitespace/diacritic tolerant', () => {
    expect(normalizeName('  Zenu   Abatamam  Abamilki ')).toBe('zenu abatamam abamilki')
    expect(normalizeName('ZENU ABATAMAM ABAMILKI')).toBe(normalizeName('Zenu Abatamam Abamilki'))
  })
})

describe('amountsEqualCents', () => {
  it('matches to the cent and ignores float drift', () => {
    expect(amountsEqualCents(500, 500.0)).toBe(true)
    expect(amountsEqualCents(0.1 + 0.2, 0.3)).toBe(true)
    expect(amountsEqualCents(500, 502)).toBe(false)
  })
})

describe('parseReceiptAmount', () => {
  it('strips currency and thousands separators', () => {
    expect(parseReceiptAmount('500 Birr')).toBe(500)
    expect(parseReceiptAmount('1,502.00 ETB')).toBe(1502)
    expect(parseReceiptAmount('  502.00  ')).toBe(502)
    expect(parseReceiptAmount('N/A')).toBeNull()
  })
})

describe('parseReceiptDate', () => {
  it('parses DD-MM-YYYY HH:mm:ss', () => {
    const d = parseReceiptDate('06-07-2026 10:43:19')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(6) // July (0-indexed)
    expect(d.getDate()).toBe(6)
    expect(parseReceiptDate('garbage')).toBeNull()
  })
})

describe('maskedNumberMatches', () => {
  it('matches on last-4 + leading prefix around the mask', () => {
    expect(maskedNumberMatches('251912342107', '2519****2107')).toBe(true)
    expect(maskedNumberMatches('0912342107', '2519****2107')).toBe(true) // normalize 09.. vs 2519..
    expect(maskedNumberMatches('251912342108', '2519****2107')).toBe(false) // wrong last-4
    expect(maskedNumberMatches('251912342107', '2518****2107')).toBe(false) // wrong prefix
  })
})
