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
      <h1 class="text-2xl font-semibold text-gray-900">Dashboard</h1>
      <UButton icon="i-heroicons-arrow-path" color="neutral" variant="ghost" />
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <UCard v-for="(stat, index) in stats" :key="index" class="relative group overflow-hidden hover:shadow-lg transition-all">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-sm font-medium text-gray-500">{{ stat.label }}</p>
            <p class="mt-2 text-3xl font-bold text-gray-900">{{ stat.value }}</p>
          </div>
          <div class="p-3 bg-primary-50 rounded-lg group-hover:bg-primary-100 transition-colors">
            <UIcon :name="stat.icon" class="w-6 h-6 text-primary-600" />
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>
