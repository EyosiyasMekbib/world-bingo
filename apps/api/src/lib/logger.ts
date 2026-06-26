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

/**
 * Process-level logger for code that runs OUTSIDE a request (workers, module
 * init). Request-scoped code should use getLogger() from log-context instead.
 */
export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: redactPaths, censor: '[redacted]' },
})
