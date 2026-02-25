<script setup lang="ts">
/**
 * T57 — Refer & Earn page
 *
 * Displays the player's personal referral code, referral link,
 * and their referral stats (total referrals, earnings).
 * Only accessible when the admin has enabled the referrals feature.
 */

const { referralsEnabled } = useFeatureFlags()

// Redirect to home if referrals feature is disabled
watch(referralsEnabled, (enabled) => {
  if (!enabled) navigateTo('/')
}, { immediate: true })

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

    <!-- Header -->
    <div class="refer-header">
      <h1 class="refer-title">🎁 Refer &amp; Earn</h1>
      <p class="refer-subtitle">
        Invite friends to World Bingo and earn
        <strong class="highlight">50 ETB</strong>
        for each friend who completes their first deposit!
      </p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="state-message">
      <span class="spinner-lg" />
      Loading your referral details…
    </div>

    <!-- Error -->
    <div v-else-if="error" class="error-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
      {{ error }}
    </div>

    <template v-else-if="stats">

      <!-- ── Stats Grid ─────────────────────────────────────────────── -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">👥</div>
          <div class="stat-value">{{ stats.totalReferrals }}</div>
          <div class="stat-label">Total Referrals</div>
        </div>
        <div class="stat-card stat-card--green">
          <div class="stat-icon">💰</div>
          <div class="stat-value">{{ stats.paidRewards.toFixed(2) }}</div>
          <div class="stat-sub">ETB</div>
          <div class="stat-label">Total Earned</div>
        </div>
        <div class="stat-card stat-card--amber">
          <div class="stat-icon">⏳</div>
          <div class="stat-value">{{ stats.pendingRewards.toFixed(2) }}</div>
          <div class="stat-sub">ETB</div>
          <div class="stat-label">Pending</div>
        </div>
      </div>

      <!-- ── Referral Code Card ─────────────────────────────────────── -->
      <div class="code-card">
        <div class="code-card-top">
          <div>
            <div class="code-label">Your Referral Code</div>
            <div class="code-value">{{ stats.referralCode }}</div>
          </div>
          <Transition name="copied-pop">
            <span v-if="copied" class="copied-badge">✅ Copied!</span>
          </Transition>
        </div>

        <!-- Link + copy — aligned on same row -->
        <div class="link-row">
          <input
            :value="stats.referralLink"
            readonly
            class="link-input"
            aria-label="Referral link"
          />
          <button class="btn-copy" @click="copyLink">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
            Copy
          </button>
        </div>

        <!-- Share actions row -->
        <div class="share-row">
          <button class="btn-whatsapp" @click="shareViaWhatsApp">
            <svg viewBox="0 0 24 24" fill="currentColor" class="whatsapp-icon"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a13 13 0 00-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M11.95 2C6.465 2 2 6.465 2 11.95c0 1.837.494 3.562 1.357 5.047L2 22l5.123-1.335A9.886 9.886 0 0011.95 22C17.435 22 22 17.535 22 12.05 22 6.565 17.435 2 11.95 2zm0 18.198a8.166 8.166 0 01-4.207-1.162l-.3-.18-3.12.813.829-3.042-.197-.317a8.198 8.198 0 118.995 3.888z"/></svg>
            Share via WhatsApp
          </button>
        </div>
      </div>

      <!-- ── How it works ───────────────────────────────────────────── -->
      <div class="how-card">
        <h2 class="how-title">How It Works</h2>
        <ol class="how-list">
          <li><span class="how-num">1</span><span>Share your referral link or code with friends</span></li>
          <li><span class="how-num">2</span><span>Your friend registers using your link or code</span></li>
          <li><span class="how-num">3</span><span>Once they complete their first deposit, you earn <strong>50 ETB</strong> automatically</span></li>
          <li><span class="how-num">4</span><span>Your bonus is credited instantly to your wallet</span></li>
        </ol>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ── Page ────────────────────────────────────────────────────────────── */
