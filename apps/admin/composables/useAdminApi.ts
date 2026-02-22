export const useAdminApi = () => {
    const config = useRuntimeConfig()
    const token = useCookie('admin_token')

    const apiFetch = async <T = unknown>(url: string, options: any = {}): Promise<T> => {
        return await $fetch<T>(url, {
            baseURL: config.public.apiBase,
            headers: {
                ...options.headers,
                Authorization: token.value ? `Bearer ${token.value}` : '',
            },
            ...options,
        })
    }

    return {
        fetch: apiFetch,
        getStats: () => apiFetch<Record<string, number>>('/admin/stats'),
        getPendingDeposits: () => apiFetch<any[]>('/admin/transactions/pending'),
        getTransactionsHistory: () => apiFetch<any[]>('/admin/transactions/history'),
        getWithdrawals: () => apiFetch<any[]>('/admin/withdrawals'),
        approveTransaction: (id: string) => apiFetch(`/admin/transactions/${id}/approve`, { method: 'POST' }),
        declineTransaction: (id: string, note?: string) => apiFetch(`/admin/transactions/${id}/decline`, { method: 'POST', body: { note } }),
    }
}
