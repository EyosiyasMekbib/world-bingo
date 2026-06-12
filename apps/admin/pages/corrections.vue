<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { getTransactionsHistory, adjustPlayerBalance, getUsers } = useAdminApi()
const toast = useToast()

// ── Form state ────────────────────────────────────────────────────────────────
const playerIdInput = ref('')
const correctionAmount = ref<number | ''>('')
const description = ref('')
const comment = ref('')
const direction = ref<'up' | 'down'>('up')
const balanceType = ref<'real' | 'bonus'>('real')

const playerSearchResults = ref<any[]>([])
const selectedPlayer = ref<any>(null)
const playerSearchLoading = ref(false)
let playerSearchTimer: ReturnType<typeof setTimeout> | null = null

const submitting = ref(false)

// Search player by serial or username
async function searchPlayer() {
  const q = playerIdInput.value.trim()
  if (!q) { playerSearchResults.value = []; selectedPlayer.value = null; return }
  playerSearchLoading.value = true
  try {
    const result = await getUsers({ search: q, limit: 5, role: 'PLAYER' }) as any
    playerSearchResults.value = result?.data ?? []
    if (playerSearchResults.value.length === 1) selectPlayer(playerSearchResults.value[0])
    else selectedPlayer.value = null
  } catch {
    playerSearchResults.value = []
  } finally {
    playerSearchLoading.value = false
  }
}

function onPlayerInput() {
  if (playerSearchTimer) clearTimeout(playerSearchTimer)
  playerSearchTimer = setTimeout(searchPlayer, 350)
}

function selectPlayer(p: any) {
  selectedPlayer.value = p
  playerIdInput.value = String(p.serial).padStart(5, '0')
  playerSearchResults.value = []
}

function clearPlayer() {
  selectedPlayer.value = null
  playerIdInput.value = ''
  playerSearchResults.value = []
}

const currentBalance = computed(() => {
  if (!selectedPlayer.value) return null
  return balanceType.value === 'real'
    ? Number(selectedPlayer.value.wallet?.realBalance ?? 0)
    : Number(selectedPlayer.value.wallet?.bonusBalance ?? 0)
})

async function submitCorrection() {
  if (!selectedPlayer.value) return toast.add({ title: 'Select a player first', color: 'warning' })
  if (!correctionAmount.value || Number(correctionAmount.value) <= 0) return toast.add({ title: 'Enter a valid amount', color: 'warning' })
  if (!description.value.trim()) return toast.add({ title: 'Description is required', color: 'warning' })

  const signedAmount = direction.value === 'up'
    ? Number(correctionAmount.value)
    : -Number(correctionAmount.value)

  submitting.value = true
  try {
    await adjustPlayerBalance(selectedPlayer.value.id, {
      type: balanceType.value,
      amount: signedAmount,
      note: `${description.value.trim()}${comment.value.trim() ? ` — ${comment.value.trim()}` : ''}`,
    })
    toast.add({ title: `Correction applied (${direction.value === 'up' ? '+' : '-'}${correctionAmount.value} ETB)`, color: 'success' })
    correctionAmount.value = ''
    description.value = ''
    comment.value = ''
    fetchHistory()
    // refresh player balance
    const refreshed = await getUsers({ search: playerIdInput.value, limit: 1, role: 'PLAYER' }) as any
    if (refreshed?.data?.[0]) selectedPlayer.value = refreshed.data[0]
  } catch (err: any) {
    toast.add({ title: 'Failed', description: err?.data?.error ?? err?.message ?? 'Could not apply correction', color: 'error' })
  } finally {
    submitting.value = false
  }
}

// ── History ───────────────────────────────────────────────────────────────────
const history = ref<any[]>([])
const historyLoading = ref(false)
const historyPage = ref(1)
const historyTotal = ref(0)
const LIMIT = 20
const filterFrom = ref('')
const filterTo = ref('')
const filterSerial = ref('')

const totalPages = computed(() => Math.max(1, Math.ceil(historyTotal.value / LIMIT)))

