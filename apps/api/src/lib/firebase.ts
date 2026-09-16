/**
 * Firebase ID token verification — the server half of phone sign-in.
 *
 * The browser runs the SMS round trip against Firebase (reCAPTCHA →
 * `signInWithPhoneNumber` → code) and ends up holding a Firebase ID token.
 * That token is the ONLY thing it sends us; everything about who the player is
 * has to come out of the token's signed claims, never out of the request body.
 * A phone number posted alongside the token would be attacker-controlled.
 *
 * Deliberately not `firebase-admin`: verifying an ID token needs nothing but
 * Google's public signing certificates and the project id, both of which are
 * public. Pulling in the admin SDK would also mean shipping a service-account
 * private key to every brand deployment — a credential that can mint tokens
 * and read the whole project — to do a job that needs no credential at all.
 * `jsonwebtoken` is already a dependency here.
 *
 * Per-brand config: arada and betbawa each run their own Firebase project, so
 * `FIREBASE_PROJECT_ID` differs per deployment and is the only thing that
 * switches brands. Unset means phone sign-in is off and every call to
 * `verifyFirebaseIdToken` refuses with a 503 — nothing else in the API changes.
 */
import crypto from 'crypto'
import jwt from 'jsonwebtoken'

/**
 * Google's x509 certificates for the `securetoken@system.gserviceaccount.com`
 * service account, which signs every Firebase ID token. Public, unauthenticated,
 * and the same set for every Firebase project on earth — the project id is what
 * scopes a token to a brand, via the `aud`/`iss` claims checked below.
 */
const GOOGLE_CERT_URL =
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'

/**
 * Floor on how often the certificate set may be re-fetched. Google rotates
 * roughly daily and its `Cache-Control` says so, but an unknown `kid` also
 * forces a refresh (see `signingKeyFor`) — and an attacker can mint unlimited
 * junk tokens carrying a random `kid`. Without this floor each one would cost
 * an outbound request to Google.
 */
const MIN_REFETCH_MS = 60_000

/** Ceiling on the cache lifetime, in case a proxy hands back a silly max-age. */
const MAX_CACHE_MS = 24 * 60 * 60_000

/** Fallback when the response carries no usable `Cache-Control: max-age`. */
const DEFAULT_CACHE_MS = 60 * 60_000

/** Seconds of clock drift tolerated on `exp`/`iat`/`auth_time`. */
const CLOCK_TOLERANCE_S = 60

export type FirebaseAuthErrorCode =
    /** No FIREBASE_PROJECT_ID on this deployment — the feature is switched off. */
    | 'firebase_not_configured'
    /** We could not reach Google's certificates, so no token can be judged. */
    | 'firebase_keys_unavailable'
    /** The token is malformed, expired, for another project, or not phone sign-in. */
    | 'firebase_token_invalid'

/**
 * A refusal the client can act on. `statusCode` separates "this token is no
 * good" (401, the player should re-verify) from "this server cannot check
 * tokens right now" (503, the player should retry) — the web app must not wipe
 * a sign-in attempt on the second.
 */
export class FirebaseAuthError extends Error {
    constructor(
        readonly code: FirebaseAuthErrorCode,
        message: string,
        readonly statusCode: number = 401,
    ) {
        super(message)
        this.name = 'FirebaseAuthError'
    }
}

export interface FirebaseIdTokenClaims {
    /** Firebase's stable user id (the token's `sub`). Unique within one project. */
    uid: string
    /** E.164, e.g. `+251911234567`. Present for phone sign-in; null otherwise. */
    phoneNumber: string | null
    /** `phone` for an SMS sign-in. Anything else is refused by the caller. */
    signInProvider: string | null
    /** Unix seconds of the sign-in itself, which can be older than `iat`. */
    authTime: number | null
}

/** The project this deployment verifies for, or null when phone sign-in is off. */
export function firebaseProjectId(): string | null {
    const id = process.env.FIREBASE_PROJECT_ID?.trim()
    return id ? id : null
}

/** Whether `/auth/phone` can do anything on this deployment. */
export function isFirebaseAuthEnabled(): boolean {
    return firebaseProjectId() !== null
}

interface CertCache {
    keys: Record<string, string>
    /** When the cached set goes stale, from `Cache-Control: max-age`. */
    expiresAt: number
    /** When it was fetched — the `MIN_REFETCH_MS` floor is measured from here. */
    fetchedAt: number
}

let certCache: CertCache | null = null
/** One shared fetch: a burst of sign-ins on a cold cache must not fan out. */
let certFetch: Promise<Record<string, string>> | null = null

/** Test seam. Drops the cached certificates so a test starts from cold. */
export function __resetFirebaseCertCache(): void {
    certCache = null
    certFetch = null
}

function parseMaxAgeMs(cacheControl: string | null): number {
    const match = /max-age\s*=\s*(\d+)/i.exec(cacheControl ?? '')
    if (!match) return DEFAULT_CACHE_MS
    const ms = Number(match[1]) * 1000
    if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_CACHE_MS
    return Math.min(ms, MAX_CACHE_MS)
}

