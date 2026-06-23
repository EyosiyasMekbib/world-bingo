<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

const auth = useAuthStore()
const router = useRouter()
const { connect } = useSocket()
const { locale, setLocale } = useI18n()
const { referralsEnabled, tournamentsEnabled } = useFeatureFlags()

const showDeposit = ref(false)
const showWithdrawal = ref(false)

// Initialize socket and fetch wallet if authenticated
onMounted(async () => {
  if (auth.isAuthenticated) {
    await auth.fetchWallet()
    connect()
  }
})

watch(() => auth.isAuthenticated, (val) => {
  if (val) connect()
})

async function handleLogout() {
  await (auth as any).logout()
  await router.push('/auth/login')
}

// Format balance with ETB
const formattedBalance = computed(() => {
  const total = Number(auth.wallet?.realBalance ?? 0) + Number(auth.wallet?.bonusBalance ?? 0)
  return total.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
})

// Player id shown beneath the balance (design: "ID: 940588")
const playerId = computed(() => auth.user?.serial ?? '—')

// Mobile nav drawer + locale
const mobileNavOpen = ref(false)
const toggleLocale = () => setLocale(locale.value === 'en' ? 'am' : 'en')

// Header search → search page
const search = ref('')
function submitSearch() {
  const q = search.value.trim()
  if (q) navigateTo(`/search?q=${encodeURIComponent(q)}`)
}
</script>

