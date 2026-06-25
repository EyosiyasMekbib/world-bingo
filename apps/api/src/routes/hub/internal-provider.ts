import type { FastifyPluginAsync } from 'fastify'
import { getGameProviderGateway } from '../../gateways/game-provider/index.js'
import { deploymentConfig } from '../../gateways/hub/deployment-config.js'
import {
  verifySignature,
  DEPLOYMENT_HEADER,
  SIGNATURE_HEADER,
} from '../../gateways/hub/hub-auth.js'
import { namespaceAccount } from '../../gateways/hub/namespace.js'

/**
 * Hub-side internal API. Spokes (and never the provider) call this to reach the
 * shared provider account. Authenticated per-spoke via HMAC over the raw body.
 * User-scoped methods are namespaced with the AUTHENTICATED deployment code so
 * the provider's callbacks route back to the calling spoke.
 */
export const internalProviderRoute: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, { __rawBody: body as string, ...JSON.parse(body as string) })
    } catch (e) {
      done(e as Error, undefined)
    }
  })

  fastify.post('/', async (req, reply) => {
    const cfg = deploymentConfig()
    const raw = (req.body as any)?.__rawBody ?? ''
    const dep = req.headers[DEPLOYMENT_HEADER] as string | undefined
    const sig = req.headers[SIGNATURE_HEADER] as string | undefined
    const spoke = dep ? cfg.spokes.get(dep) : undefined

    // Authenticate: known spoke + valid signature over the exact bytes received.
    if (!spoke || !sig || !verifySignature(spoke.secret, raw, sig)) {
      return reply.status(401).send({ error: 'unauthorized' })
    }

    const verifiedDep = dep as string // guaranteed non-null past the auth gate

    const { providerCode, method, params } = req.body as {
      providerCode?: string
      method?: string
      params?: any
    }

    try {
      if (!providerCode) {
        return reply.status(200).send({ ok: false, error: { message: 'providerCode is required' } })
      }
      if (!params || typeof params !== 'object') {
        return reply.status(200).send({ ok: false, error: { message: 'params is required' } })
      }

      let gateway: any
      try {
        gateway = getGameProviderGateway(providerCode)
      } catch {
        return reply
          .status(200)
          .send({ ok: false, error: { message: `unknown provider: ${providerCode}` } })
      }

      let result: unknown
      switch (method) {
        case 'getGameUrl':
        case 'terminateSession': {
          if (typeof params.username !== 'string' || params.username.length === 0) {
            return reply
              .status(200)
              .send({ ok: false, error: { message: 'params.username is required' } })
          }
          const nsUsername = namespaceAccount(verifiedDep, params.username)
          result =
            method === 'getGameUrl'
              ? await gateway.getGameUrl({ ...params, username: nsUsername })
              : await gateway.terminateSession(nsUsername)
          break
        }
        case 'getVendors':
        case 'getGames':
        case 'getTransactions':
        case 'getTransactionDetail':
          result = await gateway[method](...(params.args ?? []))
          break
        default:
          return reply
            .status(200)
            .send({ ok: false, error: { message: `unknown method: ${method}` } })
      }
      return reply.status(200).send({ ok: true, result })
    } catch (err: any) {
      req.log.error(
        { err, providerCode, method, spoke: verifiedDep },
        '[Hub] internal provider call failed',
      )
      return reply
        .status(200)
        .send({
          ok: false,
          error: { message: err?.message, code: err?.code, palaceCode: err?.palaceCode },
        })
    }
  })
}
