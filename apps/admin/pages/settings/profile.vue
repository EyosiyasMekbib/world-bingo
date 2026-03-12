<script setup lang="ts">
const { user, apiFetch, logout } = useAdminAuth()
const toast = useToast()

const isTwoFactorEnabled = ref(false)

const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
})
const loading = ref(false)

const handleSavePassword = async () => {
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    toast.add({ title: 'Error', description: 'New passwords do not match', color: 'error' })
    return
  }
  if (passwordForm.newPassword.length < 6) {
    toast.add({ title: 'Error', description: 'Password must be at least 6 characters', color: 'error' })
    return
  }

  loading.value = true
  try {
    await apiFetch('/auth/change-password', {
      method: 'POST',
      body: {
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      },
    })
    toast.add({ title: 'Success', description: 'Password changed. Please log in again.', color: 'success' })
    passwordForm.currentPassword = ''
    passwordForm.newPassword = ''
    passwordForm.confirmPassword = ''
    // Invalidate session — server deleted all refresh tokens
    setTimeout(() => logout(), 1500)
  } catch (err: any) {
    toast.add({ title: 'Error', description: err.data?.message || 'Failed to change password', color: 'error' })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="space-y-6 max-w-2xl">
    <div>
      <h1 class="text-2xl font-bold text-white">Profile Settings</h1>
      <p class="text-sm text-zinc-500 mt-0.5">Manage your account and security</p>
    </div>

    <!-- Identity card -->
    <div class="rounded-2xl border border-white/8 overflow-hidden" style="background:#111827;">
      <div class="px-5 py-4 border-b border-white/8" style="background:#0d1220;">
        <h3 class="text-sm font-semibold text-zinc-300 uppercase tracking-wide">Manager Identity</h3>
      </div>
      <div class="p-5 grid grid-cols-2 gap-5">
        <div>
          <span class="text-xs text-zinc-500 uppercase tracking-wide">Username</span>
          <p class="font-semibold text-zinc-200 mt-1">{{ user?.username ?? '—' }}</p>
        </div>
        <div>
          <span class="text-xs text-zinc-500 uppercase tracking-wide">Role</span>
          <p class="font-semibold text-amber-400 mt-1">{{ user?.role ?? '—' }}</p>
        </div>
        <div>
          <span class="text-xs text-zinc-500 uppercase tracking-wide">Phone</span>
          <p class="font-semibold text-zinc-200 font-mono mt-1">{{ user?.phone ?? '—' }}</p>
        </div>
      </div>
    </div>

    <!-- Security card -->
    <div class="rounded-2xl border border-white/8 overflow-hidden" style="background:#111827;">
      <div class="px-5 py-4 border-b border-white/8" style="background:#0d1220;">
        <h3 class="text-sm font-semibold text-zinc-300 uppercase tracking-wide">Security Controls</h3>
      </div>
      <div class="p-5 space-y-6">
        <div class="flex items-center justify-between">
          <div>
            <p class="font-medium text-zinc-200">Two Step Verification</p>
            <p class="text-sm text-zinc-500">{{ isTwoFactorEnabled ? 'Enabled' : 'Disabled' }}</p>
          </div>
          <UButton
            :color="isTwoFactorEnabled ? 'error' : 'primary'"
            :label="isTwoFactorEnabled ? 'DISABLE' : 'ENABLE'"
            @click="isTwoFactorEnabled = !isTwoFactorEnabled"
          />
        </div>

        <div class="border-t border-white/8" />

        <form class="space-y-4" @submit.prevent="handleSavePassword">
          <h4 class="font-medium text-zinc-200">Change Password</h4>
          <UFormField label="Current Password" required>
            <UInput
              v-model="passwordForm.currentPassword"
              type="password"
              placeholder="Current password"
              icon="i-heroicons:lock-closed"
              class="w-full"
              autocomplete="current-password"
            />
          </UFormField>
          <UFormField label="New Password" required>
            <UInput
              v-model="passwordForm.newPassword"
              type="password"
              placeholder="New password (min 6 chars)"
              icon="i-heroicons:key"
              class="w-full"
              autocomplete="new-password"
            />
          </UFormField>
          <UFormField label="Confirm New Password" required>
            <UInput
              v-model="passwordForm.confirmPassword"
              type="password"
              placeholder="Repeat new password"
              icon="i-heroicons:key"
              class="w-full"
              autocomplete="new-password"
            />
          </UFormField>
          <UButton type="submit" color="primary" :loading="loading" label="CHANGE PASSWORD" />
        </form>
      </div>
    </div>
  </div>
</template>

