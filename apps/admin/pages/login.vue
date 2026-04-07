<script setup lang="ts">
definePageMeta({
  layout: false // Login page shouldn't have the sidebar
})

const { login } = useAdminAuth()
const toast = useToast()

const form = reactive({
  identifier: '',
  password: ''
})

const loading = ref(false)

const handleLogin = async () => {
  loading.value = true
  try {
    await login(form)
    toast.add({ title: 'Success', description: 'Logged in as manager', color: 'success' })
    await navigateTo('/')
  } catch (err: any) {
    toast.add({ title: 'Error', description: err.data?.message || 'Invalid credentials', color: 'error' })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center px-4" style="background:var(--surface-base);">
    <!-- Ambient glow -->
    <div class="pointer-events-none fixed inset-0 overflow-hidden">
      <div class="absolute -top-32 -left-32 w-96 h-96 rounded-full opacity-10 blur-3xl" style="background:var(--brand-primary);" />
      <div class="absolute -bottom-32 -right-32 w-96 h-96 rounded-full opacity-8 blur-3xl" style="background:#4263EB;" />
    </div>

    <div class="relative w-full max-w-sm">
      <!-- Logo -->
      <div class="flex flex-col items-center mb-8">
        <img src="/logo.png" alt="World Bingo" class="w-20 h-20 object-contain mb-4" />
        <h1 class="text-2xl font-bold text-white tracking-tight">Admin Portal</h1>
        <p class="text-sm text-white/50 mt-1">World Bingo Management</p>
      </div>

      <!-- Card -->
      <div class="rounded-2xl border border-white/10 p-8 space-y-5 shadow-2xl" style="background:var(--surface-raised); border-color: var(--surface-border);">
        <form @submit.prevent="handleLogin" class="space-y-5">
          <UFormField label="Username or Phone" required>
            <UInput
              v-model="form.identifier"
              icon="i-heroicons:user"
              placeholder="Username or +251..."
              class="w-full"
              autocomplete="username"
            />
          </UFormField>

          <UFormField label="Password" required>
            <UInput
              v-model="form.password"
              type="password"
              icon="i-heroicons:lock-closed"
              placeholder="••••••••"
              class="w-full"
              autocomplete="current-password"
            />
          </UFormField>

          <UButton type="submit" color="primary" block size="lg" :loading="loading" class="mt-2">
            Sign In
          </UButton>
        </form>
      </div>
    </div>
  </div>
</template>
