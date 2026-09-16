import { toE164 } from '@world-bingo/shared-types'
import { describeFirebaseAuthError } from '~/utils/firebase-error'

/**
 * The browser half of phone sign-in: reCAPTCHA → SMS → code → Firebase ID token.
 *
 * The token is the only thing that then goes to our API, which verifies its
 * signature and reads the phone number out of its claims. Nothing this
 * composable returns is trusted server-side, so a tampered client can lie to
 * itself and get nowhere.
 *
 * The SDK is imported dynamically and only in the browser. Firebase is a large
 * dependency that the lobby never needs, and `RecaptchaVerifier` touches
 * `document` at construction — importing it at module scope would both bloat
 * every page's bundle and break SSR of the auth pages (which are server-rendered,
 * see `routeRules` in nuxt.config.ts).
 */

/** What the page needs to know before rendering a form it cannot submit. */
export interface FirebasePhoneConfig {
    apiKey: string
    authDomain: string
    projectId: string
    appId: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Auth = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfirmationResult = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Verifier = any

/**
 * Module scope, not per-call: Firebase throws on a second `initializeApp` with
 * the same name, and a page that navigates away and back must reuse the same
 * app. Safe here in a way it would not be on the server — this file's work only
 * ever runs in one browser tab (`import.meta.client` guards below).
 */
let authPromise: Promise<Auth> | null = null

async function getAuthInstance(config: FirebasePhoneConfig): Promise<Auth> {
    if (authPromise) return authPromise

    authPromise = (async () => {
        const { initializeApp, getApp, getApps } = await import('firebase/app')
        const { getAuth, inMemoryPersistence, setPersistence } = await import('firebase/auth')

        const app = getApps().length ? getApp() : initializeApp({ ...config })
        const auth = getAuth(app)

        // We take the ID token and throw the Firebase session away — our own
        // JWT is the session. In-memory persistence keeps Firebase from
        // writing an auth state into IndexedDB that nothing would ever read,
        // and that would outlive the player's logout.
        await setPersistence(auth, inMemoryPersistence)

        // The SMS is written in the player's language where Firebase has one.
        auth.useDeviceLanguage()
        return auth
    })()

    return authPromise
}

export function useFirebasePhoneAuth() {
    const config = useRuntimeConfig().public.firebase as FirebasePhoneConfig

    /**
     * Whether this deployment can sign anyone in at all. Every brand runs its
     * own Firebase project, so an unset key means this deployment was not
     * configured — the page says so rather than showing a form that cannot work.
     */
    const isConfigured = computed(
        () => !!config?.apiKey && !!config?.authDomain && !!config?.projectId,
    )

    let verifier: Verifier = null
    let confirmation: ConfirmationResult = null

    /** Drops the reCAPTCHA widget. A solved challenge cannot be re-solved. */
    function clearVerifier() {
        try {
            verifier?.clear()
        } catch {
            // Already torn down with the DOM node it lived in.
        }
        verifier = null
    }

    /**
     * Sends the SMS. `container` is the element the invisible reCAPTCHA
     * attaches to — it has to be in the DOM, and it has to survive until
     * `confirmCode` resolves.
     *
     * Throws a `FirebaseAuthFailure`-shaped error (see utils/firebase-error.ts)
     * so the page never has to read a raw Firebase code.
     */
    async function sendCode(rawPhone: string, container: HTMLElement): Promise<void> {
        if (!import.meta.client) throw new Error('Phone sign-in runs in the browser only')
        if (!isConfigured.value) {
            throw Object.assign(new Error('Phone sign-in is not configured'), {
                code: 'auth/operation-not-allowed',
            })
        }

        const phone = toE164(rawPhone)
        if (!phone) {
            throw Object.assign(new Error('Invalid phone number'), {
                code: 'auth/invalid-phone-number',
            })
        }

        const auth = await getAuthInstance(config)
        const { RecaptchaVerifier, signInWithPhoneNumber } = await import('firebase/auth')

        if (!verifier) {
            verifier = new RecaptchaVerifier(auth, container, { size: 'invisible' })
        }

        try {
            confirmation = await signInWithPhoneNumber(auth, phone, verifier)
        } catch (err) {
            // A failed attempt burns the challenge; the next send needs a new
            // widget or Firebase rejects it with auth/invalid-app-credential.
            clearVerifier()
            throw err
        }
    }

    /**
     * Exchanges the SMS code for a Firebase ID token, and drops the Firebase
     * session on the way out — the API call that follows is what creates the
     * session this app actually uses.
     */
    async function confirmCode(code: string): Promise<string> {
        if (!confirmation) {
            throw Object.assign(new Error('No code was requested'), {
                code: 'auth/missing-verification-code',
            })
        }

        const credential = await confirmation.confirm(code.trim())
        const idToken: string = await credential.user.getIdToken()

        const auth = await getAuthInstance(config)
        const { signOut } = await import('firebase/auth')
        await signOut(auth).catch(() => {
            // Nothing is persisted (in-memory persistence above), so a failure
            // here leaves nothing behind worth reporting.
        })

        reset()
        return idToken
    }

    /** Forgets the pending SMS and the reCAPTCHA widget. */
    function reset() {
        confirmation = null
        clearVerifier()
    }

    return {
        isConfigured,
        sendCode,
        confirmCode,
        reset,
        /** Re-exported so pages have one import for the whole flow. */
        describeError: describeFirebaseAuthError,
    }
}
