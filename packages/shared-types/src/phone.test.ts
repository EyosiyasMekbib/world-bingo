import { describe, it, expect } from 'vitest'
import { etNationalNumber, formatEtPhone, phoneDigits, phoneVariants, toE164 } from './phone'

/**
 * Firebase speaks E.164 and the accounts table does not: rows written before
 * phone sign-in hold whatever the player typed. These helpers are the bridge,
 * and getting them wrong shows up as a returning player silently receiving a
 * second, empty account — or, far worse, as one player matching another's row.
 */
describe('etNationalNumber', () => {
    it('reads every Ethiopian spelling of the same number', () => {
        for (const spelling of [
            '+251911234567',
            '251911234567',
            '0911234567',
            '911234567',
            '+251 91 123 4567',
            '(0911) 234-567',
        ]) {
            expect(etNationalNumber(spelling)).toBe('911234567')
        }
    })

    it('refuses anything that is not an Ethiopian number', () => {
        expect(etNationalNumber('+14155552671')).toBeNull()
        expect(etNationalNumber('12345')).toBeNull()
        expect(etNationalNumber('')).toBeNull()
        expect(etNationalNumber(null)).toBeNull()
        // 251 + ten digits: too long to be 251 + a national number.
        expect(etNationalNumber('2519112345678')).toBeNull()
    })
})

describe('toE164', () => {
    it('turns what a player types into what Firebase accepts', () => {
        expect(toE164('0911234567')).toBe('+251911234567')
        expect(toE164('911234567')).toBe('+251911234567')
        expect(toE164(' 251 911 234 567 ')).toBe('+251911234567')
        expect(toE164('+251911234567')).toBe('+251911234567')
    })

    it('passes through a foreign number that is already E.164', () => {
        expect(toE164('+14155552671')).toBe('+14155552671')
    })

    // Guessing a country code for a bare local number from somewhere else
    // would send an SMS to a different person's phone.
    it('refuses a number it cannot place', () => {
        expect(toE164('12345')).toBeNull()
        expect(toE164('not a phone')).toBeNull()
        expect(toE164('')).toBeNull()
    })
})

describe('phoneVariants', () => {
    it('covers every spelling an existing row could hold', () => {
        const variants = phoneVariants('+251911234567')

        expect(variants).toEqual(
            expect.arrayContaining(['+251911234567', '251911234567', '0911234567', '911234567']),
        )
    })

    it('is symmetric — any spelling yields the same set', () => {
        const fromE164 = [...phoneVariants('+251911234567')].sort()
        const fromLocal = [...phoneVariants('0911234567')].sort()

        expect(fromLocal).toEqual(fromE164)
    })

    // The whole point of an exact-match list: nothing in it may belong to a
    // different subscriber. A nine-digit suffix match would eventually hand one
    // player another player's account.
    it('never includes a different number', () => {
        const variants = phoneVariants('+251911234567')

        expect(variants).not.toContain('+251911234568')
        expect(variants).not.toContain('91123456')
        for (const v of variants) expect(etNationalNumber(v)).toBe('911234567')
    })

    it('does not re-parse a foreign number into Ethiopian spellings', () => {
        const variants = phoneVariants('+14155552671')

        expect(variants).toEqual(expect.arrayContaining(['+14155552671', '14155552671']))
        expect(variants).not.toContain('0155552671')
        expect(variants.some((v) => v.startsWith('+251'))).toBe(false)
    })

    it('is empty for empty input', () => {
        expect(phoneVariants('')).toEqual([])
        expect(phoneVariants(null)).toEqual([])
    })
})

describe('phoneDigits', () => {
    it('strips everything that is not a digit', () => {
        expect(phoneDigits('+251 (91) 123-4567')).toBe('251911234567')
        expect(phoneDigits(undefined)).toBe('')
    })
})

describe('formatEtPhone', () => {
    it('renders any Ethiopian spelling the way players read it', () => {
        expect(formatEtPhone('+251911234567')).toBe('0911 234 567')
        expect(formatEtPhone('0911234567')).toBe('0911 234 567')
    })

    it('shows a foreign number unchanged rather than mangling it', () => {
        expect(formatEtPhone('+14155552671')).toBe('+14155552671')
        expect(formatEtPhone(null)).toBe('')
    })
})
