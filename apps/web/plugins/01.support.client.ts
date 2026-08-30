/**
 * Bind the support listeners at app start rather than at first open.
 *
 * Until this existed, `bind()` ran only inside `openChat`, so a player who had
 * never touched the widget in this page load had NO `support:message` and no
 * `notification:new` handler attached: a clerk's reply reached the browser and
 * was dropped on the floor, the launcher badge stayed at zero, and the reply
 * only surfaced if the player happened to open the panel — which is exactly
 * what they had no reason to do, having been told nothing.
 *
 * Client-only (`.client`): there is no socket during SSR, and the auth store's
 * persisted session is only readable in the browser.
 *
 * It deliberately does NOT emit `support:open`. `openForUser` CREATES a thread
 * when none exists, so opening one here would file a support conversation for
 * every player who loads the lobby. The `connect` handler inside `bind()` is
 * guarded on an existing `conversation` for the same reason.
 */
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('app:mounted', () => {
    const auth = useAuth()
    const { connect, signedOut } = useSocket()
    const { bind, isOpen, reportError } = useSupport()

    const attach = () => {
      if (!auth.isAuthenticated) return
      connect()
      bind()
    }

    attach()

    // Signing in mid-session builds a new socket (useSocket rebuilds on an
    // identity change), and a new socket carries none of our listeners.
    watch(
      () => auth.isAuthenticated,
      (authenticated) => {
        if (authenticated) attach()
      },
    )

    // The socket refreshes its own token, but a refresh that comes back null
    // means the session is gone for good. Only worth saying while the panel is
    // on screen — `openChat` covers the signed-out case on its own path.
    watch(signedOut, (expired) => {
      if (expired && isOpen.value) {
        reportError({
          code: 'SUPPORT_SIGNED_OUT',
          message: 'Your session expired. Sign in again to keep chatting.',
        })
      }
    })
  })
})