async function fetchHistory() {
  historyLoading.value = true
  try {
    const result = await getTransactionsHistory({
      type: 'ADMIN_REAL_ADJUSTMENT,ADMIN_BONUS_ADJUSTMENT',
      from: filterFrom.value || undefined,
      to: filterTo.value ? `${filterTo.value}T23:59:59.999Z` : undefined,
      userSerial: filterSerial.value ? Number(filterSerial.value) : undefined,
      page: historyPage.value,
      limit: LIMIT,
    }) as any
    history.value = result?.data ?? result ?? []
    historyTotal.value = result?.pagination?.total ?? 0
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load corrections history', color: 'error' })
  } finally {
    historyLoading.value = false
  }
}

watch([historyPage, filterFrom, filterTo, filterSerial], fetchHistory)
onMounted(fetchHistory)

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}

const formatDate = (d: string) =>
  new Date(d).toLocaleString('en-ET', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })

const formatSerial = (s?: number) => s ? String(s).padStart(5, '0') : '—'
</script>

<template>
  <div class="corr-page">

    <!-- Header -->
    <div class="corr-header">
      <div>
        <h1 class="corr-title">Corrections</h1>
        <p class="corr-sub">Manual balance adjustments with full audit trail</p>
      </div>
    </div>

    <!-- ── Create correction form ─────────────────────────────────────────── -->
    <div class="corr-form-card">

      <!-- Player ID row -->
      <div class="corr-field">
        <label class="corr-label">Player ID <span class="corr-req">*</span></label>
        <div class="corr-player-wrap">
          <div class="corr-player-input-row">
            <input
              v-model="playerIdInput"
              class="corr-input"
              placeholder="Search serial, username or phone…"
              @input="onPlayerInput"
            />
            <button v-if="selectedPlayer" class="corr-clear-btn" @click="clearPlayer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <!-- Dropdown results -->
          <div v-if="playerSearchResults.length > 1" class="corr-dropdown">
            <button
              v-for="p in playerSearchResults"
              :key="p.id"
              class="corr-dropdown-item"
              @click="selectPlayer(p)"
            >
              <span class="corr-drop-serial">#{{ formatSerial(p.serial) }}</span>
              <span class="corr-drop-name">{{ p.username }}</span>
              <span class="corr-drop-phone">{{ p.phone ?? '—' }}</span>
            </button>
          </div>
          <!-- Selected player chip -->
          <div v-if="selectedPlayer" class="corr-player-chip">
            <span class="corr-chip-serial">#{{ formatSerial(selectedPlayer.serial) }}</span>
            <span class="corr-chip-name">{{ selectedPlayer.username }}</span>
            <span class="corr-chip-phone">{{ selectedPlayer.phone ?? '—' }}</span>
          </div>
        </div>
      </div>

      <!-- Description -->
      <div class="corr-field">
        <label class="corr-label">Description <span class="corr-req">*</span></label>
        <input v-model="description" class="corr-input" placeholder="Reason for correction…" />
      </div>

      <!-- Comment -->
      <div class="corr-field">
        <label class="corr-label">Comment</label>
        <input v-model="comment" class="corr-input" placeholder="Optional internal note…" />
      </div>

      <!-- Direction + Balance type row -->
      <div class="corr-field">
        <label class="corr-label">Correction Type</label>
        <div class="corr-dir-row">
          <div class="corr-dir-btns">
            <button
              class="corr-dir-btn"
              :class="direction === 'up' ? 'corr-dir-btn--up-active' : ''"
              @click="direction = 'up'"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
              Up
            </button>
            <button
              class="corr-dir-btn"
              :class="direction === 'down' ? 'corr-dir-btn--down-active' : ''"
              @click="direction = 'down'"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
              Down
            </button>
          </div>
          <div class="corr-balance-type-btns">
            <button
              class="corr-bal-btn"
              :class="balanceType === 'real' ? 'corr-bal-btn--active' : ''"
              @click="balanceType = 'real'"
            >Real</button>
            <button
              class="corr-bal-btn"
              :class="balanceType === 'bonus' ? 'corr-bal-btn--active' : ''"
              @click="balanceType = 'bonus'"
            >Bonus</button>
          </div>
          <div class="corr-balance-display">
            <span class="corr-balance-label">Balance:</span>
            <span class="corr-balance-val">
              {{ currentBalance !== null ? currentBalance.toFixed(2) : '—' }} ETB
            </span>
          </div>
        </div>
      </div>

      <!-- Amount -->
      <div class="corr-field">
        <label class="corr-label">Amount (ETB) <span class="corr-req">*</span></label>
        <input
          v-model.number="correctionAmount"
          type="number"
          min="0.01"
          step="0.01"
          class="corr-input corr-input--amount"
          placeholder="0.00"
        />
      </div>

      <!-- Submit -->
      <button
        class="corr-submit"
        :disabled="submitting || !selectedPlayer || !correctionAmount || !description.trim()"
        @click="submitCorrection"
      >
        <svg v-if="submitting" class="corr-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 11-18 0"/></svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Apply Correction
      </button>
    </div>

    <!-- ── History ─────────────────────────────────────────────────────────── -->
    <div class="corr-history">
      <div class="corr-history-header">
        <h2 class="corr-history-title">Correction History</h2>
        <div class="corr-history-filters">
          <input v-model="filterSerial" class="corr-filter-input" placeholder="Player ID" @input="historyPage = 1" />
          <input v-model="filterFrom" type="date" class="corr-filter-input" @change="historyPage = 1" />
          <input v-model="filterTo" type="date" class="corr-filter-input" @change="historyPage = 1" />
          <button
            v-if="filterFrom || filterTo || filterSerial"
            class="corr-filter-reset"
            @click="filterFrom = ''; filterTo = ''; filterSerial = ''; historyPage = 1"
          >Reset</button>
        </div>
      </div>

      <!-- Table -->
      <div class="corr-table-wrap">
        <table class="corr-table">
          <thead>
            <tr>
              <th>Player ID</th>
              <th>Username</th>
              <th>Phone</th>
              <th>Type</th>
              <th class="text-right">Amount</th>
              <th class="text-right">Before Balance</th>
              <th>Description</th>
              <th>Date</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="historyLoading">
              <td colspan="9" class="corr-empty">
                <svg class="corr-spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 11-18 0"/></svg>
              </td>
            </tr>
            <tr v-else-if="!history.length">
              <td colspan="9" class="corr-empty">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.2;margin-bottom:8px"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
                <div>No Data Yet</div>
              </td>
            </tr>
            <tr v-for="row in history" :key="row.id" class="corr-row">
              <td>
                <div class="corr-id-cell">
                  <span class="corr-serial">#{{ formatSerial(row.user?.serial) }}</span>
                  <button class="corr-copy-btn" title="Copy ID" @click="copyToClipboard(String(row.user?.serial ?? ''))">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                  </button>
                </div>
              </td>
              <td>
                <NuxtLink v-if="row.user?.id" :to="`/players/${row.user.id}`" class="corr-username-link">
                  {{ row.user?.username ?? '—' }}
                </NuxtLink>
                <span v-else class="corr-muted">—</span>
              </td>
              <td class="corr-muted font-mono text-xs">{{ row.user?.phone ?? '—' }}</td>
              <td>
                <span
                  class="corr-type-badge"
                  :class="row.type === 'ADMIN_REAL_ADJUSTMENT' ? 'corr-type-badge--real' : 'corr-type-badge--bonus'"
                >
                  {{ row.type === 'ADMIN_REAL_ADJUSTMENT' ? 'Real' : 'Bonus' }}
                </span>
              </td>
              <td class="text-right">
                <span
                  class="corr-amount"
                  :class="Number(row.amount) >= 0 ? 'corr-amount--up' : 'corr-amount--down'"
                >
                  {{ Number(row.amount) >= 0 ? '+' : '' }}{{ Number(row.amount).toFixed(2) }}
                </span>
              </td>
              <td class="text-right corr-muted font-mono text-xs">{{ Number(row.balanceBefore ?? 0).toFixed(2) }}</td>
              <td class="corr-note-cell">{{ row.note ?? '—' }}</td>
              <td class="corr-muted text-xs">{{ formatDate(row.createdAt) }}</td>
              <td>
                <NuxtLink v-if="row.user?.id" :to="`/players/${row.user.id}`">
                  <button class="corr-view-btn">View</button>
                </NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="corr-pagination">
        <span class="corr-pg-info">{{ historyTotal }} total · Page {{ historyPage }} of {{ totalPages }}</span>
        <div class="corr-pg-btns">
          <button class="corr-pg-btn" :disabled="historyPage <= 1" @click="historyPage--">Prev</button>
          <button class="corr-pg-btn" :disabled="historyPage >= totalPages" @click="historyPage++">Next</button>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.corr-page {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding-bottom: 60px;
}

