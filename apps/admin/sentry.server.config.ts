import * as Sentry from '@sentry/nuxt'

// Server-side Sentry/GlitchTip init. No-op when the DSN is empty: the admin app
// boots and runs normally with nothing configured. The server can read the public
// env var directly. Set NUXT_PUBLIC_SENTRY_DSN to enable error reporting.
const dsn = process.env.NUXT_PUBLIC_SENTRY_DSN || ''

if (dsn) {
    Sentry.init({
        dsn,
        environment: process.env.NUXT_PUBLIC_SENTRY_ENVIRONMENT || 'production',
        // OTel owns traces; this app only ships errors.
        tracesSampleRate: 0,
    })
}
