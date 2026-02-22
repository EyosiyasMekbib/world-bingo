export const useAdminApi = () => {
    const { apiFetch } = useAdminAuth()

    return {
        fetch: apiFetch,
        getStats: () => apiFetch<Record<string, number>>('/admin/stats'),
        getPendingDeposits: () => apiFetch<any[]>('/admin/transactions/pending'),
        getTransactionsHistory: () => apiFetch<any[]>('/admin/transactions/history'),
        getWithdrawals: () => apiFetch<any[]>('/admin/withdrawals'),
        approveTransaction: (id: string) => apiFetch(`/admin/transactions/${id}/approve`, { method: 'POST' }),
        declineTransaction: (id: string, note?: string) =>
            apiFetch(`/admin/transactions/${id}/decline`, { method: 'POST', body: { note } }),
        getUsers: (params?: { page?: number; limit?: number }) =>
            apiFetch<any>(`/admin/users${params ? `?page=${params.page ?? 1}&limit=${params.limit ?? 20}` : ''}`),
        getGames: () => apiFetch<any[]>('/admin/games'),
    }
}