<template>
  <div class="ab-shell">
    <!-- ═══════════════ DESKTOP HEADER ═══════════════ -->
    <header class="ab-desktop ab-header">
      <!-- Utility bar -->
      <div class="ab-util">
        <NuxtLink to="/" class="ab-logo">
          <span class="ab-logo-1">ARADA</span><span class="ab-logo-2">BINGO</span>
        </NuxtLink>

        <div class="ab-search">
          <input
            v-model="search"
            placeholder="Search Games"
            @keyup.enter="submitSearch"
          />
          <button class="ab-search-ico" aria-label="Search" @click="submitSearch">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7" stroke-linecap="round" stroke-linejoin="round" />
              <path d="m20 20-3.2-3.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>

        <div class="ab-spacer" />

        <div class="ab-balance">
          <div class="ab-balance-amt">{{ formattedBalance }} <span>ETB</span></div>
          <div class="ab-balance-id">ID: {{ playerId }}</div>
        </div>

        <template v-if="auth.isAuthenticated">
          <button class="ab-btn-primary" @click="showDeposit = true">Deposit</button>
          <button class="ab-icon-btn" title="Withdraw" @click="showWithdrawal = true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m-7 7l7-7 7 7" /></svg>
          </button>
          <div class="ab-account">
            <button class="ab-icon-btn ab-account-trigger" title="Account">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="8" r="4" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M4 20c0-4 3.6-7 8-7s8 3 8 7" /></svg>
            </button>
            <div class="ab-menu">
              <NuxtLink to="/profile" class="ab-menu-item">Profile</NuxtLink>
              <NuxtLink to="/transactions" class="ab-menu-item">History</NuxtLink>
              <NuxtLink to="/wallet" class="ab-menu-item">Wallet</NuxtLink>
              <hr />
              <button class="ab-menu-item ab-menu-danger" @click="handleLogout">Logout</button>
            </div>
          </div>
        </template>
        <template v-else>
          <NuxtLink to="/auth/login" class="ab-btn-primary">Login</NuxtLink>
          <NuxtLink to="/auth/register" class="ab-btn-ghost">Register</NuxtLink>
        </template>

        <button class="ab-lang" @click="toggleLocale">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></svg>
          {{ locale === 'en' ? 'EN' : 'አማ' }}
          <span class="ab-caret">▾</span>
        </button>
      </div>

      <!-- Primary nav -->
      <nav class="ab-nav">
        <NuxtLink to="/" class="ab-nav-link" exact-active-class="ab-nav-active">Home</NuxtLink>
        <NuxtLink to="/games" class="ab-nav-link" active-class="ab-nav-active">Games</NuxtLink>
        <NuxtLink
          v-if="tournamentsEnabled"
          to="/tournaments"
          class="ab-nav-link"
          active-class="ab-nav-active"
        >
          Tournaments<span class="ab-new">NEW</span>
        </NuxtLink>
        <NuxtLink
          v-if="auth.isAuthenticated"
          to="/transactions"
          class="ab-nav-link"
          active-class="ab-nav-active"
        >
          History
        </NuxtLink>
        <NuxtLink
          v-if="referralsEnabled && auth.isAuthenticated"
          to="/refer"
          class="ab-nav-link"
          active-class="ab-nav-active"
        >
          Promotions
        </NuxtLink>
      </nav>
    </header>

    <!-- ═══════════════ MOBILE HEADER ═══════════════ -->
    <header class="ab-mobile ab-header">
      <div class="ab-mtop">
        <button class="ab-micon" aria-label="Menu" @click="mobileNavOpen = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <NuxtLink to="/" class="ab-logo ab-logo-sm">
          <span class="ab-logo-1">ARADA</span><span class="ab-logo-2">BINGO</span>
        </NuxtLink>
        <NuxtLink to="/search" class="ab-micon" aria-label="Search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" stroke-linecap="round" stroke-linejoin="round" /><path d="m20 20-3.2-3.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </NuxtLink>
        <div class="ab-spacer" />
        <div class="ab-balance ab-balance-sm">
          <div class="ab-balance-amt">{{ formattedBalance }} <span>ETB</span></div>
          <div class="ab-balance-id">ID: {{ playerId }}</div>
        </div>
        <button
          v-if="auth.isAuthenticated"
          class="ab-btn-primary ab-btn-sm"
          @click="showDeposit = true"
        >
          Deposit
        </button>
        <NuxtLink v-else to="/auth/login" class="ab-btn-primary ab-btn-sm">Login</NuxtLink>
      </div>

      <div class="ab-mnav noscroll">
        <NuxtLink to="/" class="ab-mtab" exact-active-class="ab-mtab-active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>
          <span>Home</span>
        </NuxtLink>
        <NuxtLink to="/games" class="ab-mtab" active-class="ab-mtab-active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
          <span>Games</span>
        </NuxtLink>
        <NuxtLink v-if="tournamentsEnabled" to="/tournaments" class="ab-mtab" active-class="ab-mtab-active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 010-5H6M18 9h1.5a2.5 2.5 0 000-5H18M4 22h16M18 2H6v7a6 6 0 0012 0V2z" /></svg>
          <span>Tournaments</span>
        </NuxtLink>
        <NuxtLink v-if="auth.isAuthenticated" to="/wallet" class="ab-mtab" active-class="ab-mtab-active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M16 6V5a2 2 0 00-2-2H8" /><circle cx="16.5" cy="12.5" r="1.3" fill="currentColor" stroke="none" /></svg>
          <span>Wallet</span>
        </NuxtLink>
        <NuxtLink v-if="referralsEnabled && auth.isAuthenticated" to="/refer" class="ab-mtab" active-class="ab-mtab-active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 13.5 13 21l-9-9V4h8l8.5 8.5z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>
          <span>Promotions</span>
        </NuxtLink>
      </div>
    </header>

    <!-- Mobile slide-in drawer -->
    <Transition
      enter-active-class="ab-drawer-enter"
      leave-active-class="ab-drawer-leave"
    >
      <div v-if="mobileNavOpen" class="ab-drawer-wrap">
        <div class="ab-drawer-scrim" @click="mobileNavOpen = false" />
        <aside class="ab-drawer">
          <div class="ab-drawer-head">
            <span class="ab-logo ab-logo-sm">
              <span class="ab-logo-1">ARADA</span><span class="ab-logo-2">BINGO</span>
            </span>
            <button class="ab-micon" @click="mobileNavOpen = false" aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <div class="ab-drawer-body">
            <template v-if="auth.isAuthenticated">
              <div class="ab-drawer-balance">
                <span>Balance</span>
                <strong>{{ formattedBalance }} ETB</strong>
              </div>
              <button class="ab-drawer-item" @click="showDeposit = true; mobileNavOpen = false">Deposit</button>
              <button class="ab-drawer-item" @click="showWithdrawal = true; mobileNavOpen = false">Withdraw</button>
              <NuxtLink to="/profile" class="ab-drawer-item" @click="mobileNavOpen = false">Profile</NuxtLink>
              <NuxtLink to="/transactions" class="ab-drawer-item" @click="mobileNavOpen = false">History</NuxtLink>
              <NuxtLink v-if="referralsEnabled" to="/refer" class="ab-drawer-item" @click="mobileNavOpen = false">Refer &amp; Earn</NuxtLink>
              <button class="ab-drawer-item" @click="toggleLocale(); mobileNavOpen = false">
                {{ locale === 'en' ? 'Switch to Amharic (አማ)' : 'Switch to English (EN)' }}
              </button>
              <button class="ab-drawer-item ab-drawer-danger" @click="handleLogout">Logout</button>
            </template>
            <template v-else>
              <NuxtLink to="/auth/login" class="ab-btn-primary ab-drawer-cta" @click="mobileNavOpen = false">Login</NuxtLink>
              <NuxtLink to="/auth/register" class="ab-btn-ghost ab-drawer-cta" @click="mobileNavOpen = false">Create Account</NuxtLink>
              <button class="ab-drawer-item" @click="toggleLocale(); mobileNavOpen = false">
                {{ locale === 'en' ? 'Switch to Amharic (አማ)' : 'Switch to English (EN)' }}
              </button>
            </template>
          </div>
        </aside>
      </div>
    </Transition>

    <!-- ═══════════════ PAGE CONTENT ═══════════════ -->
    <main class="ab-main">
      <Transition name="page-fade" mode="out-in">
        <slot />
      </Transition>
    </main>

    <!-- ═══════════════ FOOTER ═══════════════ -->
    <footer class="ab-footer">
      <div class="ab-footer-inner">
        <div class="ab-footer-top">
          <div class="ab-footer-brand">
            <span class="ab-logo">
              <span class="ab-logo-1">ARADA</span><span class="ab-logo-2">BINGO</span>
            </span>
            <p>Ethiopia's premium online bingo and gaming destination. Play responsibly and enjoy the thrill.</p>
          </div>
          <div class="ab-footer-cols">
            <div class="ab-footer-col">
              <h4>Games</h4>
              <NuxtLink to="/games">Bingo</NuxtLink>
              <NuxtLink to="/games">Slots</NuxtLink>
              <NuxtLink to="/games">Fish Games</NuxtLink>
              <NuxtLink to="/games">Arcade</NuxtLink>
            </div>
            <div class="ab-footer-col">
              <h4>Account</h4>
              <NuxtLink to="/wallet">Deposit</NuxtLink>
              <NuxtLink to="/wallet">Withdraw</NuxtLink>
              <NuxtLink to="/profile">My Profile</NuxtLink>
              <NuxtLink to="/transactions">History</NuxtLink>
            </div>
            <div class="ab-footer-col">
              <h4>Support</h4>
              <a href="#">Help Center</a>
              <a href="#">Contact Us</a>
              <a href="#">Terms</a>
              <a href="#">Privacy Policy</a>
            </div>
          </div>
        </div>
        <div class="ab-footer-bottom">
          <p>Responsible Gaming: AradaBingo is intended for users 18 years and older. Gambling can be addictive — play within your limits. If you or someone you know has a gambling problem, please seek help. © 2026 AradaBingo. All rights reserved.</p>
          <span class="ab-18">18+</span>
        </div>
      </div>
    </footer>

    <!-- ═══════════════ MODALS ═══════════════ -->
    <DepositModal v-model="showDeposit" @deposited="auth.fetchWallet(); showDeposit = false" />
    <WithdrawalModal
      v-model="showWithdrawal"
      :balance="Number(auth.wallet?.realBalance ?? 0)"
      @withdrawn="auth.fetchWallet(); showWithdrawal = false"
    />
  </div>
