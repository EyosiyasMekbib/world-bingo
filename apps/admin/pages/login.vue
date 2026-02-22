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
    navigateTo('/')
  } catch (err: any) {
    toast.add({ title: 'Error', description: err.data?.message || 'Invalid credentials', color: 'error' })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
    <div class="sm:mx-auto sm:w-full sm:max-w-md">
      <div class="flex justify-center">
        <UIcon name="i-heroicons-globe-alt" class="w-12 h-12 text-primary-600" />
      </div>
      <h2 class="mt-6 text-center text-3xl font-extrabold text-gray-900">
        Admin Portal
      </h2>
    </div>

    <div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
      <UCard>
        <form @submit.prevent="handleLogin" class="space-y-6">
          <UFormField label="Phone or Username" required>
            <UInput v-model="form.identifier" icon="i-heroicons-user" placeholder="Username or +251..." class="w-full" />
          </UFormField>

          <UFormField label="Password" required>
            <UInput v-model="form.password" type="password" icon="i-heroicons-lock-closed" placeholder="••••••••" class="w-full" />
          </UFormField>

          <div>
            <UButton type="submit" color="primary" block :loading="loading">
              Sign In
            </UButton>
          </div>
        </form>
      </UCard>
    </div>
  </div>
</template>
