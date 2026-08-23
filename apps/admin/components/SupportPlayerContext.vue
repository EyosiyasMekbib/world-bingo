<script setup lang="ts">
const props = defineProps<{ userId: string | null }>()
const api = useAdminApi()

type SupportContext = Awaited<ReturnType<typeof api.getSupportContext>>

const player = ref<SupportContext | null>(null)
const loading = ref(false)

const load = async () => {
  const userId = props.userId
  if (!userId) {
    player.value = null
    return
  }
  loading.value = true
  try {
    // Clerk-accessible endpoint. getPlayer() would 403 for a CLERK, and
    // clerks are exactly who staffs this inbox.
    player.value = await api.getSupportContext(userId)
  } catch {
    player.value = null
  } finally {
    loading.value = false
  }
}

watch(() => props.userId, load, { immediate: true })

// Deposits and withdrawals are the two questions a support thread is almost
// always actually about, so the endpoint returns them as separate lists,
// already filtered and capped at 5 each server-side — nothing to re-slice here.
const deposits = computed(() => player.value?.deposits ?? [])
const withdrawals = computed(() => player.value?.withdrawals ?? [])

const statusVariant = (status: string) => {
  switch (status) {
    case 'APPROVED':
      return 'positive'
    case 'REJECTED':
      return 'negative'
    case 'PENDING_REVIEW':
      return 'warning'
    default:
      return 'neutral'
  }
}
</script>

<template>
  <aside class="ctx">
    <p v-if="!userId" class="ctx-empty">Select a conversation.</p>
    <p v-else-if="loading" class="ctx-empty">Loading player…</p>

    <template v-else-if="player">
      <header class="ctx-head">
        <strong>{{ player.username }}</strong>
        <small>#{{ player.serial }} · {{ player.phone }}</small>
      </header>

      <section>
        <h4>Balance</h4>
        <p>Real: {{ Number(player.wallet?.realBalance ?? 0).toFixed(2) }} ETB</p>
        <p>Bonus: {{ Number(player.wallet?.bonusBalance ?? 0).toFixed(2) }} ETB</p>
      </section>

      <section>
        <h4>Recent deposits</h4>
        <p v-if="!deposits.length" class="ctx-muted">None</p>
        <p v-for="t in deposits" :key="t.id" class="ctx-tx">
          <span class="ctx-amount">{{ Number(t.amount).toFixed(2) }} ETB</span>
          <span class="status-tag" :class="`status-tag--${statusVariant(t.status)}`">{{
            t.status
          }}</span>
          <small>{{ new Date(t.createdAt).toLocaleString() }}</small>
        </p>
      </section>

      <section>
        <h4>Recent withdrawals</h4>
        <p v-if="!withdrawals.length" class="ctx-muted">None</p>
        <p v-for="t in withdrawals" :key="t.id" class="ctx-tx">
          <span class="ctx-amount">{{ Number(t.amount).toFixed(2) }} ETB</span>
          <span class="status-tag" :class="`status-tag--${statusVariant(t.status)}`">{{
            t.status
          }}</span>
          <small>{{ new Date(t.createdAt).toLocaleString() }}</small>
        </p>
      </section>

      <section>
        <h4>Account</h4>
        <p>Joined {{ new Date(player.createdAt).toLocaleDateString() }}</p>
        <p>{{ player.isActive ? 'Active' : 'Disabled' }}</p>
      </section>
    </template>
  </aside>
</template>

<style scoped>
.ctx {
  padding: 0.9rem;
  border-left: 1px solid var(--surface-border);
  background: var(--surface-raised);
  overflow-y: auto;
  font-size: 0.85rem;
}
.ctx-head {
  margin-bottom: 0.75rem;
}
.ctx-head small {
  display: block;
  color: var(--text-muted);
}
.ctx section {
  margin-bottom: 0.9rem;
}
.ctx h4 {
  margin: 0 0 0.3rem;
  font-family: var(--font-ui);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}
.ctx p {
  margin: 0 0 0.2rem;
  color: var(--text-primary);
}
.ctx-tx {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.ctx-amount {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.ctx-tx small {
  width: 100%;
  color: var(--text-muted);
  font-size: 0.72rem;
}
.ctx-empty,
.ctx-muted {
  color: var(--text-muted);
}
</style>