</template>

<style scoped>
.ab-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--surface-base);
  color: var(--text-primary);
}

.noscroll::-webkit-scrollbar { display: none; }
.noscroll { -ms-overflow-style: none; scrollbar-width: none; }

/* breakpoint matches the design's 860px swap */
.ab-mobile { display: none; }
@media (max-width: 860px) {
  .ab-desktop { display: none !important; }
  .ab-mobile { display: flex !important; }
}

/* ── Header shell ── */
.ab-header {
  flex-direction: column;
  background: var(--surface-raised);
  position: sticky;
  top: 0;
  z-index: 50;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.ab-desktop { display: flex; }

/* ── Logo ── */
.ab-logo {
  display: flex;
  align-items: baseline;
  gap: 5px;
  text-decoration: none;
  flex: none;
}
.ab-logo-1,
.ab-logo-2 {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 28px;
  letter-spacing: 1px;
  line-height: 1;
}
.ab-logo-1 { color: var(--text-primary); }
.ab-logo-2 { color: var(--brand-primary); }
.ab-logo-sm .ab-logo-1,
.ab-logo-sm .ab-logo-2 { font-size: 18px; letter-spacing: 0.5px; }

/* ── Utility bar ── */
.ab-util {
  max-width: 1480px;
  width: 100%;
  margin: 0 auto;
  padding: 0 28px;
  height: 64px;
  display: flex;
  align-items: center;
  gap: 22px;
}
.ab-spacer { flex: 1; }

.ab-search {
  flex: 1;
  max-width: 360px;
  position: relative;
  display: flex;
}
.ab-search input {
  width: 100%;
  height: 38px;
  background: var(--surface-base);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 14px;
  padding: 0 38px 0 14px;
  outline: none;
}
.ab-search input:focus { border-color: var(--brand-primary); }
.ab-search-ico {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ab-search-ico svg { width: 17px; height: 17px; }

.ab-balance {
  text-align: right;
  flex: none;
  line-height: 1.2;
}
.ab-balance-amt {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 16px;
  color: var(--brand-primary);
}
.ab-balance-amt span { font-size: 11px; }
.ab-balance-id {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}

/* ── Buttons ── */
.ab-btn-primary {
  background: var(--brand-primary);
  color: var(--text-on-brand);
  border: none;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  padding: 11px 26px;
  border-radius: 8px;
  cursor: pointer;
  flex: none;
  text-decoration: none;
  transition: box-shadow 0.12s, transform 0.12s, background 0.12s;
}
.ab-btn-primary:hover {
  background: color-mix(in srgb, var(--brand-primary) 90%, white);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--brand-primary) 35%, transparent);
  transform: translateY(-1px);
}
.ab-btn-ghost {
  background: transparent;
  color: var(--text-primary);
  border: 1px solid rgba(255, 255, 255, 0.2);
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  padding: 10px 22px;
  border-radius: 8px;
  cursor: pointer;
  flex: none;
  text-decoration: none;
  transition: background 0.12s;
}
.ab-btn-ghost:hover { background: rgba(255, 255, 255, 0.06); }

