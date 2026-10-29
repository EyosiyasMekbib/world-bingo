import type { FastifyPluginAsync } from 'fastify'
import { AccountStatus } from '@world-bingo/shared-types'
import prisma from '../../lib/prisma.js'
import { IgcoreClient, IgcoreApiError } from '../../gateways/igcore/igcore.client.js'
import { igcoreConfig, igcoreConfigured } from '../../gateways/igcore/igcore-config.js'

/** Languages the web app can ask for; anything else gets the configured default. */
const SUPPORTED_LANGS = ['en', 'am']

const UNAVAILABLE = { code: 'SPORTSBOOK_UNAVAILABLE' }

/** The url's scheme (`https:`), or null when it is not a URL at all. */
function schemeOf(url: unknown): string | null {
    if (typeof url !== 'string') return null
    try {
        return new URL(url).protocol
    } catch {
        return null
    }
}

/**
 * Player-facing sportsbook routes, mounted under /sportsbook (see index.ts).
 * The whole sportsbook sits behind the admin flag `feature_sportsbook`.
 */
const sportsbookRoutes: FastifyPluginAsync = async (fastify) => {
    const client = new IgcoreClient()

    // ── Start a session ───────────────────────────────────────────────────────
    // Asks IGCORE for a fresh iframe URL for this player and returns it. The URL
    // carries the player's session, so it is never logged.
    fastify.post('/session', {
        preValidation: [fastify.authenticate],
        handler: async (req, reply) => {
            const user = (req as any).user as { id: string }
            const body = (req.body ?? {}) as { lang?: unknown }

            const flag = await prisma.siteSetting.findUnique({ where: { key: 'feature_sportsbook' } })
            if (flag?.value !== 'true') return reply.status(503).send(UNAVAILABLE)

            const cfg = igcoreConfig()
            if (!igcoreConfigured(cfg)) return reply.status(503).send(UNAVAILABLE)

            // RESTRICTED accounts pass `authenticate` on purpose; the sportsbook is a
            // place to wager, so they stop here (the bet callback refuses them too).
            const account = await prisma.user.findUnique({ where: { id: user.id }, select: { accountStatus: true } })
            if (account?.accountStatus !== AccountStatus.ACTIVE) {
                return reply.status(403).send({ code: 'ACCOUNT_RESTRICTED' })
            }

            const lang =
                typeof body.lang === 'string' && SUPPORTED_LANGS.includes(body.lang) ? body.lang : cfg.defaultLang
            const params = { userId: user.id.replace(/-/g, ''), currency: cfg.currency }

            // The url becomes the iframe src as it is, so only a web page passes:
            // https, or http while the simulator is on (it is served by this api).
            // Anything else is unavailable, and the log names the scheme only.
            const framed = (url: unknown) => {
                const scheme = schemeOf(url)
                if (scheme === 'https:' || (scheme === 'http:' && cfg.simulator)) return { url }
                req.log.warn({ userId: user.id, scheme }, '[igcore] start-session url is not a frameable https page')
                return reply.status(503).send(UNAVAILABLE)
            }

            try {
                try {
                    const { url } = await client.startSession({ ...params, lang })
                    return framed(url)
                } catch (err) {
                    // IGCORE may not offer every language; one retry in the default one.
                    if (err instanceof IgcoreApiError && err.code === 'invalid params' && lang !== cfg.defaultLang) {
                        const { url } = await client.startSession({ ...params, lang: cfg.defaultLang })
                        return framed(url)
                    }
                    throw err
                }
            } catch (err: any) {
                // Any failure is "unavailable", including plain errors the client lets
                // escape (a Redis outage while it reads its token). Log the code or
                // message only, never the response: a session URL must not reach a log.
                req.log.warn(
                    { userId: user.id, reason: err instanceof IgcoreApiError ? err.code : String(err?.message ?? err) },
                    '[igcore] start-session failed',
                )
                return reply.status(503).send(UNAVAILABLE)
            }
        },
    })
}

export default sportsbookRoutes
