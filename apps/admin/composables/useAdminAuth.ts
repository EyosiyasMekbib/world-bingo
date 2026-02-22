export const useAdminAuth = () => {
    const accessToken = useCookie('admin_access_token', {
        maxAge: 60 * 15, // 15 minutes
        sameSite: 'lax',
    })
    const refreshToken = useCookie('admin_refresh_token', {
        maxAge: 60 * 60 * 24 * 30, // 30 days
        sameSite: 'lax',
        httpOnly: false, // We need JS access to call /auth/refresh
    })
    const user = useState<any>('admin_user', () => null)
    const config = useRuntimeConfig()

    const login = async (credentials: any) => {
        const data: any = await $fetch(`${config.public.apiBase}/auth/admin/login`, {
            method: 'POST',
            body: credentials,
        })
        accessToken.value = data.accessToken
        refreshToken.value = data.refreshToken
        user.value = data.user
        return data
    }

    const logout = async () => {
        if (refreshToken.value) {
            try {
                await $fetch(`${config.public.apiBase}/auth/logout`, {
                    method: 'POST',
                    body: { refreshToken: refreshToken.value },
                })
            } catch {
                // ignore errors on logout
            }
        }
        accessToken.value = null
        refreshToken.value = null
        user.value = null
        navigateTo('/login')
    }

    const refresh = async (): Promise<string | null> => {
        if (!refreshToken.value) return null
        try {
            const data: any = await $fetch(`${config.public.apiBase}/auth/refresh`, {
                method: 'POST',
                body: { refreshToken: refreshToken.value },
            })
            accessToken.value = data.accessToken
            refreshToken.value = data.refreshToken
            user.value = data.user
            return data.accessToken
        } catch {
            accessToken.value = null
            refreshToken.value = null
            user.value = null
            return null
        }
    }

    const checkAuth = async () => {
        if (!accessToken.value && !refreshToken.value) return

        // If access token is missing but refresh token exists, try to refresh
        if (!accessToken.value && refreshToken.value) {
            const newToken = await refresh()
            if (!newToken) return
        }

        try {
            const data: any = await $fetch(`${config.public.apiBase}/auth/me`, {
                headers: {
                    Authorization: `Bearer ${accessToken.value}`,
                },
            })
            user.value = data
        } catch (error: any) {
            if (error?.statusCode === 401) {
                // Token expired — try to refresh
                const newToken = await refresh()
                if (!newToken) {
                    logout()
                }
            } else {
                logout()
            }
        }
    }

    const apiFetch = async <T = unknown>(url: string, options: any = {}): Promise<T> => {
        const doFetch = (token: string) =>
            $fetch<T>(`${config.public.apiBase}${url}`, {
                ...options,
                headers: {
                    ...options.headers,
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
        } catch (error: any) {
            if (error?.statusCode === 401) {
                const newToken = await refresh()
                if (!newToken) {
                    await logout()
                    throw new Error('Session expired')
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
        login,
        logout,
        refresh,
        checkAuth,
        apiFetch,
        isAdmin: computed(() => user.value?.role === 'ADMIN' || user.value?.role === 'SUPER_ADMIN'),
    }
}