.ab-icon-btn {
  width: 40px;
  height: 40px;
  flex: none;
  background: var(--surface-base);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.12s, color 0.12s;
}
.ab-icon-btn:hover { border-color: var(--brand-primary); color: var(--text-primary); }
.ab-icon-btn svg { width: 18px; height: 18px; }

.ab-lang {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.ab-lang svg { width: 16px; height: 16px; }
.ab-caret { font-size: 10px; opacity: 0.7; }

/* ── Account dropdown ── */
.ab-account { position: relative; flex: none; }
.ab-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  width: 168px;
  background: var(--surface-raised);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  box-shadow: var(--shadow-modal);
  padding: 6px;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px);
  transition: all 0.15s;
  z-index: 60;
}
.ab-account:hover .ab-menu { opacity: 1; visibility: visible; transform: translateY(0); }
.ab-menu hr { border: none; border-top: 1px solid rgba(255, 255, 255, 0.08); margin: 6px 4px; }
.ab-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.75);
  background: none;
  border: none;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.12s, color 0.12s;
}
.ab-menu-item:hover { background: rgba(255, 255, 255, 0.06); color: var(--text-primary); }
.ab-menu-danger { color: var(--status-error); }
.ab-menu-danger:hover { background: color-mix(in srgb, var(--status-error) 12%, transparent); color: var(--status-error); }