/* Header */
.corr-header { display: flex; align-items: flex-start; justify-content: space-between; }
.corr-title { font-size: 22px; font-weight: 700; color: var(--text-primary); margin: 0 0 2px; }
.corr-sub { font-size: 13px; color: var(--text-secondary); opacity: 0.6; }

/* Form card */
.corr-form-card {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: 16px;
  padding: 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.corr-field { display: flex; flex-direction: column; gap: 6px; }
.corr-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em; }
.corr-req { color: #f87171; }

.corr-input {
  width: 100%;
  height: 42px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  padding: 0 14px;
  transition: border-color 0.15s;
  box-sizing: border-box;
}
.corr-input:focus { outline: none; border-color: var(--brand-primary); }
.corr-input--amount { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }

/* Player search */
.corr-player-wrap { position: relative; }
.corr-player-input-row { display: flex; align-items: center; gap: 8px; }
.corr-clear-btn {
  flex-shrink: 0;
  width: 30px; height: 30px;
  border-radius: 8px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.5);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.12s;
}
.corr-clear-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }

.corr-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0; right: 0;
  z-index: 50;
  background: #1a2235;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.corr-dropdown-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  transition: background 0.1s;
}
.corr-dropdown-item:hover { background: rgba(255,255,255,0.05); }
.corr-dropdown-item:last-child { border-bottom: none; }
.corr-drop-serial { font-size: 11px; font-weight: 700; color: var(--brand-primary); font-family: monospace; }
.corr-drop-name { font-size: 13px; color: var(--text-primary); font-weight: 600; flex: 1; }
.corr-drop-phone { font-size: 11px; color: var(--text-secondary); font-family: monospace; }

