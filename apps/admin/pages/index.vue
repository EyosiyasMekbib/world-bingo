<script setup lang="ts">
import { ref } from 'vue'

const { getStats } = useAdminApi()
const stats = ref([
  { label: 'Approved Deposit Sum', key: 'approvedDepositSum', value: '0 ETB', icon: 'i-heroicons-banknotes' },
  { label: 'Declined Deposit Sum', key: 'declinedDepositSum', value: '0 ETB', icon: 'i-heroicons-x-circle' },
  { label: 'Approved Withdrawal Sum', key: 'approvedWithdrawalSum', value: '0 ETB', icon: 'i-heroicons-arrow-up-tray' },
  { label: 'Total Profit', key: 'totalProfit', value: '0 ETB', icon: 'i-heroicons-currency-dollar' },
  { label: 'Users Count', key: 'usersCount', value: '0', icon: 'i-heroicons-users' },
  { label: 'Commission', key: 'commission', value: '0%', icon: 'i-heroicons-receipt-percent' }
])

const refreshStats = async () => {
  try {
    const data: any = await getStats()
    stats.value = stats.value.map(s => ({
      ...s,
      value: s.key === 'usersCount' ? String(data[s.key]) : (s.key === 'commission' ? `${data[s.key]}%` : `${data[s.key]} ETB`)
    }))
  } catch (error) {
    console.error('Failed to fetch stats', error)
  }
}

onMounted(refreshStats)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">Dashboard</h1>
        <p class="text-sm text-zinc-500 mt-0.5">Platform overview</p>
      </div>
      <UButton icon="i-heroicons-arrow-path" color="neutral" variant="ghost" @click="refreshStats" />
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <div
        v-for="(stat, index) in stats"
        :key="index"
        class="group relative rounded-2xl border border-white/8 p-5 flex items-start justify-between hover:border-amber-400/30 transition-all cursor-default"
        style="background:#111827;"
      >
        <div>
          <p class="text-xs font-medium text-zinc-500 uppercase tracking-wider">{{ stat.label }}</p>
          <p class="mt-2 text-2xl font-bold text-amber-400">{{ stat.value }}</p>
        </div>
        <div class="p-2.5 rounded-xl border border-amber-400/20 group-hover:border-amber-400/40 transition-colors" style="background:rgba(245,158,11,0.08);">
          <UIcon :name="stat.icon" class="w-5 h-5 text-amber-400" />
        </div>
      </div>
    </div>
  </div>
</template>
