<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { getUsers, updateUserRole } = useAdminApi()
const toast = useToast()

// ── State ──────────────────────────────────────────────────────────────────
const users = ref<any[]>([])
const loading = ref(false)
const page = ref(1)
const limit = 20
const totalPages = ref(1)
const totalUsers = ref(0)
const searchQuery = ref('')
const selectedRole = ref('__ALL__')
const viewMode = ref<'table' | 'card'>('table')
let searchTimer: ReturnType<typeof setTimeout> | null = null

// ── Role modal ─────────────────────────────────────────────────────────────
const showRoleModal = ref(false)
const selectedUser = ref<any>(null)
const newRole = ref('')
const roleLoading = ref(false)

// ── User detail modal ──────────────────────────────────────────────────────
const showDetailModal = ref(false)
const detailUser = ref<any>(null)

// ── Role options ───────────────────────────────────────────────────────────
const roleOptions = [
  { label: 'All Roles', value: '__ALL__' },
  { label: 'Player', value: 'PLAYER' },
  { label: 'Admin', value: 'ADMIN' },
  { label: 'Super Admin', value: 'SUPER_ADMIN' },
]

// ── Fetch ──────────────────────────────────────────────────────────────────
async function fetchUsers() {
  loading.value = true
  try {
    const result = await getUsers({
      page: page.value,
      limit,
      search: searchQuery.value || undefined,
      role: selectedRole.value === '__ALL__' ? undefined : selectedRole.value
    }) as any
    users.value = result?.data ?? result ?? []
    if (result?.pagination) {
      totalPages.value = result.pagination.totalPages
      totalUsers.value = result.pagination.total
    }
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to load users', color: 'error' })
  } finally {
    loading.value = false
  }
}

// Debounced search
function onSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    page.value = 1
    fetchUsers()
  }, 400)
}

watch([page, selectedRole], fetchUsers)
onMounted(fetchUsers)

// ── Role change ────────────────────────────────────────────────────────────
function openRoleModal(user: any) {
  selectedUser.value = user
  newRole.value = user.role
  showRoleModal.value = true
}

async function confirmRoleChange() {
  if (!selectedUser.value || !newRole.value) return
  roleLoading.value = true
  try {
    await updateUserRole(selectedUser.value.id, newRole.value)
    toast.add({ title: 'Role updated', description: `${selectedUser.value.username} is now ${newRole.value}`, color: 'success' })
    // Update locally
    const idx = users.value.findIndex(u => u.id === selectedUser.value.id)
    if (idx !== -1) users.value[idx] = { ...users.value[idx], role: newRole.value }
    showRoleModal.value = false
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to update role', color: 'error' })
  } finally {
    roleLoading.value = false
  }
}

// ── User detail ────────────────────────────────────────────────────────────
function openDetail(user: any) {
  detailUser.value = user
  showDetailModal.value = true
}

// ── Helpers ────────────────────────────────────────────────────────────────
function roleColor(role: string) {
  if (role === 'SUPER_ADMIN') return 'error'
  if (role === 'ADMIN') return 'warning'
  return 'neutral'
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-ET', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatUserId(serial?: number) {
  if (!serial) return '—'
  return String(serial).padStart(5, '0')
}

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}
</script>

