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
let searchTimer: ReturnType<typeof setTimeout> | null = null

// ── Role modal ─────────────────────────────────────────────────────────────
const showRoleModal = ref(false)
const selectedUser = ref<any>(null)
const newRole = ref('')
const roleLoading = ref(false)

// ── User detail modal ──────────────────────────────────────────────────────
const showDetailModal = ref(false)
const detailUser = ref<any>(null)

// ── Fetch ──────────────────────────────────────────────────────────────────
async function fetchUsers() {
  loading.value = true
  try {
    const result = await getUsers({
      page: page.value,
      limit,
      search: searchQuery.value || undefined,
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

watch(page, fetchUsers)
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
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-neutral-900">Users</h1>
        <p class="text-sm text-neutral-500 mt-0.5">{{ totalUsers.toLocaleString() }} total users</p>
      </div>
      <UButton icon="i-heroicons-arrow-path" color="neutral" variant="ghost" label="Refresh" @click="fetchUsers" />
    </div>

    <!-- Search bar -->
    <UInput
      v-model="searchQuery"
      icon="i-heroicons-magnifying-glass"
      placeholder="Search by username or phone…"
      class="max-w-sm"
      @input="onSearch"
    />

    <!-- Table -->
    <UCard class="overflow-hidden p-0">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-neutral-50 border-b border-neutral-200">
            <tr>
              <th class="text-left px-4 py-3 text-neutral-500 font-medium">Username</th>
              <th class="text-left px-4 py-3 text-neutral-500 font-medium">Phone</th>
              <th class="text-left px-4 py-3 text-neutral-500 font-medium">Role</th>
              <th class="text-right px-4 py-3 text-neutral-500 font-medium">Balance (ETB)</th>
              <th class="text-left px-4 py-3 text-neutral-500 font-medium">Joined</th>
              <th class="text-right px-4 py-3 text-neutral-500 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <tr v-if="loading">
              <td colspan="6" class="px-4 py-12 text-center text-neutral-400">
                <div class="flex justify-center"><UIcon name="i-heroicons-arrow-path" class="w-5 h-5 animate-spin" /></div>
              </td>
            </tr>
            <tr v-else-if="!users.length">
              <td colspan="6" class="px-4 py-12 text-center text-neutral-400">
                <UIcon name="i-heroicons-users" class="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p>No users found</p>
              </td>
            </tr>
            <tr v-for="user in users" :key="user.id" class="hover:bg-neutral-50 transition-colors">
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <div class="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 font-bold text-xs flex-shrink-0">
                    {{ user.username[0].toUpperCase() }}
                  </div>
                  <button class="font-medium text-neutral-900 hover:text-primary-600 transition-colors" @click="openDetail(user)">
                    {{ user.username }}
                  </button>
                </div>
              </td>
              <td class="px-4 py-3 text-neutral-600 font-mono text-xs">{{ user.phone }}</td>
              <td class="px-4 py-3">
                <UBadge :color="roleColor(user.role)" variant="subtle" :label="user.role" />
              </td>
              <td class="px-4 py-3 text-right font-mono text-neutral-700">
                {{ Number(user.wallet?.balance ?? 0).toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
              </td>
              <td class="px-4 py-3 text-neutral-500 text-xs">{{ formatDate(user.createdAt) }}</td>
              <td class="px-4 py-3 text-right">
                <UButton
                  v-if="user.role !== 'SUPER_ADMIN'"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-heroicons-shield-check"
                  label="Role"
                  @click="openRoleModal(user)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="flex items-center justify-between px-4 py-3 border-t border-neutral-200">
        <span class="text-sm text-neutral-500">Page {{ page }} of {{ totalPages }}</span>
        <div class="flex gap-2">
          <UButton size="sm" color="neutral" variant="ghost" icon="i-heroicons-chevron-left" :disabled="page <= 1" @click="page--" />
          <UButton size="sm" color="neutral" variant="ghost" icon="i-heroicons-chevron-right" :disabled="page >= totalPages" @click="page++" />
        </div>
      </div>
    </UCard>

    <!-- Role change modal -->
    <UModal v-model:open="showRoleModal" title="Change User Role">
      <template #body>
        <div v-if="selectedUser" class="space-y-4">
          <div class="flex items-center gap-3 p-3 bg-neutral-50 rounded-lg">
            <div class="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center font-bold text-amber-700">
              {{ selectedUser.username[0].toUpperCase() }}
            </div>
            <div>
              <p class="font-semibold text-neutral-900">{{ selectedUser.username }}</p>
              <p class="text-sm text-neutral-500">{{ selectedUser.phone }}</p>
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
    <UModal v-model:open="showDetailModal" :title="detailUser?.username ?? 'User Detail'">
      <template #body>
        <div v-if="detailUser" class="space-y-3 text-sm">
          <div class="grid grid-cols-2 gap-3">
            <div class="p-3 bg-neutral-50 rounded-lg">
              <p class="text-xs text-neutral-500 mb-1">Username</p>
              <p class="font-medium">{{ detailUser.username }}</p>
            </div>
            <div class="p-3 bg-neutral-50 rounded-lg">
              <p class="text-xs text-neutral-500 mb-1">Phone</p>
              <p class="font-medium font-mono">{{ detailUser.phone }}</p>
            </div>
            <div class="p-3 bg-neutral-50 rounded-lg">
              <p class="text-xs text-neutral-500 mb-1">Role</p>
              <UBadge :color="roleColor(detailUser.role)" variant="subtle" :label="detailUser.role" />
            </div>
            <div class="p-3 bg-neutral-50 rounded-lg">
              <p class="text-xs text-neutral-500 mb-1">Wallet Balance</p>
              <p class="font-semibold text-green-600">
                {{ Number(detailUser.wallet?.balance ?? 0).toLocaleString('en-ET', { minimumFractionDigits: 2 }) }} ETB
              </p>
            </div>
            <div class="p-3 bg-neutral-50 rounded-lg col-span-2">
              <p class="text-xs text-neutral-500 mb-1">User ID</p>
              <p class="font-mono text-xs text-neutral-600 break-all">{{ detailUser.id }}</p>
            </div>
          </div>
          <div class="text-xs text-neutral-400">
            Joined {{ formatDate(detailUser.createdAt) }}
          </div>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Close" @click="showDetailModal = false" />
      </template>
    </UModal>
  </div>
</template>
