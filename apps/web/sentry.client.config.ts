import * as Sentry from '@sentry/nuxt'

// Client-side Sentry (GlitchTip) init. Fully env-gated: when
// NUXT_PUBLIC_SENTRY_DSN is empty the runtime config dsn is '' and this
// becomes a complete no-op (Sentry.init bails out on an empty DSN, but we
// guard explicitly so nothing else runs either).
const config = useRuntimeConfig()
const dsn = config.public.sentry?.dsn || ''

if (dsn) {
    Sentry.init({
        dsn,
        environment: config.public.sentry?.environment || 'production',
        // OTel/Tempo owns tracing; keep this errors-only.
        tracesSampleRate: 0,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
    })
}
