export const useAdminApi = () => {
    const { apiFetch } = useAdminAuth()

    return {
        fetch: apiFetch,
        getStats: () => apiFetch<Record<string, number>>('/admin/stats'),
        getPendingDeposits: (status?: string) => apiFetch<any[]>(`/admin/transactions/pending${status ? `?status=${status}` : ''}`),
        getTransactionsHistory: (params?: { type?: string; page?: number; limit?: number }) => {
            const qs = new URLSearchParams()
            if (params?.type) qs.set('type', params.type)
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            const query = qs.toString()
            return apiFetch<any[]>(`/admin/transactions/history${query ? `?${query}` : ''}`)
        },
        getWithdrawals: (status?: string) => apiFetch<any[]>(`/admin/withdrawals${status ? `?status=${status}` : ''}`),
        approveTransaction: (id: string) => apiFetch(`/admin/transactions/${id}/approve`, { method: 'POST' }),
        declineTransaction: (id: string, note?: string) =>
            apiFetch(`/admin/transactions/${id}/decline`, { method: 'POST', body: { note } }),
        getUsers: (params?: { page?: number; limit?: number; search?: string; role?: string }) => {
            const qs = new URLSearchParams()
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            if (params?.search) qs.set('search', params.search)
            if (params?.role) qs.set('role', params.role)
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

        // ── Game Templates ──────────────────────────────────────────────────
        getGameTemplates: () => apiFetch<any[]>('/admin/game-templates'),
        createGameTemplate: (data: {
            title: string
            ticketPrice: number
            maxPlayers: number
            minPlayers: number
            houseEdgePct: number
            pattern: string
            countdownSecs: number
            botEnabled: boolean
            botCount: number
            botFillToMin: boolean
        }) => apiFetch('/admin/game-templates', { method: 'POST', body: data }),
        updateGameTemplate: (id: string, data: Record<string, any>) =>
            apiFetch(`/admin/game-templates/${id}`, { method: 'PATCH', body: data }),
        deleteGameTemplate: (id: string) =>
            apiFetch(`/admin/game-templates/${id}`, { method: 'DELETE' }),
        injectBots: (gameId: string) =>
            apiFetch(`/admin/games/${gameId}/inject-bots`, { method: 'POST' }),

        // ── Feature Flags / Site Settings ───────────────────────────────────
        getFeatureFlags: () => apiFetch<Record<string, boolean>>('/settings/features'),
        updateFeatureFlags: (flags: Record<string, boolean>) =>
            apiFetch('/settings/features', { method: 'PUT', body: flags }),

        getGameSettings: () => apiFetch<{ ball_interval_secs: number; bot_max_spend_etb: number }>('/settings/game'),
        updateGameSettings: (data: { ball_interval_secs?: number; bot_max_spend_etb?: number }) =>
            apiFetch('/settings/game', { method: 'PUT', body: data }),

        // ── House Wallet ──────────────────────────────────────────────────────
        getHouseWallet: () => apiFetch<{ balance: string; currency: string; summary: Record<string, number> }>('/admin/house/wallet'),
        getHouseTransactions: (params?: { page?: number; limit?: number; type?: string }) => {
            const qs = new URLSearchParams()
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            if (params?.type) qs.set('type', params.type)
            const query = qs.toString()
            return apiFetch<any>(`/admin/house/transactions${query ? `?${query}` : ''}`)
        },
        getBotActivity: () => apiFetch<any[]>('/admin/house/bots'),
    }
}

