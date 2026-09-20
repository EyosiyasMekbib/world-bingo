<script setup lang="ts">
definePageMeta({ layout: false })

const { login } = useAgentAuth()
const route = useRoute()

const form = reactive({ username: '', password: '' })
const loading = ref(false)
const showPassword = ref(false)
// Set when apiFetch bounced the agent here after the API refused a suspended
// account. Without it the redirect looks like a random sign-out.
const errorMessage = ref(route.query.suspended ? SUSPENDED_MESSAGE : '')

const handleLogin = async () => {
  if (loading.value) return
  loading.value = true
  errorMessage.value = ''
  try {
    await login({ username: form.username.trim(), password: form.password })
    await navigateTo('/')
  } catch (err) {
    // A suspended shop, a wrong password and a non agent credential all
    // arrive here; the last of those is the API's own 403 from
    // /auth/agent/login. Whatever the API says is shown as it said it,
    // because the agent is the person who has to decide whether this is a
    // typo or a call to the operator.
    errorMessage.value =
      err instanceof Error && !(err as { data?: unknown }).data
        ? err.message
        : apiErrorMessage(err, 'Sign in failed. Check your username and password, then try again.')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-shell">
    <div class="login-card">
      <div class="wordmark">
        <span class="wordmark__brand">ARADA</span>
        <span class="wordmark__rule" aria-hidden="true"></span>
        <span class="wordmark__app">AGENT</span>
      </div>

      <h1 class="login-title">Sign in</h1>

      <p v-if="errorMessage" class="login-error" role="alert">
        {{ errorMessage }}
      </p>

      <form class="login-form" novalidate @submit.prevent="handleLogin">
        <div class="field">
          <label class="field-label" for="agent-username">Username</label>
          <input
            id="agent-username"
            v-model="form.username"
            type="text"
            class="field-input"
            autocomplete="username"
            autocapitalize="off"
            spellcheck="false"
            :disabled="loading"
            required
          />
        </div>

        <div class="field">
          <label class="field-label" for="agent-password">Password</label>
          <div class="password-wrap">
            <input
              id="agent-password"
              v-model="form.password"
              :type="showPassword ? 'text' : 'password'"
              class="field-input field-input--password"
              autocomplete="current-password"
              :disabled="loading"
              required
            />
            <button
              type="button"
              class="password-toggle"
              :aria-label="showPassword ? 'Hide password' : 'Show password'"
              :aria-pressed="showPassword"
              @click="showPassword = !showPassword"
            >
              <svg
                v-if="!showPassword"
                viewBox="0 0 20 20"
                fill="currentColor"
                class="toggle-icon"
                aria-hidden="true"
              >
                <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
                <path
                  fill-rule="evenodd"
                  d="M.664 10.59a1.651 1.651 0 0 1 0-1.186A10.004 10.004 0 0 1 10 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0 1 10 17c-4.257 0-7.893-2.66-9.336-6.41ZM14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
                  clip-rule="evenodd"
                />
              </svg>
              <svg
                v-else
                viewBox="0 0 20 20"
                fill="currentColor"
                class="toggle-icon"
                aria-hidden="true"
              >
                <path
                  fill-rule="evenodd"
                  d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z"
                  clip-rule="evenodd"
                />
                <path
                  d="m10.748 13.93 2.523 2.523a10.048 10.048 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z"
                />
              </svg>
            </button>
          </div>
        </div>

        <button type="submit" class="btn btn--primary btn--block submit-btn" :disabled="loading">
          <span v-if="loading" class="spinner" aria-hidden="true"></span>
          <span>{{ loading ? 'Signing in' : 'Sign in' }}</span>
        </button>
      </form>

      <p class="login-footer">
        Agent accounts are issued by the operator. If you cannot sign in, contact the operator
        rather than creating a new account.
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  background: var(--surface-base);
}

.login-card {
  width: 100%;
  max-width: 432px;
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 34px 34px 28px;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: 14px;
}

.wordmark {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-ui);
  line-height: 1;
}

.wordmark__brand {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--brand-primary);
}

.wordmark__rule {
  width: 1px;
  height: 19px;
  background: var(--surface-border);
}

.wordmark__app {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.24em;
  color: var(--text-muted);
}

.login-title {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.005em;
  margin: 0;
  line-height: 1.1;
}

.login-error {
  margin: 0;
  padding: 11px 14px;
  border-radius: 10px;
  background: var(--negative-bg);
  border: 1px solid var(--negative-border);
  color: #fca5a5;
  font-size: 13px;
  line-height: 1.45;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
}

.password-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.field-input--password {
  padding-right: 44px;
}

.password-toggle {
  position: absolute;
  right: 6px;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    color 0.12s ease,
    background 0.12s ease;
}
.password-toggle:hover {
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
}
.password-toggle:focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: 2px;
}

.toggle-icon {
  width: 16px;
  height: 16px;
}

.submit-btn {
  height: 46px;
  margin-top: 2px;
}

.login-footer {
  margin: 0;
  padding-top: 18px;
  border-top: 1px solid var(--surface-line);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}
</style>
