import { describe, it, expect } from 'vitest'
import { normalizeEthiopianPhone, candidateRawForms, maskPhone } from '../services/telegram/phone'

describe('normalizeEthiopianPhone', () => {
  it('normalises the four forms a player or Telegram might send to the same canonical value', () => {
    const expected = '251912345678'
    expect(normalizeEthiopianPhone('0912345678')).toBe(expected)
    expect(normalizeEthiopianPhone('912345678')).toBe(expected)
    expect(normalizeEthiopianPhone('251912345678')).toBe(expected)
    expect(normalizeEthiopianPhone('+251912345678')).toBe(expected)
  })

  it('accepts the 7-prefix mobile range alongside 9', () => {
    expect(normalizeEthiopianPhone('0712345678')).toBe('251712345678')
  })

  it('strips spaces, dashes and parentheses before matching', () => {
    expect(normalizeEthiopianPhone('+251 91-234 5678')).toBe('251912345678')
  })

  it('rejects a landline-shaped or otherwise non-mobile subscriber number', () => {
    expect(normalizeEthiopianPhone('0112345678')).toBeNull()
  })

  it('rejects too few or too many digits', () => {
    expect(normalizeEthiopianPhone('12345')).toBeNull()
    expect(normalizeEthiopianPhone('25191234567890')).toBeNull()
  })

  it('rejects empty, null and undefined without throwing', () => {
    expect(normalizeEthiopianPhone('')).toBeNull()
    expect(normalizeEthiopianPhone(null)).toBeNull()
    expect(normalizeEthiopianPhone(undefined)).toBeNull()
  })

  it('rejects a non-numeric string', () => {
    expect(normalizeEthiopianPhone('not-a-phone')).toBeNull()
  })
})

describe('candidateRawForms', () => {
  it('produces exactly the four forms registration could have stored', () => {
    const canonical = normalizeEthiopianPhone('0912345678')!
    expect(candidateRawForms(canonical).sort()).toEqual(
      ['0912345678', '251912345678', '+251912345678', '912345678'].sort(),
    )
  })
})

describe('maskPhone', () => {
  it('keeps only the last four digits', () => {
    expect(maskPhone('0912345678')).toBe('••••5678')
    expect(maskPhone('+251912345678')).toBe('••••5678')
  })

  it('falls back to a placeholder for missing or too-short input', () => {
    expect(maskPhone(null)).toBe('no phone on file')
    expect(maskPhone(undefined)).toBe('no phone on file')
    expect(maskPhone('12')).toBe('••••')
  })
})
