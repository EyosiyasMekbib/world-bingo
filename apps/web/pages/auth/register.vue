<template>
  <div class="auth-page">
    <h2>Register</h2>
    <form @submit.prevent="handleRegister">
      <input v-model="form.username" type="text" placeholder="Username" required />
      <input v-model="form.phone" type="text" placeholder="Phone Number" required />
      <input v-model="form.password" type="password" placeholder="Password" required />
      <button type="submit">Register</button>
    </form>
    <p>Already have an account? <NuxtLink to="/auth/login">Login</NuxtLink></p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const auth = useAuth()
const router = useRouter()

const form = ref({
  username: '',
  phone: '',
  password: ''
})

async function handleRegister() {
  try {
    await auth.register(form.value)
    router.push('/')
  } catch (e) {
    alert('Registration failed')
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