async function fetchCerts(): Promise<Record<string, string>> {
    if (certFetch) return certFetch

    certFetch = (async () => {
        try {
            const res = await fetch(GOOGLE_CERT_URL)
            if (!res.ok) throw new Error(`certificate endpoint returned ${res.status}`)

            const body = (await res.json()) as Record<string, unknown>
            const keys: Record<string, string> = {}
            for (const [kid, pem] of Object.entries(body ?? {})) {
                if (typeof pem === 'string' && pem.includes('BEGIN CERTIFICATE')) keys[kid] = pem
            }
            if (Object.keys(keys).length === 0) throw new Error('certificate endpoint returned no keys')

            certCache = {
                keys,
                expiresAt: Date.now() + parseMaxAgeMs(res.headers.get('cache-control')),
                fetchedAt: Date.now(),
            }
            return keys
        } catch (err) {
            // Stale-but-serving: Google's keys stay valid for weeks after they
            // stop being advertised, so a blip at their end (or ours) must not
            // log every player out. Only a cold cache is fatal.
            if (certCache) return certCache.keys
            throw new FirebaseAuthError(
                'firebase_keys_unavailable',
                `Could not reach Firebase signing keys: ${(err as Error).message}`,
                503,
            )
        } finally {
            certFetch = null
        }
    })()

    return certFetch
}

/**
 * The certificate for `kid`, refreshing once if it is unknown. An unknown kid
 * is the normal shape of a key rotation — Google starts signing with a key
 * before our cached set has it — but it is also what a forged token looks like,
 * hence the `MIN_REFETCH_MS` floor on the refresh.
 */
async function signingKeyFor(kid: string): Promise<string | null> {
    let keys = certCache && certCache.expiresAt > Date.now() ? certCache.keys : await fetchCerts()
    if (keys[kid]) return keys[kid]

    const lastFetch = certCache?.fetchedAt ?? 0
    if (Date.now() - lastFetch < MIN_REFETCH_MS) return null

    certCache = null
    keys = await fetchCerts()
    return keys[kid] ?? null
}

/**
 * Verify a Firebase ID token and return its claims, or throw FirebaseAuthError.
 *
 * Checks, in the order Firebase documents them: RS256 with a known `kid`, a
 * signature from Google, `aud` equal to this deployment's project, `iss` equal
 * to `https://securetoken.google.com/<project>`, unexpired, and a non-empty
 * `sub`. `auth_time` must not be in the future — a token whose sign-in has not
 * happened yet is not a sign-in.
 */
export async function verifyFirebaseIdToken(idToken: string): Promise<FirebaseIdTokenClaims> {
    const projectId = firebaseProjectId()
    if (!projectId) {
        throw new FirebaseAuthError(
            'firebase_not_configured',
            'Phone sign-in is not configured on this server',
            503,
        )
    }

    const decoded = jwt.decode(idToken, { complete: true })
    if (!decoded || typeof decoded === 'string' || typeof decoded.payload !== 'object') {
        throw new FirebaseAuthError('firebase_token_invalid', 'Malformed sign-in token')
    }
    if (decoded.header.alg !== 'RS256') {
        // `alg: none` and HS256-with-the-public-key-as-secret are the two
        // classic JWT forgeries; pinning the algorithm here and again in
        // `jwt.verify` below closes both.
        throw new FirebaseAuthError('firebase_token_invalid', 'Unexpected sign-in token algorithm')
    }
    if (!decoded.header.kid) {
        throw new FirebaseAuthError('firebase_token_invalid', 'Sign-in token carries no key id')
    }

    const cert = await signingKeyFor(decoded.header.kid)
    if (!cert) {
        throw new FirebaseAuthError('firebase_token_invalid', 'Sign-in token was signed by an unknown key')
    }

    let payload: jwt.JwtPayload
    try {
        // The x509 certificate is converted to a bare public key first:
        // `crypto.verify` accepts a certificate PEM, but going through
        // `createPublicKey` makes the intent explicit and fails loudly on a
        // malformed PEM instead of deep inside the signature check.
        const publicKey = crypto.createPublicKey(cert)
        payload = jwt.verify(idToken, publicKey, {
            algorithms: ['RS256'],
            audience: projectId,
            issuer: `https://securetoken.google.com/${projectId}`,
            clockTolerance: CLOCK_TOLERANCE_S,
        }) as jwt.JwtPayload
    } catch (err) {
        throw new FirebaseAuthError('firebase_token_invalid', `Sign-in token rejected: ${(err as Error).message}`)
    }

    const uid = typeof payload.sub === 'string' ? payload.sub.trim() : ''
    if (!uid || uid.length > 128) {
        throw new FirebaseAuthError('firebase_token_invalid', 'Sign-in token carries no user id')
    }

    const authTime = typeof payload.auth_time === 'number' ? payload.auth_time : null
    if (authTime !== null && authTime > Date.now() / 1000 + CLOCK_TOLERANCE_S) {
        throw new FirebaseAuthError('firebase_token_invalid', 'Sign-in token was issued in the future')
    }

    const firebaseClaim = (payload.firebase ?? {}) as { sign_in_provider?: unknown }

    return {
        uid,
        phoneNumber: typeof payload.phone_number === 'string' ? payload.phone_number : null,
        signInProvider:
            typeof firebaseClaim.sign_in_provider === 'string' ? firebaseClaim.sign_in_provider : null,
        authTime,
    }
}
