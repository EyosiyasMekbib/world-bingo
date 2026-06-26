import pino from 'pino'
import { randomUUID } from 'node:crypto'

/**
 * Mask an account/username before it reaches a log line. Accounts are UUID-hex
 * (32), hub-namespaced (35), or plain usernames — all are PII or PII-adjacent.
 */
export function maskAccount(account: string | undefined | null): string {
  if (!account) return '∅'
  if (account.length <= 8) return account.slice(0, 2) + '***'
  return account.slice(0, 6) + '…' + account.slice(-4)
}

/** Honor an inbound correlation id, else mint one. Used as Fastify `genReqId`. */
export function genReqId(req: { headers: Record<string, unknown> }): string {
  const inbound = req.headers['x-request-id']
  return typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID()
}

/** Pino redaction paths — secrets and PII that must never appear in logs. */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers["callback-token"]',
  'req.headers["x-signature"]',
  'rawBody.data.account',
  'data.account',
  '*.password',
  '*.passwordHash',
]

/** Shared pino options — redaction is enforced regardless of transport. */
const loggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: redactPaths, censor: '[redacted]' },
}

/**
 * When LOKI_URL is set, ship logs to Grafana Loki via pino-loki while still
 * writing to stdout. When unset, the logger behaves exactly as before
 * (stdout-only, no transport).
 */
function buildLokiTransport() {
  const lokiUrl = process.env.LOKI_URL
  if (!lokiUrl) return undefined
  return pino.transport({
    targets: [
      {
        target: 'pino-loki',
        options: {
          host: lokiUrl,
          batching: true,
          interval: 5,
          labels: {
            app: process.env.LOKI_LABEL_APP || 'world-bingo-api',
            env: process.env.NODE_ENV || 'development',
          },
        },
      },
      {
        target: 'pino/file',
        options: { destination: 1 }, // stdout
      },
    ],
  })
}

/**
 * Process-level logger for code that runs OUTSIDE a request (workers, module
 * init). Request-scoped code should use getLogger() from log-context instead.
 */
const lokiTransport = buildLokiTransport()
export const rootLogger = lokiTransport
  ? pino(loggerOptions, lokiTransport)
  : pino(loggerOptions)

// A transport worker failing to spawn/exit emits an 'error' event on the logger;
// an unhandled 'error' on an EventEmitter would throw. Logging must never crash
// the app — swallow it (pino-loki already no-ops on push failures). pino's typed
// `.on()` only declares 'level-change', so reach the underlying emitter via cast.
;(rootLogger as unknown as { on(event: string, cb: (err: unknown) => void): void }).on(
  'error',
  (err: unknown) => {
    console.error('[logger] transport error:', err instanceof Error ? err.message : err)
  },
)
