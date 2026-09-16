import { describe, it, expect } from 'vitest'
import { describeFirebaseAuthError } from './firebase-error'

/**
 * What the player reads when the SMS flow fails. The distinction that matters
 * is "type the code again" vs "this is not going to work" — telling someone
 * their code is wrong when the project is out of SMS budget sends them round a
 * loop that cannot end.
 */
describe('describeFirebaseAuthError', () => {
    it('names a wrong code as a wrong code, and lets them retry', () => {
        const failure = describeFirebaseAuthError({ code: 'auth/invalid-verification-code' })

        expect(failure.message).toMatch(/not correct/i)
        expect(failure.retryable).toBe(true)
    })

    it('does not offer a retry on an expired code', () => {
        expect(describeFirebaseAuthError({ code: 'auth/code-expired' }).retryable).toBe(false)
    })

    // Firebase's per-number metering and the project's SMS budget are not the
    // player's fault and not fixable by retyping.
    it.each(['auth/too-many-requests', 'auth/quota-exceeded'])(
        'explains %s instead of blaming the code',
        (code) => {
            const failure = describeFirebaseAuthError({ code })

            expect(failure.message).not.toMatch(/not correct/i)
            expect(failure.retryable).toBe(false)
        },
    )

    it('treats a network failure as worth retrying', () => {
        expect(describeFirebaseAuthError({ code: 'auth/network-request-failed' }).retryable).toBe(true)
    })

    it('says so when phone sign-in is not enabled on the project', () => {
        const failure = describeFirebaseAuthError({ code: 'auth/operation-not-allowed' })

        expect(failure.message).toMatch(/not enabled|support/i)
        expect(failure.retryable).toBe(false)
    })

    it('falls back for anything it has not seen', () => {
        for (const thrown of [{ code: 'auth/something-new' }, new Error('boom'), null, undefined, 'nope']) {
            const failure = describeFirebaseAuthError(thrown)

            expect(failure.message).toBeTruthy()
            expect(typeof failure.code).toBe('string')
        }
    })

    it('keeps the raw code, so a failure can be grouped in analytics', () => {
        expect(describeFirebaseAuthError({ code: 'auth/code-expired' }).code).toBe('auth/code-expired')
        expect(describeFirebaseAuthError(new Error('boom')).code).toBe('unknown')
    })
})
