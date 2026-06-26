import * as Sentry from '@sentry/nuxt'

// Client-side Sentry/GlitchTip init. No-op when the DSN is empty: the admin app
// boots and runs normally with nothing configured. Set NUXT_PUBLIC_SENTRY_DSN
// (and optionally NUXT_PUBLIC_SENTRY_ENVIRONMENT) to enable error reporting.
const config = useRuntimeConfig()
const dsn = config.public.sentry?.dsn || ''

if (dsn) {
    Sentry.init({
        dsn,
        environment: config.public.sentry?.environment || 'production',
        // OTel owns traces; this app only ships errors.
        tracesSampleRate: 0,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
    })
}
