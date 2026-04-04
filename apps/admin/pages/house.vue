<script setup lang="ts">
const { getHouseWallet, getHouseTransactions, getBotActivity, getGameSettings } = useAdminApi()
const toast = useToast()

// ── House wallet ─────────────────────────────────────────────────────────────
const walletLoading = ref(false)
const balance = ref('0.00')
const summary = ref<Record<string, number>>({ COMMISSION: 0, BOT_PRIZE_WIN: 0, REFUND_ISSUED: 0 })

const fetchWallet = async () => {
  walletLoading.value = true
  try {
    const data = await getHouseWallet()
    balance.value = data.balance
    summary.value = data.summary ?? { COMMISSION: 0, BOT_PRIZE_WIN: 0, REFUND_ISSUED: 0 }
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch house wallet', color: 'error' })
  } finally {
    walletLoading.value = false
  }
}

// ── Transactions ─────────────────────────────────────────────────────────────
const txPage = ref(1)
const txFilter = ref('')
const txFrom = ref('')
const txTo = ref('')
const txLoading = ref(false)
const transactions = ref<any[]>([])
const txTotal = ref(0)
const TX_LIMIT = 20

const filterOptions = [
  { label: 'All Types', value: '' },
  { label: 'Commission', value: 'COMMISSION' },
  { label: 'Bot Win', value: 'BOT_PRIZE_WIN' },
  { label: 'Refund', value: 'REFUND_ISSUED' },
]

const fetchTransactions = async () => {
  txLoading.value = true
  try {
    const data = await getHouseTransactions({
      page: txPage.value,
      limit: TX_LIMIT,
      type: txFilter.value || undefined,
      from: txFrom.value || undefined,
      to: txTo.value || undefined,
    })
    transactions.value = data.transactions ?? []
    txTotal.value = data.total ?? 0
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch transactions', color: 'error' })
  } finally {
    txLoading.value = false
  }
}

watch([txPage, txFilter, txFrom, txTo], fetchTransactions)

const txColumns = [
  { accessorKey: 'createdAt', header: 'Date / Time' },
  { accessorKey: 'type', header: 'Type' },
  { accessorKey: 'amount', header: 'Amount' },
  { accessorKey: 'description', header: 'Description' },
  { accessorKey: 'gameId', header: 'Game ID' },
  { accessorKey: 'userId', header: 'Player / Bot' },
  { accessorKey: 'balanceAfter', header: 'Balance After' },
]

const txTypeColor = (type: string) => {
  if (type === 'COMMISSION') return 'primary'
  if (type === 'BOT_PRIZE_WIN') return 'warning'
  return 'error'
}

const txTypeLabel = (type: string) => {
  if (type === 'COMMISSION') return 'Commission'
  if (type === 'BOT_PRIZE_WIN') return 'Bot Win'
  return 'Refund'
}

const copyId = (id: string) => {
  navigator.clipboard.writeText(id).catch(() => {})
  toast.add({ title: 'Copied', description: id, color: 'success' })
}

const totalPages = computed(() => Math.max(1, Math.ceil(txTotal.value / TX_LIMIT)))

// ── Bots ─────────────────────────────────────────────────────────────────────
const botsLoading = ref(false)
const bots = ref<any[]>([])
const globalSpendLimit = ref(500)

const fetchBots = async () => {
  botsLoading.value = true
  try {
    const [botData, settings] = await Promise.all([getBotActivity(), getGameSettings()])
    bots.value = botData ?? []
    globalSpendLimit.value = settings.bot_max_spend_etb ?? 500
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch bot activity', color: 'error' })
  } finally {
    botsLoading.value = false
  }
}

const botColumns = [
  { accessorKey: 'username', header: 'Bot Username' },
  { accessorKey: 'totalSpent', header: 'Total Spent (ETB)' },
  { accessorKey: 'gamesPlayed', header: 'Games Played' },
  { accessorKey: 'gamesWon', header: 'Won' },
  { accessorKey: 'gamesLost', header: 'Lost' },
  { accessorKey: 'spendLimit', header: 'Spend Limit' },
  { accessorKey: 'status', header: 'Status' },
]

const effectiveLimit = (bot: any) => bot.templateBotMaxSpend !== null ? bot.templateBotMaxSpend : globalSpendLimit.value
const spendWarning = (bot: any) => bot.totalSpent >= effectiveLimit(bot) * 0.8

onMounted(() => {
  fetchWallet()
  fetchTransactions()
  fetchBots()
})
</script>

