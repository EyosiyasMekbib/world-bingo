import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import jsonwebtoken from 'jsonwebtoken'
import { rateLimitKey, extractBearerToken, verifiedUserRateLimitKey } from '../lib/rate-limit-key'

describe('rateLimitKey', () => {
    it('keys on the user id when a bearer token identifies one', () => {
        expect(rateLimitKey({ userId: 'u-1', forwardedFor: '10.0.0.1', ip: '10.0.0.1' })).toBe('user:u-1')
    })

    it('falls back to the first forwarded-for hop for anonymous traffic', () => {
        expect(rateLimitKey({ userId: null, forwardedFor: '196.188.1.1, 10.0.0.5', ip: '10.0.0.5' })).toBe('ip:196.188.1.1')
    })

    it('falls back to the socket ip when there is no forwarded-for header', () => {
        expect(rateLimitKey({ userId: null, forwardedFor: undefined, ip: '10.0.0.5' })).toBe('ip:10.0.0.5')
    })

    it('never returns a bare empty key', () => {
        expect(rateLimitKey({ userId: null, forwardedFor: '   ', ip: '' })).toBe('ip:unknown')
    })
})

describe('extractBearerToken', () => {
    it('extracts the token from a well-formed header', () => {
        expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
    })

    it('is case-insensitive on the scheme', () => {
        expect(extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi')
    })

    it('returns null for a missing header', () => {
        expect(extractBearerToken(undefined)).toBeNull()
        expect(extractBearerToken(null)).toBeNull()
    })

    it('returns null for the wrong scheme', () => {
        expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull()
    })

    it('returns null for a scheme with no token', () => {
        expect(extractBearerToken('Bearer')).toBeNull()
        expect(extractBearerToken('Bearer   ')).toBeNull()
    })
})

describe('verifiedUserRateLimitKey', () => {
    // Test-only key pair — never the real server keys — per the brief, so this
    // suite doesn't depend on env vars and can freely mint a "wrong key" to
    // prove the forgery case.
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const { privateKey: wrongPrivateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })

    // Stands in for `server.jwt.verify` in production: verifies signature and
    // expiry against the real public key, throws on any failure.
    const verify = (token: string) => jsonwebtoken.verify(token, publicKey, { algorithms: ['RS256'] })

    it('yields user:<id> for a validly signed token', async () => {
        const token = jsonwebtoken.sign({ id: 'u-42' }, privateKey, { algorithm: 'RS256', expiresIn: '15m' })
        const key = await verifiedUserRateLimitKey({
            authorizationHeader: `Bearer ${token}`,
            verify,
            forwardedFor: undefined,
            ip: '10.0.0.9',
        })
        expect(key).toBe('user:u-42')
    })

    it('falls back to the ip key for a token signed with the wrong key (forgery)', async () => {
        // Anyone can craft a JWT with any payload they like — the only thing
        // that separates a legitimate token from a forged one is a signature
        // that verifies against the server's real key. This token claims
        // `id: 'admin-0'` but was never issued by this server.
        const forged = jsonwebtoken.sign({ id: 'admin-0' }, wrongPrivateKey, { algorithm: 'RS256', expiresIn: '15m' })
        const key = await verifiedUserRateLimitKey({
            authorizationHeader: `Bearer ${forged}`,
            verify,
            forwardedFor: undefined,
            ip: '10.0.0.9',
        })
        expect(key).toBe('ip:10.0.0.9')
        expect(key).not.toMatch(/^user:/)
    })

    it('falls back to the ip key for an expired token', async () => {
        const token = jsonwebtoken.sign({ id: 'u-42' }, privateKey, { algorithm: 'RS256', expiresIn: -10 })
        const key = await verifiedUserRateLimitKey({
            authorizationHeader: `Bearer ${token}`,
            verify,
            forwardedFor: undefined,
            ip: '10.0.0.9',
        })
        expect(key).toBe('ip:10.0.0.9')
    })

    it('falls back to the ip key when the authorization header is missing', async () => {
        const key = await verifiedUserRateLimitKey({
            authorizationHeader: undefined,
            verify,
            forwardedFor: undefined,
            ip: '10.0.0.9',
        })
        expect(key).toBe('ip:10.0.0.9')
    })

    it('falls back to the ip key for a malformed authorization header', async () => {
        const key = await verifiedUserRateLimitKey({
            authorizationHeader: 'Basic dXNlcjpwYXNz',
            verify,
            forwardedFor: undefined,
            ip: '10.0.0.9',
        })
        expect(key).toBe('ip:10.0.0.9')
    })

    it('never throws, even when the verify function itself throws synchronously', async () => {
        const throwingVerify = () => {
            throw new Error('boom')
        }
        await expect(
            verifiedUserRateLimitKey({
                authorizationHeader: 'Bearer whatever',
                verify: throwingVerify,
                forwardedFor: undefined,
                ip: '10.0.0.9',
            }),
        ).resolves.toBe('ip:10.0.0.9')
    })

    it('never throws when verify rejects asynchronously', async () => {
        const rejectingVerify = async () => {
            throw new Error('boom')
        }
        await expect(
            verifiedUserRateLimitKey({
                authorizationHeader: 'Bearer whatever',
                verify: rejectingVerify,
                forwardedFor: undefined,
                ip: '10.0.0.9',
            }),
        ).resolves.toBe('ip:10.0.0.9')
    })

    it('falls back to the ip key when the verified payload has no id claim', async () => {
        const token = jsonwebtoken.sign({ role: 'PLAYER' }, privateKey, { algorithm: 'RS256', expiresIn: '15m' })
        const key = await verifiedUserRateLimitKey({
            authorizationHeader: `Bearer ${token}`,
            verify,
            forwardedFor: undefined,
            ip: '10.0.0.9',
        })
        expect(key).toBe('ip:10.0.0.9')
    })
})
