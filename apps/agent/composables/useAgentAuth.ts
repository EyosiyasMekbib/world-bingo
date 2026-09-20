export type AgentUser = {
  id: string
  username: string
  role: string
}

const ACCESS_KEY = 'agent_access_token'
const REFRESH_KEY = 'agent_refresh_token'

/**
 * Deliberately NOT a cookie.
 *
 * apps/web stores its persisted auth state in a same-site cookie, and every
 * Nitro route-rule proxy forwards cookies upstream, so the token rides along on
 * requests it was never meant for. This app proxies /api/**, /socket.io/** and
 * /uploads/** through Nitro, so a token in a cookie here would be forwarded on
 * every one of those. localStorage is not attached to any request: the only way
 * a token leaves this app is the Authorization header apiFetch sets by hand.
 *
 * Reads are wrapped because localStorage throws in a locked-down browser
 * profile, and a shop laptop is exactly where that happens.
 */
const readStored = (key: string): string | null => {
  if (!import.meta.client) return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeStored = (key: string, value: string | null) => {
  if (!import.meta.client) return
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // A browser that refuses storage still works for the length of this
    // page load; the agent just has to sign in again after a reload.
  }
}

export const SUSPENDED_MESSAGE =
  'This account has been suspended. Your float is untouched. Contact the operator.'

/** True when a 401 is a suspension rather than an expired token. */
const isSuspension = (error: unknown): boolean =>
  (error as { data?: { code?: string } } | undefined)?.data?.code === 'account_suspended'

/** Pulls the most useful sentence out of an ofetch error. */
export const apiErrorMessage = (error: unknown, fallback: string): string => {
  const data = (error as { data?: { message?: string; error?: string } } | undefined)?.data
  return data?.message || data?.error || fallback
}

export const useAgentAuth = () => {
  const config = useRuntimeConfig()
  const apiBase = config.public.apiBase as string

  const accessToken = useState<string | null>('agent_access_token', () => readStored(ACCESS_KEY))
  const refreshToken = useState<string | null>('agent_refresh_token', () => readStored(REFRESH_KEY))
  const user = useState<AgentUser | null>('agent_user', () => null)

  const setTokens = (access: string | null, refresh: string | null) => {
    accessToken.value = access
    refreshToken.value = refresh
    writeStored(ACCESS_KEY, access)
    writeStored(REFRESH_KEY, refresh)
  }

  const clear = () => {
    setTokens(null, null)
    user.value = null
  }

  const isAgent = computed(() => user.value?.role === 'AGENT')

  const login = async (credentials: { username: string; password: string }) => {
    // A dedicated gate, not the shared admin login. The API refuses any role
    // other than AGENT here with a 403, so a player, clerk or admin
    // credential cannot obtain a session in this app at all. The message the
    // API returns is what the login card shows.
    // The API's LoginSchema takes `identifier` (username OR phone), not
    // `username`. Sending the wrong key is a 400 before the handler runs, so
    // the mapping happens here rather than in the page.
    const data = await $fetch<{ accessToken: string; refreshToken: string; user: AgentUser }>(
      `${apiBase}/auth/agent/login`,
      {
        method: 'POST',
        body: { identifier: credentials.username, password: credentials.password },
      },
    )

    // Defence in depth behind that gate. If a non agent role ever reaches
    // this far, nothing is written to storage, so the rejected session
    // leaves no token behind to be picked up on the next reload.
    if (data?.user?.role !== 'AGENT') {
      clear()
      throw new Error(
        'This sign in is for agent accounts only. Use the account the operator issued for your shop.',
      )
    }

    setTokens(data.accessToken, data.refreshToken)
    user.value = data.user
    return data
  }

  const logout = async () => {
    const token = refreshToken.value
    if (token) {
      try {
        await $fetch(`${apiBase}/auth/logout`, {
          method: 'POST',
          body: { refreshToken: token },
        })
      } catch {
        // ignore errors on logout
      }
    }
    clear()
    return navigateTo('/login')
  }

  const refresh = async (): Promise<string | null> => {
    if (!refreshToken.value) return null
    try {
      const data = await $fetch<{ accessToken: string; refreshToken: string; user: AgentUser }>(
        `${apiBase}/auth/refresh`,
        { method: 'POST', body: { refreshToken: refreshToken.value } },
      )
      if (data?.user && data.user.role !== 'AGENT') {
        clear()
        return null
      }
      setTokens(data.accessToken, data.refreshToken)
      if (data.user) user.value = data.user
      return data.accessToken
    } catch {
      clear()
      return null
    }
  }

  const checkAuth = async () => {
    if (!accessToken.value && !refreshToken.value) return

    if (!accessToken.value && refreshToken.value) {
      const newToken = await refresh()
      if (!newToken) return
    }

    try {
      const data = await $fetch<AgentUser>(`${apiBase}/auth/me`, {
        headers: { Authorization: `Bearer ${accessToken.value}` },
      })
      if (data?.role !== 'AGENT') {
        clear()
        return
      }
      user.value = data
    } catch (error: unknown) {
      if ((error as { statusCode?: number })?.statusCode === 401) {
        const newToken = await refresh()
        if (!newToken) {
          clear()
          return
        }
      }
      // Network errors and other non-auth failures keep the session as it
      // is. A shop with a flaky connection should not be signed out by a
      // dropped packet in the middle of a queue of customers.
    }
  }

  const apiFetch = async <T = unknown>(
    url: string,
    options: Record<string, unknown> = {},
  ): Promise<T> => {
    const doFetch = (token: string) =>
      $fetch<T>(`${apiBase}${url}`, {
        ...options,
        headers: {
          ...((options.headers as Record<string, string>) || {}),
          Authorization: `Bearer ${token}`,
        },
      })

    if (!accessToken.value) {
      const newToken = await refresh()
      if (!newToken) throw new Error('Not authenticated')
      return doFetch(newToken)
    }

    try {
      return await doFetch(accessToken.value)
    } catch (error: unknown) {
      if ((error as { statusCode?: number })?.statusCode === 401) {
        // A suspension also answers 401, carrying code 'account_suspended'
        // (see the `authenticate` decorator in the API: a JWT proves who you
        // are, not that you are still allowed in). Refreshing cannot fix that.
        // Without this branch the agent gets a token, fails again, and reads
        // "Session expired" while the real reason never reaches the screen.
        if (isSuspension(error)) {
          await logout()
          if (import.meta.client) await navigateTo('/login?suspended=1')
          throw new Error(apiErrorMessage(error, SUSPENDED_MESSAGE), { cause: error })
        }
        const newToken = await refresh()
        if (!newToken) {
          await logout()
          throw new Error('Session expired', { cause: error })
        }
        return doFetch(newToken)
      }
      throw error
    }
  }

  return {
    user,
    accessToken,
    refreshToken,
    isAgent,
    login,
    logout,
    refresh,
    checkAuth,
    apiFetch,
  }
}
