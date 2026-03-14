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
      <h1 class="text-2xl font-bold text-white tracking-tight">Profile & Security</h1>
      <p class="text-sm text-white/50 mt-0.5 font-medium">Manage your administrative credentials</p>
    </div>

    <!-- Identity card -->
    <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl" style="background:var(--surface-raised);">
      <div class="px-5 py-4 border-b border-(--surface-border)" style="background:var(--surface-overlay);">
        <h3 class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Administrator Identity</h3>
      </div>
      <div class="p-5 grid grid-cols-2 gap-5">
        <div>
          <span class="text-[10px] font-bold text-white/30 uppercase tracking-widest">Username</span>
          <p class="font-bold text-white text-base mt-0.5 tracking-tight">{{ user?.username ?? '—' }}</p>
        </div>
        <div>
          <span class="text-[10px] font-bold text-white/30 uppercase tracking-widest">Security Clearance</span>
          <p class="font-bold text-yellow-500 text-base mt-0.5 tracking-tight">{{ user?.role ?? '—' }}</p>
        </div>
        <div>
          <span class="text-[10px] font-bold text-white/30 uppercase tracking-widest">Registered Phone</span>
          <p class="font-bold text-white font-mono text-base mt-0.5 tracking-tight">{{ user?.phone ?? '—' }}</p>
        </div>
      </div>
    </div>

    <!-- Security card -->
    <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl" style="background:var(--surface-raised);">
      <div class="px-5 py-4 border-b border-(--surface-border)" style="background:var(--surface-overlay);">
        <h3 class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Security Controls</h3>
      </div>
      <div class="p-5 space-y-6">
        <div class="flex items-center justify-between p-4 rounded-xl border border-(--surface-border)" style="background:var(--surface-overlay);">
          <div>
            <p class="font-bold text-white tracking-tight">Two-Factor Authentication</p>
            <p class="text-sm text-white/40 font-medium">{{ isTwoFactorEnabled ? 'Secure' : 'Unprotected' }}</p>
          </div>
          <UButton
            :color="isTwoFactorEnabled ? 'error' : 'primary'"
            :label="isTwoFactorEnabled ? 'DISABLE' : 'ENABLE'"
            class="font-bold"
            @click="isTwoFactorEnabled = !isTwoFactorEnabled"
          />
        </div>

        <div class="pt-2">
          <form class="space-y-4" @submit.prevent="handleSavePassword">
            <h4 class="font-bold text-white tracking-tight text-base mb-3 border-l-2 border-yellow-500 pl-3">Update Access Key</h4>
            <UFormField label="Current Password" required>
              <UInput
                v-model="passwordForm.currentPassword"
                type="password"
                placeholder="Required for security"
                icon="i-heroicons:lock-closed"
                class="w-full"
                autocomplete="current-password"
              />
            </UFormField>
            <UFormField label="New Password" required>
              <UInput
                v-model="passwordForm.newPassword"
                type="password"
                placeholder="Min 6 characters recommended"
                icon="i-heroicons:key"
                class="w-full"
                autocomplete="new-password"
              />
            </UFormField>
            <UFormField label="Verify New Password" required>
              <UInput
                v-model="passwordForm.confirmPassword"
                type="password"
                placeholder="Repeat new password"
                icon="i-heroicons:key"
                class="w-full"
                autocomplete="new-password"
              />
            </UFormField>
            <div class="flex justify-end pt-2">
              <UButton type="submit" color="primary" block size="lg" :loading="loading" label="Update Credentials" />
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>

