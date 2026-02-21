export const useAdminApi = () => {
    const config = useRuntimeConfig()
    const token = useCookie('admin_token')

    const fetch = async (url: string, options: any = {}) => {
        return await $fetch(url, {
            baseURL: config.public.apiBase,
            headers: {
                ...options.headers,
                Authorization: token.value ? `Bearer ${token.value}` : '',
            },
            ...options,
        })
    }

    return {
        fetch,
        getStats: () => fetch('/admin/stats'),
        getPendingDeposits: () => fetch('/admin/transactions/pending'),
        getTransactionsHistory: () => fetch('/admin/transactions/history'),
        getWithdrawals: () => fetch('/admin/withdrawals'),
        approveTransaction: (id: string) => fetch(`/admin/transactions/${id}/approve`, { method: 'POST' }),
        declineTransaction: (id: string, note?: string) => fetch(`/admin/transactions/${id}/decline`, { method: 'POST', body: { note } }),
    }
}
