export const useAdminAuth = () => {
    const token = useCookie('admin_token')
    const user = useState<any>('admin_user', () => null)
    const config = useRuntimeConfig()

    const login = async (credentials: any) => {
        try {
            const data: any = await $fetch(`${config.public.apiBase}/auth/admin/login`, {
                method: 'POST',
                body: credentials,
            })
            token.value = data.token
            user.value = data.user
            return data
        } catch (error) {
            throw error
        }
    }

    const logout = () => {
        token.value = null
        user.value = null
        navigateTo('/login')
    }

    const checkAuth = async () => {
        if (!token.value) return
        try {
            const data: any = await $fetch(`${config.public.apiBase}/auth/me`, {
                headers: {
                    Authorization: `Bearer ${token.value}`,
                },
            })
            user.value = data
        } catch (error) {
            logout()
        }
    }

    return {
        user,
        token,
        login,
        logout,
        checkAuth,
        isAdmin: computed(() => user.value?.role === 'ADMIN' || user.value?.role === 'SUPER_ADMIN'),
    }
}
