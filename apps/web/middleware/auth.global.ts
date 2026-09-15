import { useAuthStore } from '~/store/auth'
import { passwordChangeRedirect } from '~/utils/password-change'

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore()

  // Ahead of the public-page return below: a player signed in with a
  // temporary password from support must choose their own before doing
  // anything else, on public pages too. /auth/* stays reachable.
  const forced = passwordChangeRedirect({
    path: to.path,
    user: auth.user,
    isAuthenticated: auth.isAuthenticated,
  })
  if (forced) return navigateTo(forced)

  // Public routes that don't require auth (exact match)
  const publicPaths = ['/auth/login', '/auth/register', '/', '/tournaments', '/games', '/promotions']

  // Public path prefixes (any sub-path is also public for guests to browse)
  const publicPrefixes = ['/auth/', '/ref/', '/tournaments/', '/games/']

  const isPublic =
    publicPaths.includes(to.path) ||
    publicPrefixes.some((p) => to.path.startsWith(p))

  if (isPublic) return

  // If not authenticated, try to refresh the token first
  if (!auth.isAuthenticated) {
    const refreshed = await auth.refresh().catch(() => null)
    if (!refreshed) {
      return navigateTo('/auth/login')
    }
  }
})
