<script setup lang="ts">
type Broadcast = {
  id: string
  title: string
  body: string
  recipientCount: number
  sentByName: string | null
  createdAt: string
}

const { apiFetch } = useAdminAuth()

const TITLE_MAX = 120
const BODY_MAX = 1000

const broadcasts = ref<Broadcast[]>([])
const loading = ref(true)
const form = reactive({ title: '', body: '' })
const formError = ref('')
const successMsg = ref('')
const confirming = ref(false)
const sending = ref(false)

const canSend = computed(() => form.title.trim().length > 0 && form.body.trim().length > 0)

async function fetchBroadcasts() {
  loading.value = true
  try {
    broadcasts.value = (await apiFetch<{ items: Broadcast[] }>('/admin/notifications/broadcasts')).items
  } finally {
    loading.value = false
  }
}

function review() {
  formError.value = ''
  successMsg.value = ''
  if (!canSend.value) {
    formError.value = 'Title and message are both required'
    return
  }
  confirming.value = true
}

async function send() {
  sending.value = true
  try {
    const { item } = await apiFetch<{ item: Broadcast }>('/admin/notifications/broadcast', {
      method: 'POST',
      body: { title: form.title.trim(), body: form.body.trim() },
    })
    successMsg.value = `Sent to ${item.recipientCount.toLocaleString()} players`
    form.title = ''
    form.body = ''
    await fetchBroadcasts()
  } catch (err: any) {
    formError.value = err?.data?.error ?? err?.data?.message ?? 'Failed to send broadcast'
  } finally {
    sending.value = false
    confirming.value = false
  }
}

onMounted(fetchBroadcasts)
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h1 class="page-title">Broadcast</h1>
        <p class="page-sub">Send a notification to every player. It appears live in their bell and stays there until read.</p>
      </div>
    </div>

    <form class="card" @submit.prevent="review">
      <div class="field">
        <label for="bc-title">Title</label>
        <input id="bc-title" v-model="form.title" type="text" placeholder="e.g. Weekend jackpot is live" :maxlength="TITLE_MAX" required />
        <span class="field-hint">{{ form.title.length }}/{{ TITLE_MAX }}</span>
      </div>
      <div class="field">
        <label for="bc-body">Message</label>
        <textarea id="bc-body" v-model="form.body" placeholder="What players should know" :maxlength="BODY_MAX" required />
        <span class="field-hint">{{ form.body.length }}/{{ BODY_MAX }}</span>
      </div>
      <p v-if="formError" class="form-error">{{ formError }}</p>
      <p v-if="successMsg" class="form-success">{{ successMsg }}</p>
      <div class="modal-actions">
        <button type="submit" class="btn-primary" :disabled="!canSend || sending">
          <UIcon name="i-heroicons:paper-airplane" class="w-4 h-4" />
          Send to all players
        </button>
      </div>
    </form>

    <h2 class="section-title">History</h2>
    <div v-if="loading" class="empty-state">Loading…</div>
    <div v-else-if="broadcasts.length === 0" class="empty-state">No broadcasts sent yet.</div>
    <div v-else class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Message</th>
            <th>Recipients</th>
            <th>Sent by</th>
            <th>Sent</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in broadcasts" :key="b.id">
            <td class="font-medium">{{ b.title }}</td>
            <td class="cell-body">{{ b.body }}</td>
            <td>{{ b.recipientCount.toLocaleString() }}</td>
            <td class="text-muted">{{ b.sentByName ?? '—' }}</td>
            <td class="text-muted">{{ new Date(b.createdAt).toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Confirm modal: a broadcast cannot be recalled -->
    <Teleport to="body">
      <div v-if="confirming" class="modal-backdrop" @click.self="!sending && (confirming = false)">
        <div class="modal modal--sm">
          <div class="modal-header">
            <h2>Send to all players?</h2>
            <button class="modal-close" :disabled="sending" @click="confirming = false">
              <UIcon name="i-heroicons:x-mark" class="w-5 h-5" />
            </button>
          </div>
          <div class="modal-body">
            <p class="confirm-text">
              <strong>{{ form.title }}</strong> will be delivered to every player's notifications. This cannot be undone.
            </p>
            <div class="modal-actions">
              <button class="btn-ghost" :disabled="sending" @click="confirming = false">Cancel</button>
              <button class="btn-primary" :disabled="sending" @click="send">
                {{ sending ? 'Sending…' : 'Send' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 28px;
}
.page-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 4px;
}
.page-sub {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
}
.empty-state {
  padding: 48px;
  text-align: center;
  color: var(--text-muted);
  font-size: 14px;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: 10px;
}
.table-wrap {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: 10px;
  overflow: hidden;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.data-table th {
  padding: 10px 16px;
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  border-bottom: 1px solid var(--surface-border);
}
.data-table td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--surface-border);
  color: var(--text-primary);
}
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:hover td { background: rgba(255,255,255,0.02); }
.font-medium { font-weight: 500; }
.text-muted { color: var(--text-muted); }

/* Buttons */
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 16px;
  border-radius: 7px;
  background: var(--brand-primary);
  color: #000;
  font-size: 13px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: opacity 0.12s;
}
.btn-primary:hover { opacity: 0.88; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost {
  height: 36px;
  padding: 0 16px;
  border-radius: 7px;
  background: none;
  border: 1px solid var(--surface-border);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.12s;
}
.btn-ghost:hover { background: rgba(255,255,255,0.05); }

/* Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0,0,0,0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.modal {
  width: 100%;
  max-width: 440px;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-border);
  border-radius: 12px;
  overflow: hidden;
}
.modal--sm { max-width: 380px; }
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--surface-border);
}
.modal-header h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
}
.modal-close:hover { background: rgba(255,255,255,0.06); color: var(--text-primary); }
.modal-body { padding: 20px; }
.field { margin-bottom: 16px; }
.field label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.field input,
.field textarea {
  width: 100%;
  height: 38px;
  padding: 0 12px;
  border-radius: 7px;
  background: var(--surface-base);
  border: 1px solid var(--surface-border);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  box-sizing: border-box;
  transition: border-color 0.12s;
}
.field input:focus,
.field textarea:focus {
  outline: none;
  border-color: var(--brand-primary);
}
.form-error {
  font-size: 12px;
  color: #f87171;
  margin: 0 0 12px;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}
.confirm-text {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 20px;
}
.field textarea {
  height: auto;
  min-height: 110px;
  padding: 10px 12px;
  resize: vertical;
  line-height: 1.5;
}
.field-hint {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
  text-align: right;
}
.card {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: 10px;
  padding: 20px;
  margin-bottom: 28px;
  max-width: 640px;
}
.form-success {
  font-size: 12px;
  color: #34d399;
  margin: 0 0 12px;
}
.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px;
}
.cell-body {
  max-width: 420px;
  color: var(--text-secondary);
  white-space: pre-line;
}
</style>
