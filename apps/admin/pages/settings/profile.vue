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
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold text-gray-900">Profile Settings</h1>
    </div>

    <UCard>
      <template #header>
        <h3 class="text-lg font-medium">Manager Identity</h3>
      </template>
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <span class="text-sm text-gray-500">Manager Username</span>
            <p class="font-semibold text-gray-900">{{ user?.username ?? '—' }}</p>
          </div>
          <div>
            <span class="text-sm text-gray-500">Role</span>
            <p class="font-semibold text-gray-900">{{ user?.role ?? '—' }}</p>
          </div>
          <div>
            <span class="text-sm text-gray-500">Phone</span>
            <p class="font-semibold text-gray-900">{{ user?.phone ?? '—' }}</p>
          </div>
        </div>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <h3 class="text-lg font-medium">Security Controls</h3>
      </template>
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div>
            <p class="font-medium text-gray-900">Two Step Verification Status</p>
            <p class="text-sm text-gray-500">{{ isTwoFactorEnabled ? 'Enabled' : 'Disabled' }}</p>
          </div>
          <UButton :color="isTwoFactorEnabled ? 'error' : 'primary'" :label="isTwoFactorEnabled ? 'DISABLE' : 'ENABLE'" @click="isTwoFactorEnabled = !isTwoFactorEnabled" />
        </div>

        <UDivider />

        <form class="space-y-4" @submit.prevent="handleSavePassword">
          <h4 class="font-medium text-gray-900">Change Password</h4>
          <UFormField label="Current Password" required>
            <UInput
              v-model="passwordForm.currentPassword"
              type="password"
              placeholder="Current password"
              icon="i-heroicons-lock-closed"
              class="w-full"
              autocomplete="current-password"
            />
          </UFormField>
          <UFormField label="New Password" required>
            <UInput
              v-model="passwordForm.newPassword"
              type="password"
              placeholder="New password (min 6 chars)"
              icon="i-heroicons-key"
              class="w-full"
              autocomplete="new-password"
            />
          </UFormField>
          <UFormField label="Confirm New Password" required>
            <UInput
              v-model="passwordForm.confirmPassword"
              type="password"
              placeholder="Repeat new password"
              icon="i-heroicons-key"
              class="w-full"
              autocomplete="new-password"
            />
          </UFormField>
          <UButton type="submit" color="primary" :loading="loading" label="CHANGE PASSWORD" />
        </form>
      </div>
    </UCard>
  </div>
</template>

