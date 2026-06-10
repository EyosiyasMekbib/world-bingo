<script setup lang="ts">
const { apiFetch } = useAdminAuth()

const clerks = ref<any[]>([])
const loading = ref(true)
const showModal = ref(false)
const submitting = ref(false)
const deleteTarget = ref<any>(null)
const deleting = ref(false)

const form = reactive({ username: '', password: '' })
const formError = ref('')

async function fetchClerks() {
  loading.value = true
  try {
    clerks.value = await apiFetch('/admin/clerks')
  } finally {
    loading.value = false
  }
}

async function createClerk() {
  formError.value = ''
  submitting.value = true
  try {
    await apiFetch('/admin/clerks', { method: 'POST', body: form })
    showModal.value = false
    form.username = ''
    form.password = ''
    await fetchClerks()
  } catch (err: any) {
    formError.value = err?.data?.error ?? 'Failed to create clerk'
  } finally {
    submitting.value = false
  }
}

async function confirmDelete(clerk: any) {
  deleteTarget.value = clerk
}

async function deleteClerk() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await apiFetch(`/admin/clerks/${deleteTarget.value.id}`, { method: 'DELETE' })
    deleteTarget.value = null
    await fetchClerks()
  } finally {
    deleting.value = false
  }
}

function openModal() {
  form.username = ''
  form.password = ''
  formError.value = ''
  showModal.value = true
}

onMounted(fetchClerks)
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h1 class="page-title">Clerks</h1>
        <p class="page-sub">Accounts that can review and approve deposits &amp; withdrawals</p>
      </div>
      <button class="btn-primary" @click="openModal">
        <UIcon name="i-heroicons:plus" class="w-4 h-4" />
        New Clerk
      </button>
    </div>

    <div v-if="loading" class="empty-state">Loading…</div>

    <div v-else-if="clerks.length === 0" class="empty-state">
      No clerk accounts yet. Create one to get started.
    </div>

    <div v-else class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Status</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="clerk in clerks" :key="clerk.id">
            <td class="font-medium">{{ clerk.username }}</td>
            <td>
              <span :class="clerk.isActive ? 'badge-active' : 'badge-inactive'">
                {{ clerk.isActive ? 'Active' : 'Inactive' }}
              </span>
            </td>
            <td class="text-muted">{{ new Date(clerk.createdAt).toLocaleDateString() }}</td>
            <td class="text-right">
              <button class="btn-danger-sm" @click="confirmDelete(clerk)">
                <UIcon name="i-heroicons:trash" class="w-4 h-4" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create modal -->
    <Teleport to="body">
      <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
        <div class="modal">
          <div class="modal-header">
            <h2>New Clerk Account</h2>
            <button class="modal-close" @click="showModal = false">
              <UIcon name="i-heroicons:x-mark" class="w-5 h-5" />
            </button>
          </div>
          <form class="modal-body" @submit.prevent="createClerk">
            <div class="field">
              <label>Username</label>
              <input v-model="form.username" type="text" placeholder="e.g. clerk_tigist" autocomplete="off" required minlength="3" maxlength="32" />
            </div>
            <div class="field">
              <label>Password</label>
              <input v-model="form.password" type="password" placeholder="Min 8 characters" required minlength="8" />
            </div>
            <p v-if="formError" class="form-error">{{ formError }}</p>
            <div class="modal-actions">
              <button type="button" class="btn-ghost" @click="showModal = false">Cancel</button>
              <button type="submit" class="btn-primary" :disabled="submitting">
                {{ submitting ? 'Creating…' : 'Create Clerk' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

    <!-- Delete confirm modal -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="modal-backdrop" @click.self="deleteTarget = null">
        <div class="modal modal--sm">
          <div class="modal-header">
            <h2>Delete Clerk</h2>
            <button class="modal-close" @click="deleteTarget = null">
              <UIcon name="i-heroicons:x-mark" class="w-5 h-5" />
            </button>
          </div>
          <div class="modal-body">
            <p class="confirm-text">Delete clerk <strong>{{ deleteTarget.username }}</strong>? This cannot be undone.</p>
            <div class="modal-actions">
              <button class="btn-ghost" @click="deleteTarget = null">Cancel</button>
              <button class="btn-danger" :disabled="deleting" @click="deleteClerk">
                {{ deleting ? 'Deleting…' : 'Delete' }}
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
.text-right { text-align: right; }
.badge-active, .badge-inactive {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}
.badge-active { background: rgba(52,211,153,0.12); color: #34d399; }
.badge-inactive { background: rgba(248,113,113,0.12); color: #f87171; }

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
.btn-danger {
  height: 36px;
  padding: 0 16px;
  border-radius: 7px;
  background: rgba(248,113,113,0.15);
  border: 1px solid rgba(248,113,113,0.3);
  color: #f87171;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.12s;
}
.btn-danger:hover { background: rgba(248,113,113,0.25); }
.btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-danger-sm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.btn-danger-sm:hover { background: rgba(248,113,113,0.1); color: #f87171; }

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
.field input {
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
.field input:focus {
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
</style>
