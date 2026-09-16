<template>
  <div class="auth-card">
    <!-- Logo + Header -->
    <div class="auth-hero">
      <NuxtLink to="/">
        <BrandLogo :height="56" />
      </NuxtLink>
      <p class="auth-subtitle">Create your account</p>
    </div>

    <div class="auth-actions">
      <!-- The same form as /auth/login: a number we have never seen gets an
           account. This page exists for the referral code, which only counts
           on the sign-in that creates one — /ref/<code> lands here. -->
      <PhoneSignIn :referral-code="referralCode || undefined" @authenticated="router.push('/')">
        <template #extra-fields>
          <div v-if="showReferral" class="wb-field">
            <label class="wb-label" for="referralCode">Referral code (optional)</label>
            <input
              id="referralCode"
              v-model="referralCode"
              type="text"
              placeholder="6–12 characters"
              class="wb-input"
              minlength="6"
              maxlength="12"
            />
          </div>
          <button v-else type="button" class="referral-toggle" @click="showReferral = true">
            Have a referral code?
          </button>
        </template>
      </PhoneSignIn>

      <p class="auth-footer-link">
        Already have an account?
        <NuxtLink to="/auth/login">Sign In</NuxtLink>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
// eslint-disable-next-line @typescript-eslint/no-explicit-any
definePageMeta({ layout: 'auth' as any })

const router = useRouter()
const route = useRoute()

const referralCode = ref(typeof route.query.ref === 'string' ? route.query.ref : '')
// Opened already when a referral link filled it in, so the player can see the
// code that brought them here rather than wondering whether it took.
const showReferral = ref(!!referralCode.value)
</script>

<style scoped>
/* ── Card ───────────────────────────────────────────────────────────── */
.auth-card {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-xl, 24px);
  padding: 2.5rem 2rem 2rem;
  box-shadow: var(--shadow-modal, 0 20px 60px rgba(0, 0, 0, 0.6));
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* ── Hero ───────────────────────────────────────────────────────────── */
.auth-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  text-align: center;
}

.auth-subtitle {
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin: 0;
}

/* ── Actions ─────────────────────────────────────────────────────────── */
.auth-actions { display: flex; flex-direction: column; gap: 1rem; }

.referral-toggle {
  align-self: center;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-decoration: underline;
}

/* ── Footer link ─────────────────────────────────────────────────────── */
.auth-footer-link {
  text-align: center;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}
.auth-footer-link a {
  color: var(--brand-primary);
  font-weight: 600;
  text-decoration: none;
}
.auth-footer-link a:hover { text-decoration: underline; }
</style>