.refer-page {
  max-width: 640px;
  margin: 0 auto;
  padding: 1.75rem 1.5rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* ── Header ──────────────────────────────────────────────────────────── */
.refer-header { display: flex; flex-direction: column; gap: 0.4rem; }
.refer-title {
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  margin: 0;
  letter-spacing: -0.02em;
}
.refer-subtitle {
  font-size: 0.9rem;
  color: var(--text-secondary, #94a3b8);
  margin: 0;
  line-height: 1.55;
}
.highlight { color: var(--brand-primary, #f59e0b); }

/* ── Loading / error ─────────────────────────────────────────────────── */
.state-message {
  display: flex; align-items: center; gap: 0.75rem;
  color: var(--text-secondary, #94a3b8);
  padding: 3rem 0; justify-content: center; font-size: 0.95rem;
}
.spinner-lg {
  width: 18px; height: 18px;
  border: 2px solid rgba(255,255,255,0.1);
  border-top-color: var(--brand-primary, #f59e0b);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

.error-box {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.875rem;
  color: #f87171;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 10px;
  padding: 0.75rem 1rem;
}
.error-box svg { width: 16px; height: 16px; flex-shrink: 0; }

/* ── Stats grid ──────────────────────────────────────────────────────── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}
.stat-card {
  background: rgba(17, 24, 39, 0.7);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 1.1rem;
  text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 0.2rem;
  transition: border-color 0.2s, transform 0.2s;
}
.stat-card:hover { border-color: rgba(255,255,255,0.15); transform: translateY(-2px); }
.stat-card--green { border-color: rgba(52, 211, 153, 0.2); }
.stat-card--amber { border-color: rgba(245, 158, 11, 0.2); }
.stat-icon { font-size: 1.3rem; line-height: 1; margin-bottom: 0.1rem; }
.stat-value {
  font-size: 1.35rem;
  font-weight: 800;
  color: var(--text-primary, #f1f5f9);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.stat-sub { font-size: 0.72rem; font-weight: 600; color: var(--text-disabled, #475569); }
.stat-card--green .stat-value { color: #34d399; }
.stat-card--amber .stat-value { color: #fbbf24; }
.stat-label { font-size: 0.75rem; color: var(--text-secondary, #94a3b8); margin-top: 0.15rem; }

/* ── Code card ───────────────────────────────────────────────────────── */
.code-card {
  background: linear-gradient(135deg, rgba(29,78,216,0.85) 0%, rgba(124,58,237,0.85) 100%);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(167, 139, 250, 0.25);
  border-radius: 16px;
  padding: 1.5rem;
  display: flex; flex-direction: column; gap: 1rem;
  box-shadow: 0 8px 32px rgba(124, 58, 237, 0.2);
}
.code-card-top {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem;
}
.code-label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 700;
  color: rgba(255,255,255,0.6);
}
.code-value {
  font-size: 2rem;
  font-weight: 800;
  color: #fff;
  letter-spacing: 0.15em;
  font-family: var(--font-game, 'Rajdhani', monospace);
  line-height: 1.1;
}
.copied-badge {
  font-size: 0.8rem;
  font-weight: 700;
  color: #34d399;
  background: rgba(52, 211, 153, 0.12);
  border: 1px solid rgba(52, 211, 153, 0.3);
  border-radius: 20px;
  padding: 0.25rem 0.65rem;
  white-space: nowrap;
  flex-shrink: 0;
}
.copied-pop-enter-active { transition: all 0.25s var(--ease-bounce, cubic-bezier(0.34,1.56,0.64,1)); }
.copied-pop-enter-from { opacity: 0; transform: scale(0.8); }
.copied-pop-leave-active { transition: opacity 0.15s; }
.copied-pop-leave-to { opacity: 0; }

/* Link row — input + button perfectly aligned */
.link-row {
  display: flex;
  align-items: stretch;
  gap: 0;
  background: rgba(255,255,255,0.1);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 10px;
  overflow: hidden;
}
.link-input {
  flex: 1;
  background: transparent;
  border: none;
  padding: 0.6rem 0.85rem;
  color: rgba(255,255,255,0.85);
  font-size: 0.8rem;
  font-family: var(--font-game, 'Rajdhani', monospace);
  letter-spacing: 0.02em;
  outline: none;
  min-width: 0;
}
.btn-copy {
  display: flex; align-items: center; gap: 0.35rem;
  background: rgba(255,255,255,0.18);
  border: none;
  border-left: 1px solid rgba(255,255,255,0.15);
  padding: 0 1rem;
  color: #fff;
  font-weight: 600;
  font-size: 0.85rem;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.2s;
}
.btn-copy:hover { background: rgba(255,255,255,0.28); }
.btn-copy svg { width: 14px; height: 14px; }

/* Share row */
.share-row { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.btn-whatsapp {
  display: inline-flex; align-items: center; gap: 0.5rem;
  background: #25d366;
  color: white;
  border: none;
  border-radius: 10px;
  padding: 0.65rem 1.25rem;
  cursor: pointer;
  font-weight: 700;
  font-size: 0.88rem;
  font-family: inherit;
  transition: background 0.2s, transform 0.15s;
}
.btn-whatsapp:hover { background: #1da851; transform: translateY(-1px); }
.whatsapp-icon { width: 16px; height: 16px; flex-shrink: 0; }

/* ── How it works ────────────────────────────────────────────────────── */
.how-card {
  background: rgba(17, 24, 39, 0.6);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 14px;
  padding: 1.25rem 1.5rem;
}
.how-title {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  margin: 0 0 0.875rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.how-list {
  list-style: none;
  padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 0.65rem;
}
.how-list li {
  display: flex; align-items: flex-start; gap: 0.65rem;
  font-size: 0.875rem;
  color: var(--text-secondary, #94a3b8);
  line-height: 1.5;
}
.how-num {
  flex-shrink: 0;
  width: 20px; height: 20px;
  border-radius: 50%;
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: var(--brand-primary, #f59e0b);
  font-size: 0.72rem;
  font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.how-list strong { color: var(--text-primary, #f1f5f9); }

/* ── Responsive ──────────────────────────────────────────────────────── */
@media (max-width: 480px) {
  .stats-grid { grid-template-columns: repeat(3, 1fr); gap: 0.6rem; }
  .stat-value { font-size: 1.1rem; }
}
</style>
