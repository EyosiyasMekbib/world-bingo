export const useAdminApi = () => {
    const { apiFetch } = useAdminAuth()

    return {
        fetch: apiFetch,
        getStats: () => apiFetch<Record<string, number>>('/admin/stats'),
        getPendingDeposits: () => apiFetch<any[]>('/admin/transactions/pending'),
        getTransactionsHistory: (params?: { type?: string; page?: number; limit?: number }) => {
            const qs = new URLSearchParams()
            if (params?.type) qs.set('type', params.type)
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            const query = qs.toString()
            return apiFetch<any[]>(`/admin/transactions/history${query ? `?${query}` : ''}`)
        },
        getWithdrawals: () => apiFetch<any[]>('/admin/withdrawals'),
        approveTransaction: (id: string) => apiFetch(`/admin/transactions/${id}/approve`, { method: 'POST' }),
        declineTransaction: (id: string, note?: string) =>
            apiFetch(`/admin/transactions/${id}/decline`, { method: 'POST', body: { note } }),
        getUsers: (params?: { page?: number; limit?: number; search?: string }) => {
            const qs = new URLSearchParams()
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            if (params?.search) qs.set('search', params.search)
            const query = qs.toString()
            return apiFetch<any>(`/admin/users${query ? `?${query}` : ''}`)
        },
        getGames: (params?: { status?: string; page?: number; limit?: number }) => {
            const qs = new URLSearchParams()
            if (params?.status) qs.set('status', params.status)
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            const query = qs.toString()
            return apiFetch<any>(`/admin/games${query ? `?${query}` : ''}`)
        },
        cancelGame: (id: string) => apiFetch(`/admin/games/${id}/cancel`, { method: 'POST' }),
        startGame: (id: string) => apiFetch(`/admin/games/${id}/start`, { method: 'POST' }),
        updateUserRole: (id: string, role: string) =>
            apiFetch(`/admin/users/${id}/status`, { method: 'PATCH', body: { role } }),
    }
}

