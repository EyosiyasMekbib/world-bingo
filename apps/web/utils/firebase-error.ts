/**
 * Firebase Auth errors, turned into something a player can act on.
 *
 * Pure and dependency-free so it can be unit-tested without the SDK. Every
 * branch here is a real failure of the SMS flow, and the difference between
 * "that code is wrong" and "we could not send the SMS" is the difference
 * between a player retyping six digits and a player giving up.
 */

/** A shape we can reason about, whatever the SDK actually throws. */
export interface FirebaseAuthFailure {
    /** The Firebase code (`auth/invalid-verification-code`), or `unknown`. */
    code: string
    /** What to show the player. */
    message: string
    /** Whether typing the code again could plausibly work. */
    retryable: boolean
}

const MESSAGES: Record<string, { message: string; retryable: boolean }> = {
    'auth/invalid-phone-number': {
        message: 'That phone number does not look right. Check it and try again.',
        retryable: true,
    },
    'auth/missing-phone-number': {
        message: 'Enter your phone number.',
        retryable: true,
    },
    'auth/invalid-verification-code': {
        message: 'That code is not correct. Check the SMS and try again.',
        retryable: true,
    },
    'auth/missing-verification-code': {
        message: 'Enter the 6-digit code from the SMS.',
        retryable: true,
    },
    'auth/code-expired': {
        message: 'That code has expired. Request a new one.',
        retryable: false,
    },
    // Firebase's per-number and per-project SMS metering. Not something a
    // retry fixes, and saying "invalid code" here would be a lie.
    'auth/too-many-requests': {
        message: 'Too many attempts. Please wait a few minutes and try again.',
        retryable: false,
    },
    'auth/quota-exceeded': {
        message: 'SMS sign-in is temporarily unavailable. Please try again later.',
        retryable: false,
    },
    'auth/captcha-check-failed': {
        message: 'Verification failed. Please try again.',
        retryable: false,
    },
    'auth/network-request-failed': {
        message: 'Network problem. Check your connection and try again.',
        retryable: true,
    },
    'auth/operation-not-allowed': {
        message: 'Phone sign-in is not enabled for this app. Please contact support.',
        retryable: false,
    },
    'auth/invalid-app-credential': {
        message: 'Verification failed. Please reload the page and try again.',
        retryable: false,
    },
}

export function describeFirebaseAuthError(error: unknown): FirebaseAuthFailure {
    const code = typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : 'unknown'

    const known = MESSAGES[code]
    if (known) return { code, ...known }

    return {
        code,
        message: 'Sign-in failed. Please try again.',
        retryable: true,
    }
}