<template>
  <div class="space-y-8">
    <!-- Page title -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">House Wallet</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Platform income — commissions, bot wins, and refunds.</p>
      </div>
      <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" :loading="walletLoading" @click="fetchWallet(); fetchTransactions(); fetchBots()">
        Refresh
      </UButton>
    </div>

    <!-- ── Section 1: Balance card ────────────────────────────────────────── -->
    <div class="rounded-2xl border border-(--surface-border) p-6 shadow-xl" style="background:var(--surface-raised);">
      <p class="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-3">Current House Balance</p>
      <div class="flex items-end gap-3 mb-2">
        <span class="text-5xl font-extrabold tabular-nums"
          :class="Number(balance) < 0 ? 'text-red-400' : 'text-yellow-400'">
          {{ balance }}
        </span>
        <span class="text-xl font-bold mb-1"
          :class="Number(balance) < 0 ? 'text-red-400/60' : 'text-yellow-400/60'">
          ETB
        </span>
      </div>
      <div v-if="Number(balance) < 0" class="mb-4">
        <UBadge color="error" variant="soft" icon="i-heroicons:exclamation-triangle">
          ⚠ House is in deficit — prizes exceeded commissions
        </UBadge>
      </div>
      <div class="grid grid-cols-3 gap-4">
        <div class="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
          <p class="text-[10px] font-bold text-blue-400/70 uppercase tracking-widest mb-1">Commissions</p>
          <p class="text-xl font-bold text-blue-400">{{ summary.COMMISSION?.toFixed(2) ?? '0.00' }} ETB</p>
        </div>
        <div class="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4">
          <p class="text-[10px] font-bold text-yellow-400/70 uppercase tracking-widest mb-1">Bot Prize Wins</p>
          <p class="text-xl font-bold text-yellow-400">{{ summary.BOT_PRIZE_WIN?.toFixed(2) ?? '0.00' }} ETB</p>
        </div>
        <div class="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <p class="text-[10px] font-bold text-red-400/70 uppercase tracking-widest mb-1">Refunds Issued</p>
          <p class="text-xl font-bold text-red-400">-{{ summary.REFUND_ISSUED?.toFixed(2) ?? '0.00' }} ETB</p>
        </div>
      </div>
    </div>

    <!-- ── Section 2: Transaction history ────────────────────────────────── -->
    <div class="space-y-4">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <h2 class="text-lg font-bold text-white">Transaction History</h2>
        <div class="flex items-center gap-3 flex-wrap">
          <USelect
            v-model="txFilter"
            :items="filterOptions"
            value-key="value"
            size="sm"
            class="w-40"
          />
          <UInput v-model="txFrom" type="date" size="sm" class="w-40" />
          <UInput v-model="txTo" type="date" size="sm" class="w-40" />
          <UButton
            v-if="txFilter || txFrom || txTo"
            size="sm" color="neutral" variant="ghost"
            icon="i-heroicons:x-mark"
            @click="txFilter = ''; txFrom = ''; txTo = ''; txPage = 1"
          >
            Reset
          </UButton>
        </div>
      </div>

      <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl" style="background:var(--surface-raised);">
        <UTable :columns="txColumns" :data="transactions" :loading="txLoading">
          <template #createdAt-cell="{ row }">
            <span class="text-white/60 text-xs font-mono">{{ new Date(row.original.createdAt).toLocaleString() }}</span>
          </template>
          <template #type-cell="{ row }">
            <UBadge :color="txTypeColor(row.original.type)" variant="soft" size="sm">
              {{ txTypeLabel(row.original.type) }}
            </UBadge>
          </template>
          <template #amount-cell="{ row }">
            <span :class="row.original.type === 'REFUND_ISSUED' ? 'text-red-400' : 'text-green-400'" class="font-bold font-mono">
              {{ row.original.type === 'REFUND_ISSUED' ? '-' : '+' }}{{ Number(row.original.amount).toFixed(2) }} ETB
            </span>
          </template>
          <template #gameId-cell="{ row }">
            <span
              v-if="row.original.gameId"
              class="text-xs font-mono text-blue-400 cursor-pointer hover:text-blue-300 transition-colors"
              :title="row.original.gameId"
              @click="copyId(row.original.gameId)"
            >
              {{ row.original.gameId.slice(0, 8) }}…
            </span>
            <span v-else class="text-white/30">—</span>
          </template>
          <template #userId-cell="{ row }">
            <span v-if="row.original.userId" class="text-xs font-mono text-white/50 truncate max-w-24 block">
              {{ row.original.userId.slice(0, 8) }}…
            </span>
            <span v-else class="text-white/30">—</span>
          </template>
          <template #balanceAfter-cell="{ row }">
            <span class="font-mono text-white/70 text-sm">{{ Number(row.original.balanceAfter).toFixed(2) }}</span>
          </template>
        </UTable>
      </div>

      <!-- Pagination -->
      <div class="flex items-center justify-between px-1">
        <p class="text-sm text-white/40">{{ txTotal }} total transactions</p>
        <div class="flex items-center gap-2">
          <UButton size="xs" color="neutral" variant="soft" :disabled="txPage <= 1" @click="txPage--">Previous</UButton>
          <span class="text-sm text-white/60 font-mono">{{ txPage }} / {{ totalPages }}</span>
          <UButton size="xs" color="neutral" variant="soft" :disabled="txPage >= totalPages" @click="txPage++">Next</UButton>
        </div>
      </div>
    </div>

    <!-- ── Section 3: Bot activity ────────────────────────────────────────── -->
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-bold text-white">Bot Activity</h2>
        <p class="text-xs text-white/40">Global spend limit: <strong class="text-white/70">{{ globalSpendLimit }} ETB</strong></p>
      </div>

      <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl" style="background:var(--surface-raised);">
        <UTable :columns="botColumns" :data="bots" :loading="botsLoading">
          <template #username-cell="{ row }">
            <span class="font-mono text-sm text-white/80">{{ row.original.username }}</span>
          </template>
          <template #totalSpent-cell="{ row }">
            <span class="font-bold font-mono text-yellow-400">{{ Number(row.original.totalSpent).toFixed(2) }}</span>
          </template>
          <template #spendLimit-cell="{ row }">
            <div class="flex items-center gap-1.5">
              <span class="font-mono text-sm text-white/60">{{ effectiveLimit(row.original) }} ETB</span>
              <UIcon
                v-if="spendWarning(row.original)"
                name="i-heroicons:exclamation-triangle"
                class="w-4 h-4 text-yellow-400"
                title="Bot is at ≥80% of spend limit"
              />
            </div>
          </template>
          <template #status-cell="{ row }">
            <UBadge :color="row.original.isActive ? 'success' : 'neutral'" variant="soft" size="sm">
              {{ row.original.isActive ? 'Active' : 'Inactive' }}
            </UBadge>
          </template>
        </UTable>
        <div v-if="bots.length === 0 && !botsLoading" class="py-12 text-center text-white/30 text-sm">
          No bot activity yet.
        </div>
      </div>
    </div>
  </div>
</template>
