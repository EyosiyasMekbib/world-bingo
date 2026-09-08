import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { loginRateLimitKey } from '../lib/rate-limit-key'

// /login was keyed per IP at 10/min. Behind an Ethiopian carrier NAT that is
// one budget for a whole neighbourhood, so a busy evening throttles honest
// players. Key on the identifier being tried instead; an IP ceiling on the
// route keeps credential stuffing from minting unlimited buckets.
describe('loginRateLimitKey', () => {
    it('keys on the normalised identifier when one is supplied', () => {
        const digest = createHash('sha256').update('john_doe').digest('hex')
        expect(loginRateLimitKey({ identifier: '  John_Doe ', ip: '10.0.0.1' })).toBe(`login:${digest}`)
    })

    it('treats a phone and its trimmed form as the same bucket', () => {
        const a = loginRateLimitKey({ identifier: '0911234567', ip: '10.0.0.1' })
        const b = loginRateLimitKey({ identifier: ' 0911234567', ip: '10.0.0.2' })
        expect(a).toBe(b)
    })

    it('falls back to the resolved ip when the body has no identifier', () => {
        expect(loginRateLimitKey({ identifier: undefined, ip: '196.188.1.1' })).toBe('ip:196.188.1.1')
        expect(loginRateLimitKey({ identifier: '', ip: '196.188.1.1' })).toBe('ip:196.188.1.1')
        expect(loginRateLimitKey({ identifier: 42 as unknown as string, ip: '196.188.1.1' })).toBe('ip:196.188.1.1')
    })

    it('never exposes the identifier itself in the key', () => {
        expect(loginRateLimitKey({ identifier: '0911234567', ip: '1.1.1.1' })).not.toContain('0911234567')
    })
})
