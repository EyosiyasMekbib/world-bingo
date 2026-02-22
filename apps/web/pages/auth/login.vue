<template>
  <div class="auth-page">
    <h2>Login</h2>
    <form @submit.prevent="handleLogin">
      <input v-model="form.identifier" type="text" placeholder="Phone or Username" required />
      <input v-model="form.password" type="password" placeholder="Password" required />
      <button type="submit">Login</button>
    </form>
    <p>Don't have an account? <NuxtLink to="/auth/register">Register</NuxtLink></p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const auth = useAuth()
const router = useRouter()

const form = ref({
  identifier: '',
  password: ''
})

async function handleLogin() {
  try {
    await auth.login(form.value)
    router.push('/')
  } catch (e) {
    alert('Login failed')
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
</style>
