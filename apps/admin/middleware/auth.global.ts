/**
 * Global admin auth middleware.
 * Redirects to /login if not authenticated as admin.
 */
export default defineNuxtRouteMiddleware(async (to) => {
    if (to.path === '/login') return

    const { checkAuth, isAdmin, accessToken, refreshToken } = useAdminAuth()

    // If no tokens at all, redirect immediately
    if (!accessToken.value && !refreshToken.value) {
        return navigateTo('/login')
    }

    // Run checkAuth to validate/refresh tokens and hydrate user
    await checkAuth()

    if (!isAdmin.value) {
        return navigateTo('/login')
    }
})
