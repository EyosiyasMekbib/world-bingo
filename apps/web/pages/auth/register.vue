<template>
  <div class="auth-page">
    <h2>Create Account</h2>
    <form @submit.prevent="handleRegister">
      <input v-model="form.username" type="text" placeholder="Username" required />
      <input v-model="form.phone" type="text" placeholder="Phone Number (+251...)" required />
      <input v-model="form.password" type="password" placeholder="Password (min 6 chars)" required />
      <div class="referral-field">
        <input
          v-model="form.referralCode"
          type="text"
          placeholder="Referral Code (optional)"
          maxlength="12"
          class="referral-input"
        />
        <span v-if="form.referralCode" class="referral-badge">🎁 Referral applied</span>
      </div>
      <button type="submit" :disabled="loading">
        {{ loading ? 'Creating account…' : 'Register' }}
      </button>
      <p v-if="error" class="error">{{ error }}</p>
    </form>
    <p>Already have an account? <NuxtLink to="/auth/login">Login</NuxtLink></p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const auth = useAuth()
const router = useRouter()
const route = useRoute()

const loading = ref(false)
const error = ref('')

const form = ref({
  username: '',
  phone: '',
  password: '',
  // Pre-fill from URL: /auth/register?ref=WB3FA29C
  referralCode: (route.query.ref as string) || '',
})

async function handleRegister() {
  loading.value = true
  error.value = ''
  try {
    await auth.register({
      username: form.value.username,
      phone: form.value.phone,
      password: form.value.password,
      referralCode: form.value.referralCode || undefined,
    })
    router.push('/')
  } catch (e: any) {
    error.value = e?.data?.message || 'Registration failed. Please try again.'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.auth-page {
  max-width: 400px;
  margin: 0 auto;
  padding: 2rem;
}
form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.referral-field {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.referral-input {
  font-family: monospace;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.referral-badge {
  font-size: 0.75rem;
  color: #16a34a;
  font-weight: 600;
}
.error {
  color: #dc2626;
  font-size: 0.875rem;
}
</style>