<template>
  <div class="space-y-6 pb-20 md:pb-0">
    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Platform Users</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">{{ totalUsers.toLocaleString() }} total accounts</p>
      </div>
      <div class="flex items-center gap-2">
        <UButtonGroup size="sm">
          <UButton
            :variant="viewMode === 'table' ? 'solid' : 'ghost'"
            color="neutral"
            icon="i-heroicons:table-cells"
            @click="viewMode = 'table'"
          />
          <UButton
            :variant="viewMode === 'card' ? 'solid' : 'ghost'"
            color="neutral"
            icon="i-heroicons:squares-2x2"
            @click="viewMode = 'card'"
          />
        </UButtonGroup>
        <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" label="Refresh" @click="fetchUsers" />
      </div>
    </div>

    <!-- Toolbar Filters -->
    <div class="flex items-center gap-3 flex-wrap bg-white/5 p-3 rounded-2xl border border-white/5 shadow-inner">
      <UInput
        v-model="searchQuery"
        icon="i-heroicons:magnifying-glass"
        placeholder="Search by username or phone…"
        class="flex-1 min-w-60"
        @input="onSearch"
      />
      <USelect
        v-model="selectedRole"
        :items="roleOptions"
        icon="i-heroicons:funnel"
        placeholder="All Roles"
        class="w-full md:w-48"
        value-key="value"
      />
    </div>

    <!-- Table View -->
    <div v-if="viewMode === 'table'" class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl bg-(--surface-raised)">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="border-b border-(--surface-border) bg-(--surface-overlay)">
            <tr>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">ID</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Username</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Phone</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Role</th>
              <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Balance (ETB)</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Joined</th>
              <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            <tr v-if="loading">
              <td colspan="7" class="px-4 py-12 text-center text-white/40">
                <div class="flex justify-center"><UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin" /></div>
              </td>
            </tr>
            <tr v-else-if="!users.length">
              <td colspan="7" class="px-4 py-12 text-center text-white/30">
                <UIcon name="i-heroicons:users" class="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p>No users found</p>
              </td>
            </tr>
            <tr v-for="user in users" :key="user.id" class="hover:bg-white/3 transition-colors">
              <td class="px-4 py-3 text-white/30 font-mono text-xs">{{ formatUserId(user.serial) }}</td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <div class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-black text-xs shrink-0 bg-(--brand-primary)">
                    {{ user.username[0].toUpperCase() }}
                  </div>
                  <button class="font-semibold text-zinc-200 hover:text-yellow-500 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yellow-400 rounded" :aria-label="`View profile for ${user.username}`" @click="openDetail(user)">
                    {{ user.username }}
                  </button>
                </div>
              </td>
              <td class="px-4 py-3 text-white/40 font-mono text-xs">
                <div class="flex items-center gap-1.5 px-1 py-0.5 rounded-lg hover:bg-white/5 transition-colors group">
                  <span>{{ user.phone }}</span>
                  <UButton
                    icon="i-heroicons:clipboard-document"
                    variant="ghost" color="primary" size="xs"
                    :aria-label="`Copy phone number ${user.phone}`"
                    class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity p-0.5"
                    @click="copyToClipboard(user.phone)"
                  />
                </div>
              </td>
              <td class="px-4 py-3">
                <UBadge :color="roleColor(user.role)" variant="soft" :label="user.role" />
              </td>
              <td class="px-4 py-3 text-right font-mono text-yellow-500 font-bold">
                {{ Number(user.wallet?.realBalance ?? 0).toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }} + {{ Number(user.wallet?.bonusBalance ?? 0).toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}B
              </td>
              <td class="px-4 py-3 text-white/40 text-xs font-medium">{{ formatDate(user.createdAt) }}</td>
              <td class="px-4 py-3 text-right">
                <UButton
                  v-if="user.role !== 'SUPER_ADMIN'"
                  size="xs" color="neutral" variant="ghost"
                  icon="i-heroicons:shield-check" label="Role"
                  @click="openRoleModal(user)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Card View -->
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      <div v-if="loading" class="col-span-full flex justify-center py-12">
        <UIcon name="i-heroicons:arrow-path" class="w-8 h-8 animate-spin text-white/20" />
      </div>
      <div v-else-if="!users.length" class="col-span-full text-center py-12 text-white/30 bg-white/5 rounded-3xl border border-white/5">
        <UIcon name="i-heroicons:users" class="w-12 h-12 mx-auto mb-3 opacity-20" />
        <p class="text-lg font-medium">No users found</p>
        <p class="text-sm">Try adjusting your filters</p>
      </div>
      <div
        v-for="user in users" :key="user.id"
        class="relative p-5 rounded-3xl border border-white/5 bg-(--surface-raised) hover:bg-white/5 transition-all duration-300 group shadow-lg"
      >
        <div class="flex justify-between items-start mb-4">
          <div class="flex items-center gap-3">
            <div class="w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-black text-xl bg-(--brand-primary) shadow-lg transform group-hover:scale-105 transition-transform">
              {{ user.username[0].toUpperCase() }}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <h3 class="font-bold text-zinc-100 hover:text-yellow-500 transition-colors cursor-pointer" @click="openDetail(user)">
                  {{ user.username }}
                </h3>
                <UBadge :color="roleColor(user.role)" variant="soft" size="xs" :label="user.role" />
              </div>
              <p class="text-[10px] text-white/30 font-mono tracking-wider">{{ formatUserId(user.serial) }}</p>
            </div>
          </div>
          <UButton
            v-if="user.role !== 'SUPER_ADMIN'"
            icon="i-heroicons:shield-check"
            variant="ghost" color="neutral" size="xs"
            @click="openRoleModal(user)"
          />
        </div>

        <div class="space-y-3">
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-black/20 border border-white/5">
            <span class="text-[10px] font-bold text-white/30 uppercase tracking-widest">Phone</span>
            <div class="flex items-center gap-1">
              <span class="text-xs font-mono text-zinc-400">{{ user.phone }}</span>
              <UButton icon="i-heroicons:clipboard-document" variant="ghost" color="primary" size="xs" class="p-0.5" @click="copyToClipboard(user.phone)" />
            </div>
          </div>
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-black/20 border border-white/5">
            <span class="text-[10px] font-bold text-white/30 uppercase tracking-widest">Balance</span>
            <span class="text-sm font-bold text-yellow-500">{{ Number(user.wallet?.realBalance ?? 0).toLocaleString('en-ET', { minimumFractionDigits: 2 }) }} + {{ Number(user.wallet?.bonusBalance ?? 0).toFixed(2) }}B <span class="text-[10px] text-white/30 font-normal">ETB</span></span>
          </div>
        </div>

        <div class="mt-4 pt-3 border-t border-white/5 flex justify-between items-center">
          <span class="text-[10px] text-white/20 font-medium">Joined {{ formatDate(user.createdAt) }}</span>
          <UButton label="View Profile" variant="link" color="neutral" size="xs" class="p-0 opacity-50 hover:opacity-100" @click="openDetail(user)" />
        </div>
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-4 border-t border-(--surface-border) mt-6">
      <span class="text-sm text-white/40">Page {{ page }} of {{ totalPages }}</span>
      <div class="flex gap-2">
        <UButton size="sm" color="neutral" variant="ghost" icon="i-heroicons:chevron-left" :disabled="page <= 1" @click="page--" label="Prev" />
        <UButton size="sm" color="neutral" variant="ghost" icon="i-heroicons:chevron-right" :disabled="page >= totalPages" @click="page++" label="Next" />
      </div>
    </div>

    <!-- Role change modal -->
    <UModal v-model:open="showRoleModal" title="Change User Role" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div v-if="selectedUser" class="space-y-4">
          <div class="flex items-center gap-3 p-4 rounded-xl border border-(--surface-border)" style="background:var(--surface-overlay);">
            <div class="w-12 h-12 rounded-full flex items-center justify-center font-bold text-black text-lg" style="background:var(--brand-primary);">
              {{ selectedUser.username[0].toUpperCase() }}
            </div>
            <div>
              <p class="font-bold text-white text-base tracking-tight">{{ selectedUser.username }}</p>
              <p class="text-sm text-white/50 font-mono">{{ selectedUser.phone }}</p>
            </div>
          </div>

          <UFormField label="New Role">
            <USelect v-model="newRole" :items="[
              { label: 'Player', value: 'PLAYER' },
              { label: 'Admin', value: 'ADMIN' },
            ]" class="w-full" value-key="value" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="showRoleModal = false" />
          <UButton
            color="primary"
            :loading="roleLoading"
            :disabled="newRole === selectedUser?.role"
            label="Save Changes"
            @click="confirmRoleChange"
          />
        </div>
      </template>
    </UModal>

    <!-- User detail modal -->
    <UModal v-model:open="showDetailModal" :title="detailUser?.username ?? 'User Profile Detail'" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div v-if="detailUser" class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div class="p-3.5 rounded-xl border border-(--surface-border)" style="background:var(--surface-overlay);">
              <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Username</p>
              <p class="font-bold text-white text-base tracking-tight">{{ detailUser.username }}</p>
            </div>
            <div class="p-3.5 rounded-xl border border-(--surface-border) relative group" style="background:var(--surface-overlay);">
              <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Phone</p>
              <p class="font-bold font-mono text-white text-base tracking-tight">{{ detailUser.phone }}</p>
              <UButton
                icon="i-heroicons:clipboard-document"
                class="absolute top-2 right-2 opacity-30 hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                variant="ghost" color="primary" size="xs"
                @click="copyToClipboard(detailUser.phone)"
              />
            </div>
            <div class="p-3.5 rounded-xl border border-(--surface-border)" style="background:var(--surface-overlay);">
              <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Access Role</p>
              <UBadge :color="roleColor(detailUser.role)" variant="soft" :label="detailUser.role" />
            </div>
            <div class="p-3.5 rounded-xl border border-(--surface-border)" style="background:var(--surface-overlay);">
              <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Wallet Credits</p>
              <p class="font-bold text-yellow-500 text-base">
                {{ Number(detailUser.wallet?.realBalance ?? 0).toLocaleString('en-ET', { minimumFractionDigits: 2 }) }} + {{ Number(detailUser.wallet?.bonusBalance ?? 0).toFixed(2) }}B <span class="text-[10px] text-white/40">ETB</span>
              </p>
            </div>
            <div class="p-3.5 rounded-xl border border-(--surface-border) col-span-2 relative group" style="background:var(--surface-overlay);">
              <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Internal Reference ID</p>
              <p class="font-mono text-xs text-white/30 break-all leading-relaxed">{{ detailUser.id }}</p>
              <UButton
                icon="i-heroicons:clipboard-document"
                class="absolute top-2 right-2 opacity-30 hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                variant="ghost" color="neutral" size="xs"
                @click="copyToClipboard(detailUser.id)"
              />
            </div>
          </div>
          <div class="text-[11px] font-semibold text-white/20 uppercase tracking-wider text-center pt-2">
            Registered on {{ formatDate(detailUser.createdAt) }}
          </div>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Close" @click="showDetailModal = false" />
      </template>
    </UModal>
  </div>
</template>
