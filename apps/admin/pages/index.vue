<script setup lang="ts">
import { ref } from 'vue'

const { getStats } = useAdminApi()
const stats = ref([
  { label: 'Approved Deposit Sum', key: 'approvedDepositSum', value: '0 ETB', icon: 'i-heroicons:banknotes' },
  { label: 'Declined Deposit Sum', key: 'declinedDepositSum', value: '0 ETB', icon: 'i-heroicons:x-circle' },
  { label: 'Approved Withdrawal Sum', key: 'approvedWithdrawalSum', value: '0 ETB', icon: 'i-heroicons:arrow-up-tray' },
  { label: 'Total Profit', key: 'totalProfit', value: '0 ETB', icon: 'i-heroicons:currency-dollar' },
  { label: 'Users Count', key: 'usersCount', value: '0', icon: 'i-heroicons:users' },
  { label: 'Commission', key: 'commission', value: '0%', icon: 'i-heroicons:receipt-percent' }
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
        <h1 class="text-2xl font-bold text-white tracking-tight">Dashboard Overview</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Platform performance and statistics</p>
      </div>
      <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" @click="refreshStats" />
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <div
        v-for="(stat, index) in stats"
        :key="index"
        class="group relative rounded-2xl border border-(--surface-border) p-5 flex items-start justify-between hover:border-yellow-400/30 transition-all cursor-default shadow-lg"
        style="background:var(--surface-raised);"
      >
        <div>
          <p class="text-xs font-semibold text-white/50 uppercase tracking-widest">{{ stat.label }}</p>
          <p class="mt-2 text-2xl font-bold text-yellow-500 tracking-tight">{{ stat.value }}</p>
        </div>
        <div class="p-2.5 rounded-xl border border-yellow-400/20 group-hover:border-yellow-400/40 transition-all duration-300" style="background:rgba(255,215,0,0.05);">
          <UIcon :name="stat.icon" class="w-5 h-5 text-yellow-500 group-hover:scale-110 transition-transform" />
        </div>
      </div>
    </div>
  </div>
</template>
