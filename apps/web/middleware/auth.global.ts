import { useAuthStore } from '~/store/auth'

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore()

  // Public routes that don't require auth (exact match)
  const publicPaths = ['/auth/login', '/auth/register', '/', '/tournaments']

  // Public path prefixes (any sub-path is also public for guests to browse)
  const publicPrefixes = ['/auth/', '/ref/', '/tournaments/']

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
