import { AsyncLocalStorage } from 'node:async_hooks'
import type { FastifyBaseLogger } from 'fastify'
import { rootLogger } from './logger.js'

const als = new AsyncLocalStorage<FastifyBaseLogger>()

/** Bind a logger for the remainder of the current async context (Fastify hook). */
export function enterLogContext(log: FastifyBaseLogger): void {
  als.enterWith(log)
}

/** Run `fn` with `log` bound — isolated; the previous context is restored after. */
export function runWithLogger<T>(log: FastifyBaseLogger, fn: () => T): T {
  return als.run(log, fn)
}

/** The current request logger, or the process root logger outside a request. */
export function getLogger(): FastifyBaseLogger {
  return als.getStore() ?? rootLogger
}
