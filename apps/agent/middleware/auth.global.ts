/**
 * Global agent auth middleware.
 * Redirects to /login unless the session belongs to an AGENT account.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login') return

  const { checkAuth, isAgent, accessToken, refreshToken } = useAgentAuth()

  // No tokens at all: nothing to validate, go straight to the sign in screen.
  if (!accessToken.value && !refreshToken.value) {
    return navigateTo('/login')
  }

  try {
    await checkAuth()
  } catch {
    return navigateTo('/login')
  }

  if (!isAgent.value) {
    return navigateTo('/login')
  }
})
