<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { apiFetch } = useAdminAuth()

interface AgentRow {
  id: string
  userId: string
  username: string
  shopName: string
  float: string
  accountStatus: string
  fulfilled7d: string
  lastTopUpAt: string | null
  createdAt: string
}

interface AgentSummary {
  floatOutstanding: string
  activeCount: number
  totalCount: number
  fulfilledTodayVolume: string
  fulfilledTodayCount: number
  commission30d: string
}

/**
 * Money arrives from the API as decimal strings. Grouping them with string
 * surgery keeps every digit the server sent — no Number() round trip, so a
 * float balance can never drift by a cent on the way to the screen.
 */
function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0.00'
  const raw = String(value).trim()
  const sign = raw.startsWith('-') ? '-' : ''
  const [whole = '0', fraction = ''] = raw.replace(/^[+-]/, '').split('.')
  const grouped = (whole || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}.${(fraction + '00').slice(0, 2)}`
}

/** Decimal string to integer minor units, so comparisons stay exact. */
function toMinor(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(String(value).trim())
  if (!match) return null
  const [, sign, whole = '', fraction = ''] = match
  if (!whole && !fraction) return null
  const cents = BigInt(whole || '0') * 100n + BigInt((fraction + '00').slice(0, 2))
  return sign === '-' ? -cents : cents
}

/** An active shop below this has nearly run out of credit to sell. */
const LOW_FLOAT_MINOR = 1000000n // 10,000.00 ETB

function isLowFloat(agent: AgentRow): boolean {
  if (agent.accountStatus !== 'ACTIVE') return false
  const minor = toMinor(agent.float)
  return minor !== null && minor < LOW_FLOAT_MINOR
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Never'
  return date.toLocaleDateString()
}

// ── Listing ──────────────────────────────────────────────────────────────
const agents = ref<AgentRow[]>([])
const summary = ref<AgentSummary | null>(null)
const loading = ref(true)
const loadError = ref('')

const suspendedCount = computed(() => {
  if (!summary.value) return 0
  return Math.max(0, summary.value.totalCount - summary.value.activeCount)
})

async function fetchAgents() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await apiFetch<{ agents: AgentRow[]; summary: AgentSummary }>('/admin/agents')
    agents.value = data.agents ?? []
    summary.value = data.summary ?? null
  } catch (err: any) {
    loadError.value = err?.data?.error ?? 'Could not load agents'
    agents.value = []
    summary.value = null
  } finally {
    loading.value = false
  }
}

// ── Create ───────────────────────────────────────────────────────────────
const showModal = ref(false)
const submitting = ref(false)
const formError = ref('')
const form = reactive({ username: '', password: '', shopName: '' })

function openModal() {
  form.username = ''
  form.password = ''
  form.shopName = ''
  formError.value = ''
  showModal.value = true
}

async function createAgent() {
  formError.value = ''
  submitting.value = true
  try {
    await apiFetch('/admin/agents', { method: 'POST', body: { ...form } })
    showModal.value = false
    await fetchAgents()
  } catch (err: any) {
    // A 409 means the username is taken; the server phrases it best.
    formError.value = err?.data?.error ?? 'Could not create the agent'
  } finally {
    submitting.value = false
  }
}

// ── Network settings ──────────────────────────────────────────────────
// These four are SiteSetting rows. Only the first three are accepted by the
// PUT endpoint; agent_code_ttl_seconds is table-only for now, so it is shown
// read-only rather than offered as a field that would silently not save.
const showSettings = ref(false)
const savingSettings = ref(false)
const settingsError = ref('')
const settingsSaved = ref(false)
const settings = reactive({ commissionRate: '', depositMin: '', depositMax: '' })
const codeTtlSeconds = ref('')

async function openSettings() {
  settingsError.value = ''
  settingsSaved.value = false
  showSettings.value = true
  try {
    // commissionRate comes back as a number while the limits come back as
    // decimal strings, so everything is coerced before it reaches an input.
    const data = await apiFetch<{
      commissionRate: string | number
      depositMin: string | number
      depositMax: string | number
      codeTtlSeconds?: string | number
    }>('/admin/agents/settings')
    settings.commissionRate = String(data.commissionRate ?? '')
    settings.depositMin = String(data.depositMin ?? '')
    settings.depositMax = String(data.depositMax ?? '')
    codeTtlSeconds.value = data.codeTtlSeconds == null ? '' : String(data.codeTtlSeconds)
  } catch (err: any) {
    settingsError.value = err?.data?.error ?? 'Could not load the settings'
  }
}

async function saveSettings() {
  settingsError.value = ''
  settingsSaved.value = false
  savingSettings.value = true
  try {
    await apiFetch('/admin/agents/settings', { method: 'PUT', body: { ...settings } })
    settingsSaved.value = true
  } catch (err: any) {
    settingsError.value = err?.data?.error ?? 'Could not save the settings'
  } finally {
    savingSettings.value = false
  }
}

onMounted(fetchAgents)
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h1 class="page-title">Agents</h1>
        <p class="page-sub">
          Shops holding prepaid float, which they sell on to players paying cash at the counter
        </p>
      </div>
      <div class="header-actions">
        <button class="btn-ghost" @click="openSettings">
          <UIcon name="i-heroicons:adjustments-horizontal" class="w-4 h-4" />
          Settings
        </button>
        <button class="btn-primary" @click="openModal">
          <UIcon name="i-heroicons:plus" class="w-4 h-4" />
          New agent
        </button>
      </div>
    </div>

    <!-- ── Summary ─────────────────────────────────────────────────────── -->
    <div class="tile-grid" :aria-busy="loading">
      <div class="admin-card tile">
        <p class="tile-label">Float outstanding</p>
        <p v-if="loading" class="tile-skeleton" aria-hidden="true" />
        <p v-else class="tile-value tile-value--amber">
          {{ formatMoney(summary?.floatOutstanding) }}<span class="tile-unit">ETB</span>
        </p>
        <p class="tile-sub">credit issued, not yet sold</p>
      </div>

      <div class="admin-card tile">
        <p class="tile-label">Active agents</p>
        <p v-if="loading" class="tile-skeleton" aria-hidden="true" />
        <p v-else class="tile-value">
          {{ summary?.activeCount ?? 0
          }}<span class="tile-unit">of {{ summary?.totalCount ?? 0 }}</span>
        </p>
        <p class="tile-sub">{{ suspendedCount }} suspended</p>
      </div>

      <div class="admin-card tile">
        <p class="tile-label">Fulfilled today</p>
        <p v-if="loading" class="tile-skeleton" aria-hidden="true" />
        <p v-else class="tile-value">
          {{ formatMoney(summary?.fulfilledTodayVolume) }}<span class="tile-unit">ETB</span>
        </p>
        <p class="tile-sub">{{ summary?.fulfilledTodayCount ?? 0 }} deposits</p>
      </div>

      <div class="admin-card tile">
        <p class="tile-label">Commission 30 days</p>
        <p v-if="loading" class="tile-skeleton" aria-hidden="true" />
        <p v-else class="tile-value tile-value--positive">
          {{ formatMoney(summary?.commission30d) }}<span class="tile-unit">ETB</span>
        </p>
        <p class="tile-sub">free float given away</p>
      </div>
    </div>

    <!-- ── Listing ─────────────────────────────────────────────────────── -->
    <div v-if="loadError" class="admin-card state-panel">
      <UIcon name="i-heroicons:exclamation-triangle" class="w-5 h-5 state-icon" />
      <p class="state-text">{{ loadError }}</p>
      <button class="btn-ghost" @click="fetchAgents">Try again</button>
    </div>

    <div v-else-if="loading" class="admin-card state-panel">
      <p class="state-text">Loading agents</p>
    </div>

    <div v-else-if="agents.length === 0" class="admin-card state-panel">
      <p class="state-text">No agents yet. Create one to start issuing float.</p>
    </div>

    <div v-else class="admin-card table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Shop</th>
            <th class="num">Float</th>
            <th class="num">Fulfilled 7d</th>
            <th>Last top-up</th>
            <th>Status</th>
            <th><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="agent in agents" :key="agent.id">
            <td class="cell-strong">{{ agent.username }}</td>
            <td class="muted">{{ agent.shopName }}</td>
            <td class="num money">{{ formatMoney(agent.float) }}</td>
            <td class="num money">{{ formatMoney(agent.fulfilled7d) }}</td>
            <td class="muted">{{ formatDate(agent.lastTopUpAt) }}</td>
            <td>
              <div class="tag-row">
                <span
                  class="status-tag"
                  :class="
                    agent.accountStatus === 'ACTIVE'
                      ? 'status-tag--positive'
                      : 'status-tag--negative'
                  "
                >
                  {{ agent.accountStatus === 'ACTIVE' ? 'Active' : 'Suspended' }}
                </span>
                <span v-if="isLowFloat(agent)" class="status-tag status-tag--warning"
                  >Low float</span
                >
              </div>
            </td>
            <td class="cell-end">
              <NuxtLink class="manage-link" :to="`/agents/${agent.id}`">
                Manage
                <UIcon name="i-heroicons:chevron-right" class="w-3.5 h-3.5" />
              </NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ── Create modal ────────────────────────────────────────────────── -->
    <Teleport to="body">
      <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="new-agent-title">
          <div class="modal-header">
            <h2 id="new-agent-title">New agent</h2>
            <button class="modal-close" aria-label="Close" @click="showModal = false">
              <UIcon name="i-heroicons:x-mark" class="w-5 h-5" />
            </button>
          </div>
          <form class="modal-body" @submit.prevent="createAgent">
            <div class="field">
              <label for="agent-username">Username</label>
              <input
                id="agent-username"
                v-model="form.username"
                type="text"
                placeholder="e.g. agent_bole"
                autocomplete="off"
                required
                minlength="3"
                maxlength="32"
              />
            </div>
            <div class="field">
              <label for="agent-password">Password</label>
              <input
                id="agent-password"
                v-model="form.password"
                type="password"
                placeholder="Min 8 characters"
                autocomplete="new-password"
                required
                minlength="8"
              />
            </div>
            <div class="field">
              <label for="agent-shop">Shop name</label>
              <input
                id="agent-shop"
                v-model="form.shopName"
                type="text"
                placeholder="e.g. Bole Bingo House"
                autocomplete="off"
                required
                maxlength="64"
              />
            </div>
            <p v-if="formError" class="form-error">{{ formError }}</p>
            <div class="modal-actions">
              <button type="button" class="btn-ghost" @click="showModal = false">Cancel</button>
              <button type="submit" class="btn-primary" :disabled="submitting">
                {{ submitting ? 'Creating' : 'Create agent' }}
              </button>
            </div>
          </form>
        </div>
      </div>

      <div v-if="showSettings" class="modal-backdrop" @click.self="showSettings = false">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="agent-settings-title">
          <div class="modal-header">
            <h2 id="agent-settings-title">Network settings</h2>
            <button class="modal-close" aria-label="Close" @click="showSettings = false">
              <UIcon name="i-heroicons:x-mark" class="w-5 h-5" />
            </button>
          </div>
          <form class="modal-body" @submit.prevent="saveSettings">
            <div class="field">
              <label for="set-rate">Commission rate (percent)</label>
              <input
                id="set-rate"
                v-model="settings.commissionRate"
                type="text"
                inputmode="decimal"
                placeholder="e.g. 5"
                required
              />
              <p class="field-hint">
                Percent, not a fraction. 5 means an agent paying 10,000 receives 10,500 of float.
              </p>
            </div>
            <div class="field">
              <label for="set-min">Minimum deposit (ETB)</label>
              <input
                id="set-min"
                v-model="settings.depositMin"
                type="text"
                inputmode="decimal"
                required
              />
            </div>
            <div class="field">
              <label for="set-max">Maximum deposit (ETB)</label>
              <input
                id="set-max"
                v-model="settings.depositMax"
                type="text"
                inputmode="decimal"
                required
              />
            </div>
            <p v-if="codeTtlSeconds" class="field-hint">
              Deposit codes expire after {{ codeTtlSeconds }} seconds. That one is not editable here
              yet; change it in the site_settings table.
            </p>
            <p v-if="settingsError" class="form-error">{{ settingsError }}</p>
            <p v-else-if="settingsSaved" class="form-ok">Saved. New top-ups use the new rate.</p>
            <div class="modal-actions">
              <button type="button" class="btn-ghost" @click="showSettings = false">Close</button>
              <button type="submit" class="btn-primary" :disabled="savingSettings">
                {{ savingSettings ? 'Saving' : 'Save settings' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.55);
}

.form-ok {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--positive);
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
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
  max-width: 62ch;
}

/* ── Summary tiles ─────────────────────────────────────────────────────── */
.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.tile {
  padding: 16px 18px;
}
.tile-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin: 0 0 8px;
}
.tile-value {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.tile-value--amber {
  color: var(--brand-primary);
}
.tile-value--positive {
  color: var(--positive);
}
.tile-unit {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}
.tile-sub {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
.tile-skeleton {
  height: 28px;
  width: 60%;
  margin: 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
}

/* ── States ────────────────────────────────────────────────────────────── */
.state-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 44px 24px;
  text-align: center;
}
.state-icon {
  color: var(--negative);
}
.state-text {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

/* ── Table ─────────────────────────────────────────────────────────────── */
.table-wrap {
  overflow-x: auto;
}
.cell-strong {
  font-weight: 600;
}
.money {
  font-variant-numeric: tabular-nums;
}
.cell-end {
  text-align: right;
}
.tag-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.manage-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-primary);
  text-decoration: none;
  white-space: nowrap;
}
.manage-link:hover {
  text-decoration: underline;
}
.manage-link:focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: 2px;
  border-radius: 4px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* ── Buttons ───────────────────────────────────────────────────────────── */
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
  white-space: nowrap;
  transition: opacity 0.12s;
}
.btn-primary:hover {
  opacity: 0.88;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
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
.btn-ghost:hover {
  background: rgba(255, 255, 255, 0.05);
}

/* ── Modal ─────────────────────────────────────────────────────────────── */
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.65);
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
.modal-close:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
}
.modal-body {
  padding: 20px;
}
.field {
  margin-bottom: 16px;
}
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
  color: var(--negative);
  margin: 0 0 12px;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}

@media (max-width: 640px) {
  .page-header {
    flex-direction: column;
  }
}
</style>
