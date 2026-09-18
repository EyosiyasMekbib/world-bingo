import Fastify from 'fastify'
import gameProviderRoutes from '../../routes/game-provider/index'

/**
 * The player-facing /providers routes on a bare Fastify instance, with JWT
 * auth stubbed out. Callers still mock ../lib/redis in their own file, since
 * vi.mock is file-scoped.
 */
export async function buildGameProviderApp() {
  const app = Fastify({ logger: false })
  app.decorate('authenticate', async () => {})
  await app.register(gameProviderRoutes, { prefix: '/providers' })
  await app.ready()
  return app
}
