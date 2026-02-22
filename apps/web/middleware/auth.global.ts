import { useAuthStore } from '~/store/auth'

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore()

  // Public routes that don't require auth
  const publicRoutes = ['/auth/login', '/auth/register']
  if (publicRoutes.includes(to.path)) return

  // If not authenticated, try to refresh the token first
  if (!auth.isAuthenticated) {
    const refreshed = await auth.refresh().catch(() => null)
    if (!refreshed) {
      return navigateTo('/auth/login')
    }
  }
})
