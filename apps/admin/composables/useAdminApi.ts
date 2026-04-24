export const useAdminApi = () => {
    const { apiFetch } = useAdminAuth()

    return {
        fetch: apiFetch,
        getStats: () => apiFetch<{
            approvedDepositSum: number
            approvedWithdrawalSum: number
            totalPrizesSum: number
            gamesCompleted: number
            gamesCancelled: number
            totalPrizePools: number
            activePlayers: number
            houseBalance: number
            houseCommissionEarned: number
            providerStats: Array<{ name: string; gained: number; lost: number; net: number }>
            declinedDepositSum: number
            usersCount: number
            gamesCount: number
            totalProfit: number
            commission: number
        }>('/admin/stats'),
        getPendingDeposits: (params?: {
            status?: string
            search?: string
            userSerial?: number
            from?: string
            to?: string
            minAmount?: number
            maxAmount?: number
            page?: number
            limit?: number
        }) => {
            const qs = new URLSearchParams()
            if (params?.status) qs.set('status', params.status)
            if (params?.search) qs.set('search', params.search)
            if (params?.userSerial) qs.set('userSerial', String(params.userSerial))
            if (params?.from) qs.set('from', params.from)
            if (params?.to) qs.set('to', params.to)
            if (params?.minAmount !== undefined) qs.set('minAmount', String(params.minAmount))
            if (params?.maxAmount !== undefined) qs.set('maxAmount', String(params.maxAmount))
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            const query = qs.toString()
            return apiFetch<any>(`/admin/transactions/pending${query ? `?${query}` : ''}`)
        },
        getTransactionsHistory: (params?: { type?: string; page?: number; limit?: number }) => {
            const qs = new URLSearchParams()
            if (params?.type) qs.set('type', params.type)
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            const query = qs.toString()
            return apiFetch<any[]>(`/admin/transactions/history${query ? `?${query}` : ''}`)
        },
        getWithdrawals: (params?: {
            status?: string
            search?: string
            userSerial?: number
            from?: string
            to?: string
            minAmount?: number
            maxAmount?: number
            page?: number
            limit?: number
        }) => {
            const qs = new URLSearchParams()
            if (params?.status) qs.set('status', params.status)
            if (params?.search) qs.set('search', params.search)
            if (params?.userSerial) qs.set('userSerial', String(params.userSerial))
            if (params?.from) qs.set('from', params.from)
            if (params?.to) qs.set('to', params.to)
            if (params?.minAmount !== undefined) qs.set('minAmount', String(params.minAmount))
            if (params?.maxAmount !== undefined) qs.set('maxAmount', String(params.maxAmount))
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            const query = qs.toString()
            return apiFetch<any>(`/admin/withdrawals${query ? `?${query}` : ''}`)
        },
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

        getGameSettings: () => apiFetch<{ ball_interval_secs: number; bot_max_spend_etb: number; first_deposit_bonus_amount: number; featured_template_id: string }>('/settings/game'),
        updateGameSettings: (data: { ball_interval_secs?: number; bot_max_spend_etb?: number; first_deposit_bonus_amount?: number; featured_template_id?: string }) =>
            apiFetch('/settings/game', { method: 'PUT', body: data }),

        // ── House Wallet ──────────────────────────────────────────────────────
        getHouseWallet: () => apiFetch<{ balance: string; currency: string; summary: Record<string, number> }>('/admin/house/wallet'),
        getHouseTransactions: (params?: { page?: number; limit?: number; type?: string; from?: string; to?: string }) => {
            const qs = new URLSearchParams()
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            if (params?.type) qs.set('type', params.type)
            if (params?.from) qs.set('from', params.from)
            if (params?.to) qs.set('to', params.to)
            const query = qs.toString()
            return apiFetch<any>(`/admin/house/transactions${query ? `?${query}` : ''}`)
        },
        getBotActivity: () => apiFetch<any[]>('/admin/house/bots'),
        getMoneyFlow: (params?: {
            page?: number
            limit?: number
            direction?: 'IN' | 'OUT'
            types?: string[]
            from?: string
            to?: string
            search?: string
        }) => {
            const qs = new URLSearchParams()
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            if (params?.direction) qs.set('direction', params.direction)
            if (params?.from) qs.set('from', params.from)
            if (params?.to) qs.set('to', params.to)
            if (params?.search) qs.set('search', params.search)
            params?.types?.forEach(t => qs.append('type[]', t))
            const query = qs.toString()
            return apiFetch<{
                rows: Array<{
                    id: string
                    createdAt: string
                    type: string
                    direction: 'IN' | 'OUT'
                    amount: number
                    playerName?: string
                    playerId?: string
                    gameId?: string
                    source: string
                    balanceAfter?: number
                }>
                total: number
                page: number
                limit: number
                summary: {
                    totalDeposited: number
                    totalWagered: number
                    totalPrizesOut: number
                    houseKept: number
                    refundsIssued: number
                }
            }>(`/admin/money-flow${query ? `?${query}` : ''}`)
        },

        // ── Player Management ─────────────────────────────────────────────
        getPlayer: (id: string) => apiFetch<any>(`/admin/players/${id}`),
        adjustPlayerBalance: (id: string, data: { type: 'real' | 'bonus'; amount: number; note: string }) =>
            apiFetch(`/admin/players/${id}/adjust-balance`, { method: 'POST', body: data }),

        // ── Game Providers ────────────────────────────────────────────────
        getProviders: () => apiFetch<any[]>('/admin/providers'),
        updateProviderStatus: (id: string, status: string) =>
            apiFetch(`/admin/providers/${id}/status`, { method: 'PATCH', body: { status } }),
        syncProvider: (code: string) =>
            apiFetch(`/admin/providers/${code}/sync`, { method: 'POST' }),
        getProviderVendors: (code: string) =>
            apiFetch<any[]>(`/admin/providers/${code}/vendors`),
        updateVendorStatus: (providerCode: string, vendorCode: string, isActive: boolean) =>
            apiFetch(`/admin/providers/${providerCode}/vendors/${vendorCode}/status`, { method: 'PATCH', body: { isActive } }),
        getProviderGames: (code: string, params?: { page?: number; limit?: number }) => {
            const qs = new URLSearchParams()
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            const query = qs.toString()
            return apiFetch<any>(`/admin/providers/${code}/games${query ? `?${query}` : ''}`)
        },
        updateGameStatus: (providerCode: string, gameCode: string, isActive: boolean) =>
            apiFetch(`/admin/providers/${providerCode}/games/${gameCode}/status`, { method: 'PATCH', body: { isActive } }),
        getProviderTransactions: (code: string, params?: { page?: number; limit?: number }) => {
            const qs = new URLSearchParams()
            if (params?.page) qs.set('page', String(params.page))
            if (params?.limit) qs.set('limit', String(params.limit))
            const query = qs.toString()
            return apiFetch<any>(`/admin/providers/${code}/transactions${query ? `?${query}` : ''}`)
        },

        // ── Payment Methods ───────────────────────────────────────────────
        getPaymentMethods: () => apiFetch<any[]>('/admin/payment-methods'),
        createPaymentMethod: (data: any) => apiFetch<any>('/admin/payment-methods', { method: 'POST', body: data }),
        updatePaymentMethod: (id: string, data: any) => apiFetch<any>(`/admin/payment-methods/${id}`, { method: 'PUT', body: data }),
        deletePaymentMethod: (id: string) => apiFetch<void>(`/admin/payment-methods/${id}`, { method: 'DELETE' }),

        // ── Cashback Promotions ───────────────────────────────────────────
        getCashbackPromotions: () => apiFetch<any[]>('/admin/cashback'),
        createCashbackPromotion: (data: {
            name: string
            lossThreshold: number
            refundType: 'PERCENTAGE' | 'FIXED'
            refundValue: number
            frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
            startsAt: string
            endsAt: string
        }) => apiFetch('/admin/cashback', { method: 'POST', body: data }),
        toggleCashbackPromotion: (id: string, isActive: boolean) =>
            apiFetch(`/admin/cashback/${id}/toggle`, { method: 'PATCH', body: { isActive } }),
    }
}