.corr-player-chip {
  display: flex; align-items: center; gap: 10px;
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(245,158,11,0.08);
  border: 1px solid rgba(245,158,11,0.2);
  border-radius: 10px;
}
.corr-chip-serial { font-size: 12px; font-weight: 700; color: var(--brand-primary); font-family: monospace; }
.corr-chip-name { font-size: 13px; color: var(--text-primary); font-weight: 600; flex: 1; }
.corr-chip-phone { font-size: 12px; color: var(--text-secondary); font-family: monospace; }

/* Direction + balance type row */
.corr-dir-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.corr-dir-btns, .corr-balance-type-btns {
  display: flex;
  gap: 6px;
}
.corr-dir-btn, .corr-bal-btn {
  display: flex; align-items: center; gap: 5px;
  height: 36px; padding: 0 16px;
  border-radius: 8px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  color: var(--text-secondary);
  font-size: 13px; font-weight: 600; font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}
.corr-dir-btn:hover, .corr-bal-btn:hover { background: rgba(255,255,255,0.09); color: var(--text-primary); }
.corr-dir-btn--up-active { background: rgba(34,197,94,0.15) !important; border-color: #22c55e !important; color: #22c55e !important; }
.corr-dir-btn--down-active { background: rgba(239,68,68,0.15) !important; border-color: #ef4444 !important; color: #ef4444 !important; }
.corr-bal-btn--active { background: rgba(245,158,11,0.15) !important; border-color: var(--brand-primary) !important; color: var(--brand-primary) !important; }

.corr-balance-display {
  display: flex; align-items: center; gap: 6px;
  margin-left: auto;
}
.corr-balance-label { font-size: 12px; color: var(--text-secondary); }
.corr-balance-val { font-size: 15px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }

/* Submit */
.corr-submit {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  height: 48px;
  border-radius: 12px;
  background: var(--brand-primary);
  border: none;
  color: #000;
  font-size: 15px; font-weight: 700; font-family: inherit;
  cursor: pointer;
  transition: opacity 0.15s;
}
.corr-submit:hover:not(:disabled) { opacity: 0.88; }
.corr-submit:disabled { opacity: 0.4; cursor: not-allowed; }
.corr-spinner { animation: spin 0.8s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* History section */
.corr-history { display: flex; flex-direction: column; gap: 12px; }
.corr-history-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.corr-history-title { font-size: 16px; font-weight: 700; color: var(--text-primary); margin: 0; }
.corr-history-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.corr-filter-input {
  height: 34px; padding: 0 10px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 12px; font-family: inherit;
}
.corr-filter-input:focus { outline: none; border-color: var(--brand-primary); }
.corr-filter-reset {
  height: 34px; padding: 0 12px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 12px; font-weight: 600; font-family: inherit;
  cursor: pointer;
}
.corr-filter-reset:hover { background: rgba(255,255,255,0.09); color: var(--text-primary); }

/* Table */
.corr-table-wrap {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: 14px;
  overflow: hidden;
}
.corr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.corr-table thead tr { background: var(--surface-overlay); }
.corr-table th {
  padding: 10px 12px;
  text-align: left;
  font-size: 11px; font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  border-bottom: 1px solid var(--surface-border);
}
.corr-table th.text-right { text-align: right; }
.corr-row { border-bottom: 1px solid rgba(255,255,255,0.04); transition: background 0.1s; }
.corr-row:hover { background: rgba(255,255,255,0.02); }
.corr-row:last-child { border-bottom: none; }
.corr-table td { padding: 10px 12px; color: var(--text-primary); vertical-align: middle; }
.corr-table td.text-right { text-align: right; }

.corr-empty {
  text-align: center;
  padding: 48px 16px;
  color: var(--text-secondary);
  opacity: 0.5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
}

/* Table cells */
.corr-id-cell { display: flex; align-items: center; gap: 5px; }
.corr-serial { font-family: monospace; font-size: 12px; font-weight: 700; color: var(--brand-primary); }
.corr-copy-btn {
  display: flex; align-items: center; justify-content: center;
  width: 20px; height: 20px;
  border-radius: 4px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.4);
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.corr-copy-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }

.corr-username-link { color: #60a5fa; text-decoration: none; font-weight: 600; }
.corr-username-link:hover { text-decoration: underline; }
.corr-muted { color: var(--text-secondary); opacity: 0.6; }
.font-mono { font-family: monospace; }
.text-xs { font-size: 12px; }

.corr-type-badge {
  display: inline-flex; align-items: center;
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.corr-type-badge--real { background: rgba(245,158,11,0.12); color: #fbbf24; border: 1px solid rgba(245,158,11,0.2); }
.corr-type-badge--bonus { background: rgba(34,211,238,0.1); color: #22d3ee; border: 1px solid rgba(34,211,238,0.2); }

.corr-amount { font-family: monospace; font-size: 13px; font-weight: 700; }
.corr-amount--up { color: #22c55e; }
.corr-amount--down { color: #ef4444; }

.corr-note-cell { color: var(--text-secondary); font-size: 12px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.corr-view-btn {
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  color: var(--text-secondary);
  font-size: 11px; font-weight: 600; font-family: inherit;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.corr-view-btn:hover { background: rgba(255,255,255,0.1); color: var(--text-primary); }

/* Pagination */
.corr-pagination {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 2px;
}
.corr-pg-info { font-size: 12px; color: var(--text-secondary); opacity: 0.6; }
.corr-pg-btns { display: flex; gap: 8px; }
.corr-pg-btn {
  padding: 5px 14px;
  border-radius: 7px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  color: var(--text-secondary);
  font-size: 12px; font-weight: 600; font-family: inherit;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.corr-pg-btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); color: var(--text-primary); }
.corr-pg-btn:disabled { opacity: 0.3; cursor: not-allowed; }
</style>
