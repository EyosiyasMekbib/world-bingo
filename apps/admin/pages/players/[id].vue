<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const { getPlayer, adjustPlayerBalance } = useAdminApi()
const toast = useToast()

const player = ref<any>(null)
const loading = ref(true)
const showAdjust = ref(false)
const adjusting = ref(false)

const adjustForm = reactive({
  type: 'real' as 'real' | 'bonus',
  amount: 0,
  note: '',
})

async function fetchPlayer() {
  loading.value = true
  try {
    player.value = await getPlayer(route.params.id as string)
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load player', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function submitAdjustment() {
  adjusting.value = true
  try {
    await adjustPlayerBalance(route.params.id as string, {
      type: adjustForm.type,
      amount: adjustForm.amount,
      note: adjustForm.note,
    })
    toast.add({ title: 'Balance adjusted', color: 'success' })
    showAdjust.value = false
    adjustForm.amount = 0
    adjustForm.note = ''
    await fetchPlayer()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to adjust', color: 'error' })
  } finally {
    adjusting.value = false
  }
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-ET', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function txColor(type: string) {
  if (type.includes('WIN') || type.includes('BONUS') || type === 'REFUND' || type === 'DEPOSIT') return 'success'
  if (type.includes('ENTRY') || type === 'WITHDRAWAL') return 'error'
  return 'neutral'
}

onMounted(fetchPlayer)
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex items-center gap-3">
      <NuxtLink to="/players">
        <UButton icon="i-heroicons:arrow-left" color="neutral" variant="ghost" size="sm" />
      </NuxtLink>
      <h1 class="text-2xl font-bold text-white tracking-tight">Player Detail</h1>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" /> Loading...
    </div>

    <template v-else-if="player">
      <!-- Info Cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="p-4 rounded-2xl border border-(--surface-border) shadow-lg" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Username</p>
          <p class="font-bold text-white text-lg">{{ player.username }}</p>
        </div>
        <div class="p-4 rounded-2xl border border-(--surface-border) shadow-lg" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Phone</p>
          <p class="font-bold text-white/60 font-mono">{{ player.phone ?? '—' }}</p>
        </div>
        <div class="p-4 rounded-2xl border border-(--surface-border) shadow-lg" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Real Balance</p>
          <p class="font-bold text-yellow-500 text-lg">{{ Number(player.wallet?.realBalance ?? 0).toFixed(2) }} <span class="text-xs text-white/30">ETB</span></p>
        </div>
        <div class="p-4 rounded-2xl border border-(--surface-border) shadow-lg" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Bonus Balance</p>
          <p class="font-bold text-cyan-400 text-lg">{{ Number(player.wallet?.bonusBalance ?? 0).toFixed(2) }} <span class="text-xs text-white/30">ETB</span></p>
        </div>
      </div>

      <!-- Stats -->
      <div v-if="player.stats" class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="p-4 rounded-2xl border border-(--surface-border)" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Games Played</p>
          <p class="font-bold text-white text-lg">{{ player.stats.gamesPlayed }}</p>
        </div>
        <div class="p-4 rounded-2xl border border-(--surface-border)" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Games Won</p>
          <p class="font-bold text-white text-lg">{{ player.stats.gamesWon }}</p>
        </div>
        <div class="p-4 rounded-2xl border border-(--surface-border)" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Total Wagered</p>
          <p class="font-bold text-white text-lg">{{ player.stats.totalWagered.toFixed(2) }}</p>
        </div>
        <div class="p-4 rounded-2xl border border-(--surface-border)" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Total Won</p>
          <p class="font-bold text-white text-lg">{{ player.stats.totalWon.toFixed(2) }}</p>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex gap-2">
        <UButton icon="i-heroicons:adjustments-horizontal" label="Adjust Balance" color="primary" variant="soft" @click="showAdjust = true" />
      </div>

      <!-- Transaction History -->
      <div>
        <h2 class="text-base font-bold text-white mb-3">Recent Transactions</h2>
        <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl bg-(--surface-raised)">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="border-b border-(--surface-border) bg-(--surface-overlay)">
                <tr>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase">Type</th>
                  <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase">Amount</th>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase">Status</th>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase">Note</th>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase">Date</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5">
                <tr v-if="!player.transactions?.length">
                  <td colspan="5" class="px-4 py-8 text-center text-white/30">No transactions</td>
                </tr>
                <tr v-for="tx in player.transactions" :key="tx.id" class="hover:bg-white/3">
                  <td class="px-4 py-3">
                    <UBadge :color="txColor(tx.type)" variant="soft" :label="tx.type" size="xs" />
                  </td>
                  <td class="px-4 py-3 text-right font-mono font-bold" :class="txColor(tx.type) === 'success' ? 'text-emerald-400' : 'text-red-400'">
                    {{ Number(tx.amount).toFixed(2) }}
                  </td>
                  <td class="px-4 py-3">
                    <UBadge :color="tx.status === 'APPROVED' ? 'success' : tx.status === 'REJECTED' ? 'error' : 'warning'" variant="soft" :label="tx.status" size="xs" />
                  </td>
                  <td class="px-4 py-3 text-white/40 text-xs max-w-48 truncate">{{ tx.note ?? '—' }}</td>
                  <td class="px-4 py-3 text-white/40 text-xs">{{ formatDate(tx.createdAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>

    <!-- Adjust Balance Modal -->
    <UModal v-model:open="showAdjust" title="Adjust Player Balance" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Balance Type">
            <USelect
              v-model="adjustForm.type"
              :items="[{ label: 'Real Balance', value: 'real' }, { label: 'Bonus Balance', value: 'bonus' }]"
              class="w-full"
              value-key="value"
            />
          </UFormField>
          <UFormField label="Amount (use negative to deduct)">
            <UInput v-model.number="adjustForm.amount" type="number" class="w-full" />
          </UFormField>
          <UFormField label="Note (required for audit trail)">
            <UInput v-model="adjustForm.note" placeholder="Reason for adjustment..." class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="showAdjust = false" />
          <UButton color="primary" :loading="adjusting" :disabled="!adjustForm.note || adjustForm.amount === 0" label="Apply" @click="submitAdjustment" />
        </div>
      </template>
    </UModal>
  </div>
</template>
