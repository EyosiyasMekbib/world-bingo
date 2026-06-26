/**
 * Sentry (GlitchTip-compatible) error reporting — errors only.
 *
 * Fully env-gated: when SENTRY_DSN is unset, Sentry.init is never called and
 * every helper here is an inert no-op. Performance tracing is disabled
 * (tracesSampleRate: 0) — OpenTelemetry owns distributed traces.
 */
import * as Sentry from '@sentry/node'
import { rootLogger } from './logger.js'

let enabled = false

/**
 * Initialise Sentry ONLY when SENTRY_DSN is set. Errors-only, no tracing.
 * Call as early as possible during process bootstrap. Logs one line either way.
 */
export function initSentry(): void {
    const dsn = process.env.SENTRY_DSN
    if (!dsn) {
        rootLogger.info('[sentry] SENTRY_DSN not set — error reporting disabled')
        return
    }

    Sentry.init({
        dsn,
        environment: process.env.SENTRY_ENVIRONMENT || 'production',
        release: process.env.SENTRY_RELEASE || undefined,
        // OTel owns traces — keep Sentry errors-only.
        tracesSampleRate: 0,
    })

    enabled = true
    rootLogger.info('[sentry] error reporting enabled')
}

/**
 * Report an error to Sentry with optional extra context. No-op when Sentry is
 * not enabled. NEVER throws — reporting must not break the calling code path.
 */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
    if (!enabled) return
    try {
        Sentry.captureException(error, context ? { extra: context } : undefined)
    } catch {
        // Swallow — observability must never crash the app.
    }
}

export { Sentry }
