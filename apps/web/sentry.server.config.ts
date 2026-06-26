import * as Sentry from '@sentry/nuxt'

// Server-side Sentry (GlitchTip) init. Reads the public DSN directly from the
// environment (available on the server). Fully env-gated: when
// NUXT_PUBLIC_SENTRY_DSN is empty this is a complete no-op.
const dsn = process.env.NUXT_PUBLIC_SENTRY_DSN || ''

if (dsn) {
    Sentry.init({
        dsn,
        environment: process.env.NUXT_PUBLIC_SENTRY_ENVIRONMENT || 'production',
        // OTel/Tempo owns tracing; keep this errors-only.
        tracesSampleRate: 0,
    })
}
