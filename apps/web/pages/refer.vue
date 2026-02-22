<script setup lang="ts">
/**
 * T57 — Refer & Earn page
 *
 * Displays the player's personal referral code, referral link,
 * and their referral stats (total referrals, earnings).
 */

const config = useRuntimeConfig()
const auth = useAuth()

interface ReferralStats {
  referralCode: string
  referralLink: string
  totalReferrals: number
  pendingRewards: number
  paidRewards: number
  totalEarned: number
}

const stats = ref<ReferralStats | null>(null)
const loading = ref(true)
const error = ref('')
const copied = ref(false)

const fetchStats = async () => {
  loading.value = true
  error.value = ''
  try {
    stats.value = await $fetch<ReferralStats>(`${config.public.apiBase}/referral/stats`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    })
  } catch (e: any) {
    error.value = e?.data?.message || 'Failed to load referral stats'
  } finally {
    loading.value = false
  }
}

const copyLink = async () => {
  if (!stats.value) return
  try {
    await navigator.clipboard.writeText(stats.value.referralLink)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // fallback: select the input text
  }
}

const shareViaWhatsApp = () => {
  if (!stats.value) return
  const text = encodeURIComponent(
    `Join me on World Bingo and win big! 🎉\nUse my referral link: ${stats.value.referralLink}`,
  )
  window.open(`https://wa.me/?text=${text}`, '_blank')
}

onMounted(fetchStats)
</script>

<template>
  <div class="refer-page">
    <div class="refer-header">
      <h1>🎁 Refer &amp; Earn</h1>
      <p class="subtitle">Invite friends to World Bingo and earn <strong>50 ETB</strong> for each friend who completes their first deposit!</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="loading">Loading your referral details…</div>

    <!-- Error -->
    <div v-else-if="error" class="error-box">{{ error }}</div>

    <!-- Stats -->
    <template v-else-if="stats">
      <!-- Referral Code Card -->
      <div class="code-card">
        <div class="code-label">Your Referral Code</div>
        <div class="code-value">{{ stats.referralCode }}</div>

        <div class="link-row">
          <input
            :value="stats.referralLink"
            readonly
            class="link-input"
            aria-label="Referral link"
          />
          <button class="btn-copy" @click="copyLink">
            {{ copied ? '✅ Copied!' : '📋 Copy' }}
          </button>
        </div>

        <button class="btn-whatsapp" @click="shareViaWhatsApp">
          📲 Share via WhatsApp
        </button>
      </div>

      <!-- How it works -->
      <div class="how-it-works">
        <h2>How It Works</h2>
        <ol>
          <li>Share your referral link or code with friends</li>
          <li>Your friend registers using your link/code</li>
          <li>Once they complete their first deposit, you earn <strong>50 ETB</strong> automatically</li>
          <li>Your bonus is credited instantly to your wallet</li>
        </ol>
      </div>

      <!-- Stats grid -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">{{ stats.totalReferrals }}</div>
          <div class="stat-label">Total Referrals</div>
        </div>
        <div class="stat-card green">
          <div class="stat-value">{{ stats.paidRewards.toFixed(2) }} ETB</div>
          <div class="stat-label">Total Earned</div>
        </div>
        <div class="stat-card yellow">
          <div class="stat-value">{{ stats.pendingRewards.toFixed(2) }} ETB</div>
          <div class="stat-label">Pending</div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.refer-page {
  max-width: 600px;
  margin: 0 auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.refer-header h1 {
  font-size: 1.75rem;
  font-weight: 700;
  margin-bottom: 0.5rem;
}

.subtitle {
  color: #6b7280;
  font-size: 0.95rem;
}

.loading { color: #6b7280; text-align: center; padding: 2rem; }

.error-box {
  background: #fef2f2;
  color: #dc2626;
  padding: 1rem;
  border-radius: 8px;
}

/* Code card */
.code-card {
  background: linear-gradient(135deg, #1d4ed8, #7c3aed);
  color: white;
  border-radius: 16px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.code-label {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  opacity: 0.8;
}

.code-value {
  font-size: 2rem;
  font-weight: 800;
  font-family: monospace;
  letter-spacing: 0.15em;
}

.link-row {
  display: flex;
  gap: 0.5rem;
}

.link-input {
  flex: 1;
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  color: white;
  font-size: 0.8rem;
  font-family: monospace;
  outline: none;
}

.btn-copy {
  background: white;
  color: #1d4ed8;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-size: 0.85rem;
  white-space: nowrap;
}

.btn-whatsapp {
  background: #25d366;
  color: white;
  border: none;
  border-radius: 10px;
  padding: 0.7rem 1.25rem;
  cursor: pointer;
  font-weight: 600;
  font-size: 0.9rem;
  align-self: flex-start;
}

/* How it works */
.how-it-works {
  background: #f9fafb;
  border-radius: 12px;
  padding: 1.25rem;
}

.how-it-works h2 {
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 0.75rem;
}

.how-it-works ol {
  padding-left: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.9rem;
  color: #374151;
}

/* Stats grid */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}

.stat-card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 1rem;
  text-align: center;
}

.stat-card.green .stat-value { color: #16a34a; }
.stat-card.yellow .stat-value { color: #d97706; }

.stat-value {
  font-size: 1.4rem;
  font-weight: 700;
  color: #111827;
}

.stat-label {
  font-size: 0.75rem;
  color: #6b7280;
  margin-top: 0.25rem;
}
</style>
