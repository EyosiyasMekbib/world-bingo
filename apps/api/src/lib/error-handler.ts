import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

/**
 * The app's single error-to-HTTP-response mapping. Registered on the real
 * server via `server.setErrorHandler<FastifyError>(mapErrorToResponse)` in
 * index.ts, and imported directly by
 * `test/auth-refresh-route.test.ts` so that suite drives the real handler
 * through `server.inject` rather than a copy that could silently drift from
 * production behaviour.
 *
 * Branch order is load-bearing and must not be reordered casually: the
 * RefreshTokenError branch runs FIRST because its message
 * ('Invalid refresh token') collides with the plain-Error branch directly
 * below it. If that branch ran first, a RefreshTokenError would be caught
 * there instead and lose its `code` — silently reintroducing the forced
 * -logout bug this branch exists to fix (the web store only clears a
 * session when it sees `code === 'refresh_token_invalid' |
 * 'refresh_token_expired'`; anything else must leave the session alone).
 */
export function mapErrorToResponse(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
    // RefreshTokenError carries the only two codes that authorise the client to
    // clear a session. Everything else it sees must be treated as transient.
    const refreshCode = (error as { code?: string }).code
    if (refreshCode === 'refresh_token_invalid' || refreshCode === 'refresh_token_expired') {
        return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: error.message,
            code: refreshCode,
        })
    }

    // Firebase phone sign-in. The code is what lets the web app tell "verify
    // again" (401 firebase_token_invalid) from "this server can't check tokens
    // right now" (503 firebase_not_configured / firebase_keys_unavailable) —
    // the second must not read as a rejected code to the player. Matched on
    // `name`, because `code` here is ours and the default branch below would
    // drop it.
    if ((error as { name?: string }).name === 'FirebaseAuthError') {
        const status = error.statusCode || 401
        const label = status === 403 ? 'Forbidden' : status >= 500 ? 'Service Unavailable' : 'Unauthorized'
        return reply.status(status).send({
            statusCode: status,
            error: label,
            message: error.message,
            code: (error as { code?: string }).code,
        })
    }

    // Map common service errors to appropriate status codes
    if (error.message === 'Invalid credentials' || error.message === 'Invalid refresh token') {
        return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: error.message
        })
    }

    if (error.message === 'User already exists') {
        return reply.status(409).send({
            statusCode: 409,
            error: 'Conflict',
            message: error.message
        })
    }

    if (error.message === 'User not found') {
        return reply.status(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: error.message
        })
    }

    // Structured provider errors (e.g. PalaceApiError) — surface the machine-readable
    // code, the upstream provider code, and contextual details, not just a message.
    const anyErr = error as any
    if (anyErr?.name === 'PalaceApiError') {
        const status = anyErr.statusCode || 502
        return reply.status(status).send({
            statusCode: status,
            error: anyErr.code || 'PalaceApiError',
            message: error.message,
            ...(anyErr.palaceCode != null ? { palaceCode: anyErr.palaceCode } : {}),
            ...(anyErr.details && Object.keys(anyErr.details).length > 0 ? { details: anyErr.details } : {}),
        })
    }

    // WithdrawalHoldError (wallet.service.ts): a withdrawal inside the hold after
    // a support password reset. Keyed on the name, like PalaceApiError, so this
    // file imports no service. The default branch below would drop `code`, which
    // is what the web withdrawal modal picks its copy by.
    if (anyErr?.name === 'WithdrawalHoldError') {
        return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: error.message,
            code: anyErr.code,
        })
    }

    // Default error handler
    const statusCode = error.statusCode || 500
    return reply.status(statusCode).send({
        statusCode,
        error: error.name || 'Internal Server Error',
        message: error.message
    })
}