/* ── Primary nav ── */
.ab-nav {
  max-width: 1480px;
  width: 100%;
  margin: 0 auto;
  padding: 0 28px;
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}
.ab-nav-link {
  position: relative;
  text-decoration: none;
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 17px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  padding: 14px 18px;
  border-bottom: 3px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.ab-nav-link:hover { color: var(--brand-primary); }
.ab-nav-active { color: var(--brand-primary); border-bottom-color: var(--brand-primary); }
.ab-new {
  position: absolute;
  top: 4px;
  right: 0;
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 1px 4px;
  border-radius: 3px;
}

/* ── Mobile header ── */
.ab-mtop {
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.ab-micon {
  background: transparent;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  flex: none;
  display: flex;
  align-items: center;
  text-decoration: none;
}
.ab-micon svg { width: 22px; height: 22px; }
.ab-btn-sm { font-size: 13px; padding: 9px 14px; letter-spacing: 0.4px; }
.ab-balance-sm .ab-balance-amt { font-size: 14px; }
.ab-balance-sm .ab-balance-id { font-size: 10px; }

.ab-mnav {
  display: flex;
  overflow-x: auto;
  background: color-mix(in srgb, var(--surface-raised) 80%, var(--surface-base));
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}
.ab-mtab {
  flex: none;
  min-width: 84px;
  padding: 10px 14px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  text-decoration: none;
  color: rgba(255, 255, 255, 0.85);
  border-bottom: 3px solid transparent;
}
.ab-mtab svg { width: 22px; height: 22px; }
.ab-mtab span {
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  white-space: nowrap;
}
.ab-mtab-active { color: var(--brand-primary); border-bottom-color: var(--brand-primary); }

/* ── Mobile drawer ── */
.ab-drawer-wrap { position: fixed; inset: 0; z-index: 80; }
.ab-drawer-scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); }
.ab-drawer {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 82%;
  max-width: 320px;
  background: var(--surface-raised);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-modal);
}
.ab-drawer-head {
  height: 60px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.ab-drawer-body { padding: 14px; display: flex; flex-direction: column; gap: 4px; }
.ab-drawer-balance {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--surface-base);
  margin-bottom: 8px;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.6);
}
.ab-drawer-balance strong { color: var(--brand-primary); font-size: 16px; }
.ab-drawer-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 13px 16px;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
  background: none;
  border: none;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.12s;
}
.ab-drawer-item:hover { background: rgba(255, 255, 255, 0.05); }
.ab-drawer-danger { color: var(--status-error); margin-top: 6px; }
.ab-drawer-cta { text-align: center; margin-bottom: 6px; }

.ab-drawer-enter { animation: ab-fade 0.15s ease; }
.ab-drawer-enter .ab-drawer { animation: ab-slide 0.2s var(--wb-ease-out); }
.ab-drawer-leave { animation: ab-fade 0.12s ease reverse; }
@keyframes ab-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ab-slide { from { transform: translateX(-100%); } to { transform: translateX(0); } }

/* ── Main ── */
.ab-main { flex: 1; }

/* ── Footer ── */
.ab-footer {
  background: var(--surface-raised);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.ab-footer-inner {
  max-width: 1480px;
  margin: 0 auto;
  padding: 44px 28px 30px;
}
.ab-footer-top {
  display: flex;
  flex-wrap: wrap;
  gap: 40px;
  justify-content: space-between;
  align-items: flex-start;
}
.ab-footer-brand { max-width: 300px; }
.ab-footer-brand .ab-logo { margin-bottom: 14px; }
.ab-footer-brand p {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.55);
  line-height: 1.6;
}
.ab-footer-cols { display: flex; gap: 56px; flex-wrap: wrap; }
.ab-footer-col { display: flex; flex-direction: column; gap: 10px; }
.ab-footer-col h4 {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--brand-primary);
  margin-bottom: 4px;
}
.ab-footer-col a {
  text-decoration: none;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.7);
  transition: color 0.15s;
}
.ab-footer-col a:hover { color: var(--brand-primary); }
.ab-footer-bottom {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  margin-top: 34px;
  padding-top: 22px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
}
.ab-footer-bottom p {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  line-height: 1.6;
  max-width: 760px;
}
.ab-18 {
  border: 1.5px solid rgba(255, 255, 255, 0.3);
  color: rgba(255, 255, 255, 0.6);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 14px;
  padding: 4px 10px;
  border-radius: 6px;
  flex: none;
}

/* ── Page transition ── */
.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.page-fade-enter-from { opacity: 0; transform: translateY(6px); }
.page-fade-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
