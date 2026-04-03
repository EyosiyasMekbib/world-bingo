<script setup lang="ts">
const { getStats } = useAdminApi()

const loading = ref(false)
const stats = ref<{
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
} | null>(null)

const refresh = async () => {
  loading.value = true
  try {
    stats.value = await getStats() as any
  } catch (e) {
    console.error('Failed to fetch stats', e)
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

const fmt = (n: number) =>
  n.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const houseIsDeficit = computed(() => (stats.value?.houseBalance ?? 0) < 0)
</script>

<template>
  <div class="space-y-8">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Dashboard Overview</h1>
        <p class="text-sm text-white/50 mt-0.5">Platform performance and financials</p>
      </div>
      <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" :loading="loading" @click="refresh">
        Refresh
      </UButton>
    </div>

    <!-- ── Section A: Money In / Out ──────────────────────────────────────── -->
    <div>
      <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-3">Money In / Out</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

        <div class="rounded-2xl border border-green-500/20 bg-green-500/5 p-5">
          <p class="text-[10px] font-bold text-green-400/70 uppercase tracking-widest">Total Deposits Approved</p>
          <p class="mt-2 text-2xl font-bold text-green-400 tabular-nums">{{ fmt(stats?.approvedDepositSum ?? 0) }} ETB</p>
        </div>

        <div class="rounded-2xl border border-red-500/20 bg-red-500/5 p-5">
          <p class="text-[10px] font-bold text-red-400/70 uppercase tracking-widest">Total Withdrawals Approved</p>
          <p class="mt-2 text-2xl font-bold text-red-400 tabular-nums">{{ fmt(stats?.approvedWithdrawalSum ?? 0) }} ETB</p>
        </div>

        <div class="rounded-2xl border border-white/10 bg-white/5 p-5">
          <p class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Net (Deposits − Withdrawals)</p>
          <p class="mt-2 text-2xl font-bold tabular-nums"
            :class="(stats?.approvedDepositSum ?? 0) - (stats?.approvedWithdrawalSum ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'">
            {{ fmt((stats?.approvedDepositSum ?? 0) - (stats?.approvedWithdrawalSum ?? 0)) }} ETB
          </p>
        </div>

        <div class="rounded-2xl border border-red-500/20 bg-red-500/5 p-5">
          <p class="text-[10px] font-bold text-red-400/70 uppercase tracking-widest">Total Prizes Paid Out</p>
          <p class="mt-2 text-2xl font-bold text-red-400 tabular-nums">{{ fmt(stats?.totalPrizesSum ?? 0) }} ETB</p>
        </div>

        <div class="rounded-2xl border p-5"
          :class="houseIsDeficit
            ? 'border-red-500/40 bg-red-500/5'
            : 'border-yellow-400/20 bg-yellow-400/5'">
          <div class="flex items-center gap-2 mb-1">
            <p class="text-[10px] font-bold uppercase tracking-widest"
              :class="houseIsDeficit ? 'text-red-400/70' : 'text-yellow-400/70'">
              House Wallet Balance
            </p>
            <UBadge v-if="houseIsDeficit" color="error" variant="soft" size="xs">⚠ Deficit</UBadge>
          </div>
          <p class="mt-1 text-2xl font-bold tabular-nums"
            :class="houseIsDeficit ? 'text-red-400' : 'text-yellow-400'">
            {{ fmt(stats?.houseBalance ?? 0) }} ETB
          </p>
        </div>

      </div>

      <!-- Provider Net Table -->
      <div v-if="stats?.providerStats?.length" class="mt-4 rounded-2xl border border-(--surface-border) overflow-hidden shadow-lg" style="background:var(--surface-raised);">
        <div class="px-5 py-3 border-b border-(--surface-border)">
          <p class="text-xs font-bold text-white/40 uppercase tracking-widest">Provider Performance (House Perspective)</p>
        </div>
        <table class="w-full text-sm">
          <thead class="border-b border-(--surface-border)">
            <tr>
              <th class="text-left px-5 py-2 text-white/40 text-xs font-semibold uppercase">Provider</th>
              <th class="text-right px-5 py-2 text-green-400/60 text-xs font-semibold uppercase">Gained (ETB)</th>
              <th class="text-right px-5 py-2 text-red-400/60 text-xs font-semibold uppercase">Lost (ETB)</th>
              <th class="text-right px-5 py-2 text-white/40 text-xs font-semibold uppercase">Net (ETB)</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            <tr v-for="p in stats.providerStats" :key="p.name" class="hover:bg-white/3 transition-colors">
              <td class="px-5 py-3 font-mono text-white/70 text-sm">{{ p.name }}</td>
              <td class="px-5 py-3 text-right font-bold font-mono tabular-nums text-green-400">
                +{{ fmt(p.gained) }}
              </td>
              <td class="px-5 py-3 text-right font-bold font-mono tabular-nums text-red-400">
                -{{ fmt(p.lost) }}
              </td>
              <td class="px-5 py-3 text-right font-bold font-mono tabular-nums"
                :class="p.net >= 0 ? 'text-green-400' : 'text-red-400'">
                {{ p.net >= 0 ? '+' : '' }}{{ fmt(p.net) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── Section B: Game Performance ───────────────────────────────────── -->
    <div>
      <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-3">Game Performance</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

        <div class="rounded-2xl border border-(--surface-border) p-5" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Games Completed</p>
          <p class="mt-2 text-2xl font-bold text-white tabular-nums">{{ stats?.gamesCompleted ?? 0 }}</p>
        </div>

        <div class="rounded-2xl border border-(--surface-border) p-5" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Games Cancelled</p>
          <p class="mt-2 text-2xl font-bold text-white tabular-nums">{{ stats?.gamesCancelled ?? 0 }}</p>
        </div>

        <div class="rounded-2xl border border-(--surface-border) p-5" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Total Prize Pools Generated</p>
          <p class="mt-2 text-2xl font-bold text-yellow-500 tabular-nums">{{ fmt(stats?.totalPrizePools ?? 0) }} ETB</p>
        </div>

        <div class="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-5">
          <p class="text-[10px] font-bold text-blue-400/70 uppercase tracking-widest">House Commission Earned</p>
          <p class="mt-2 text-2xl font-bold text-blue-400 tabular-nums">{{ fmt(stats?.houseCommissionEarned ?? 0) }} ETB</p>
        </div>

        <div class="rounded-2xl border border-(--surface-border) p-5" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Active Players</p>
          <p class="mt-2 text-2xl font-bold text-white tabular-nums">{{ stats?.activePlayers ?? 0 }}</p>
        </div>

      </div>
    </div>
  </div>
</template>
