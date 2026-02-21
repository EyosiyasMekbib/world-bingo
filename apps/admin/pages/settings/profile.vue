<script setup lang="ts">
import { ref } from 'vue'

const isTwoFactorEnabled = ref(false)

const handleSavePassword = () => {
  console.log('Password change requested')
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
            <span class="text-sm text-gray-500">Manager ID</span>
            <p class="font-semibold text-gray-900">37</p>
          </div>
          <div>
            <span class="text-sm text-gray-500">Manager Username</span>
            <p class="font-semibold text-gray-900">kira</p>
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
          <UButton :color="isTwoFactorEnabled ? 'red' : 'primary'" label="ENABLE" @click="isTwoFactorEnabled = !isTwoFactorEnabled" />
        </div>

        <UDivider />

        <div class="space-y-4">
          <UFormGroup label="Change Password">
            <UInput type="password" placeholder="New Password" icon="i-heroicons-key" />
          </UFormGroup>
          <UButton color="black" label="CHANGE PASSWORD" @click="handleSavePassword" />
        </div>
      </div>
    </UCard>
  </div>
</template>
