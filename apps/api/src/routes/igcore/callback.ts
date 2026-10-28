import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { igcoreConfig } from '../../gateways/igcore/igcore-config.js'
import { signIgcoreBody, verifyIgcoreSignature } from '../../gateways/igcore/igcore-signature.js'
import { IgcoreWalletService, type IgcoreCallbackBody } from '../../services/igcore-wallet.service.js'

/**
 * IGCORE sportsbook inbound wallet callbacks. Mounted under /v1/igcore
 * (configured in index.ts). IGCORE POSTs signed JSON to
 *   /transaction           bet, result, freebet
 *   /transaction-rollback  rollback
 * and evaluates the HTTP answer:
 *   200 {error:null, transaction_id}  accepted (transaction_id is OUR row id)
 *   200 {error:"<CODE>"}              refused for a business reason
 *   500 {error:"RETRY"}               not applied, IGCORE retries (or cancels the bet)
 *   400 INVALID_SIGNATURE | INVALID_JSON
 */
export const igcoreCallbackRoutes: FastifyPluginAsync = async (fastify) => {
    // The signature covers the exact bytes IGCORE sent, so the parser keeps the
    // Buffer and does not parse. Parsing and re-serialising would change
    // whitespace, key order and number formatting (`25.0` becomes `25`).
    // Route-scoped: this plugin is its own encapsulation context.
    fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

    const handler = (endpoint: 'transaction' | 'transaction-rollback') => async (req: FastifyRequest, reply: FastifyReply) => {
        const started = Date.now()
        const cfg = igcoreConfig()
        // An empty body arrives as an empty Buffer (or nothing); either way it
        // signs to nothing valid and falls out at the signature check below.
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        const header = req.headers['x-security-hash']
        const hash = Array.isArray(header) ? header[0] : header

        if (!verifyIgcoreSignature(raw, hash, cfg.securityHash)) {
            // Debug only: this prints a digest of the secret-keyed body, so it
            // must stay off outside a short diagnosis window.
            if (cfg.callbackDebug) {
                req.log.warn(
                    { component: 'igcore-callback', endpoint, rawBody: raw.toString('utf8'), receivedHash: hash, expectedHash: cfg.securityHash ? signIgcoreBody(raw, cfg.securityHash) : null },
                    '[igcore-callback] signature mismatch',
                )
            } else {
                req.log.warn({ component: 'igcore-callback', endpoint, bytes: raw.length, hasHash: Boolean(hash) }, '[igcore-callback] signature mismatch')
            }
            return reply.status(400).send({ error: 'INVALID_SIGNATURE' })
        }

        let body: IgcoreCallbackBody
        try {
            const parsed = JSON.parse(raw.toString('utf8'))
            // `null`, arrays and scalars parse fine but are not a callback; the
            // service would throw on them and answer a retry IGCORE would repeat forever.
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
            body = parsed
        } catch {
            req.log.warn({ component: 'igcore-callback', endpoint, bytes: raw.length }, '[igcore-callback] invalid JSON')
            return reply.status(400).send({ error: 'INVALID_JSON' })
        }

        const meta = { component: 'igcore-callback', endpoint, action: body.action, transaction_id: body.transaction_id }
        try {
            const outcome = await IgcoreWalletService.dispatch(endpoint, body)
            const ms = Date.now() - started
            if (outcome.kind === 'ok') {
                req.log.info({ ...meta, outcome: 'ok', ms }, '[igcore-callback] handled')
                return reply.status(200).send({ error: null, transaction_id: outcome.transactionId })
            }
            if (outcome.kind === 'reject') {
                req.log.info({ ...meta, outcome: 'reject', error: outcome.error, ms }, '[igcore-callback] handled')
                return reply.status(200).send({ error: outcome.error })
            }
            req.log.warn({ ...meta, outcome: 'retry', reason: outcome.reason, ms }, '[igcore-callback] handled')
            return reply.status(500).send({ error: 'RETRY' })
        } catch (err) {
            req.log.error({ ...meta, outcome: 'error', ms: Date.now() - started, err }, '[igcore-callback] handler failed')
            return reply.status(500).send({ error: 'RETRY' })
        }
    }

    fastify.post('/transaction', handler('transaction'))
    fastify.post('/transaction-rollback', handler('transaction-rollback'))
}
