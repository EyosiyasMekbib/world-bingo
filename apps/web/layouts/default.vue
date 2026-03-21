<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

const auth = useAuthStore()
const router = useRouter()
const { socket, connect } = useSocket()
const { locale, setLocale, t } = useI18n()
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

// Watch for auth changes
watch(() => auth.isAuthenticated, (val) => {
  if (val) connect()
})

async function handleLogout() {
  await (auth as any).logout()
  await router.push('/auth/login')
}

// Format balance with ETB
const formattedBalance = computed(() => {
  const bal = Number(auth.wallet?.balance ?? 0)
  return bal.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
})

// Mobile nav toggle
const mobileNavOpen = ref(false)

// Language toggle helper
const toggleLocale = () => setLocale(locale.value === 'en' ? 'am' : 'en')
</script>

<template>
  <div
    class="min-h-screen flex flex-col"
    style="background: var(--surface-base); color: var(--text-primary)"
  >
    <!-- ── Top Header ────────────────────────────────────────────────────── -->
    <header
      class="sticky top-0 z-40 border-b border-white/10"
      style="
        background: rgba(0, 10, 56, 0.95);
        backdrop-filter: blur(12px);
      "
    >
      <div class="max-w-6xl mx-auto px-2 h-14 flex items-center justify-between gap-3">
        <!-- Logo -->
        <NuxtLink to="/" class="flex items-center gap-2.5 flex-shrink-0">
          <img src="/logo.png" alt="Arada Bingo" class="h-16 object-contain rounded-xl flex-shrink-0" />
        </NuxtLink>

        <nav class="hidden sm:flex items-center gap-1">
          <NuxtLink
            to="/"
            class="px-3 py-1.5 rounded-lg text-sm font-medium text-zinc-300 hover:text-white hover:bg-white/8 transition-all flex items-center gap-1.5"
            exact-active-class="!text-amber-400 !bg-amber-400/10"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            Home
          </NuxtLink>
          <NuxtLink
            v-if="tournamentsEnabled"
            to="/tournaments"
            class="px-3 py-1.5 rounded-lg text-sm font-medium text-zinc-300 hover:text-white hover:bg-white/8 transition-all flex items-center gap-1.5"
            active-class="text-amber-400 bg-amber-400/10"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 9H4.5a2.5 2.5 0 010-5H6M18 9h1.5a2.5 2.5 0 000-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0012 0V2z" />
            </svg>
            Tournaments
          </NuxtLink>
          <NuxtLink
            v-if="auth.isAuthenticated"
            to="/transactions"
            class="px-3 py-1.5 rounded-lg text-sm font-medium text-zinc-300 hover:text-white hover:bg-white/8 transition-all flex items-center gap-1.5"
            active-class="text-amber-400 bg-amber-400/10"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <circle cx="12" cy="12" r="10" stroke-linecap="round" stroke-linejoin="round" />
              <polyline points="12 6 12 12 16 14" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            History
          </NuxtLink>
        </nav>

        <!-- Right side actions -->
        <div class="flex items-center gap-2">
          <!-- Authenticated user -->
          <template v-if="auth.isAuthenticated">
            <!-- Wallet balance chip with coin + refresh -->
            <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/8 border border-white/10 text-sm">
              <svg class="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M16 3H8a2 2 0 00-2 2v2h12V5a2 2 0 00-2-2z" /><circle cx="16" cy="14" r="1.5" fill="currentColor" stroke="none" /></svg>
              <span class="text-white font-semibold">{{ formattedBalance }}</span>
              <span class="text-white/50 text-[10px] uppercase font-bold tracking-tight">ETB</span>
              <button
                class="ml-0.5 text-white/40 hover:text-white/70 transition-colors"
                title="Refresh balance"
                @click="auth.fetchWallet()"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>

            <!-- Deposit button -->
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-black text-sm font-semibold transition-all"
              @click="showDeposit = true"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Deposit
            </button>

            <!-- User avatar circle with dropdown -->
            <div class="relative group">
              <button class="w-9 h-9 rounded-full bg-amber-400 hover:bg-amber-300 flex items-center justify-center flex-shrink-0 transition-colors">
                <span class="text-black text-sm font-bold leading-none">
                  {{ (auth.user?.username ?? 'U')[0].toUpperCase() }}
                </span>
              </button>
              <!-- Dropdown -->
              <div class="absolute right-0 top-full mt-1 w-44 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 overflow-hidden">
                <NuxtLink to="/profile" class="flex items-center gap-2 px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/8 hover:text-white transition-colors">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M4 20c0-4 3.6-7 8-7s8 3 8 7" /></svg>
                  Profile
                </NuxtLink>
                <NuxtLink to="/transactions" class="flex items-center gap-2 px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/8 hover:text-white transition-colors">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-linecap="round" stroke-linejoin="round" /><polyline points="12 6 12 12 16 14" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  History
                </NuxtLink>
                <button
                  class="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-white/50 hover:bg-white/5 transition-colors"
                  @click="showWithdrawal = true"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m-7 7l7-7 7 7" /></svg>
                  Withdraw
                </button>
                <hr class="border-white/10 my-1" />
                <button
                  class="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                  @click="handleLogout"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                  Logout
                </button>
              </div>
            </div>
          </template>

          <!-- Guest -->
          <template v-else>
            <NuxtLink
              to="/auth/login"
              class="px-4 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-black text-sm font-semibold transition-colors"
            >
              Login
            </NuxtLink>
            <NuxtLink
              to="/auth/register"
              class="hidden sm:flex px-4 py-1.5 rounded-lg border border-white/20 hover:bg-white/8 text-white text-sm font-medium transition-colors"
            >
              Register
            </NuxtLink>
          </template>

          <!-- Mobile hamburger -->
          <button
            class="sm:hidden p-2 rounded-lg hover:bg-white/8 transition-colors text-zinc-300"
            @click="mobileNavOpen = !mobileNavOpen"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path v-if="!mobileNavOpen" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16m-7 6h7" />
              <path v-else stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Mobile nav drawer -->
      <Transition
        enter-active-class="transition ease-out duration-150"
        enter-from-class="opacity-0 -translate-y-2"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition ease-in duration-100"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 -translate-y-2"
      >
        <div
          v-if="mobileNavOpen"
          class="sm:hidden fixed inset-x-0 top-0 z-50 flex flex-col bg-[var(--surface-base)] shadow-2xl"
        >
          <!-- Drawer Header -->
          <div class="h-16 px-4 flex items-center justify-between border-b border-white/10" style="background: rgba(0, 10, 56, 1);">
            <div class="flex items-center gap-2.5">
              <img src="/logo.png" alt="Arada Bingo" class="w-10 h-10 object-contain rounded-xl flex-shrink-0" />
            </div>
            <div class="flex items-center gap-3">
              <div class="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 flex items-center gap-2">
                <span class="text-yellow-500 font-bold text-sm">{{ formattedBalance }}</span>
                <span class="text-white/40 text-[10px] uppercase font-bold">ETB</span>
              </div>
              <button @click="mobileNavOpen = false" class="p-2 text-white/60 hover:text-white transition-colors">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <div class="p-4 flex flex-col gap-1">
            <template v-if="auth.isAuthenticated">
              <div class="flex items-center justify-between px-4 py-3.5 rounded-xl bg-white/5 mb-3">
                <span class="text-sm text-white/60">Balance</span>
                <span class="text-base font-bold text-yellow-500">{{ formattedBalance }} ETB</span>
              </div>

              <button
                class="w-full text-left px-4 py-3.5 rounded-xl text-[15px] font-medium text-white/80 hover:bg-white/5 flex items-center gap-3 transition-colors"
                @click="showDeposit = true; mobileNavOpen = false"
              >
                <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
                Deposit
              </button>

              <button
                class="w-full text-left px-4 py-3.5 rounded-xl text-[15px] font-medium text-white/80 hover:bg-white/5 flex items-center gap-3 transition-colors"
                @click="showWithdrawal = true; mobileNavOpen = false"
              >
                <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m-7 7l7-7 7 7" /></svg>
                Withdraw
              </button>

              <button
                class="w-full text-left px-4 py-3.5 rounded-xl text-[15px] font-medium text-white/80 hover:bg-white/5 flex items-center gap-3 transition-colors"
                @click="toggleLocale(); mobileNavOpen = false"
              >
                <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M2 12h20M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20" /></svg>
                {{ locale === 'en' ? 'Switch to Amharic (አማ)' : 'Switch to English (EN)' }}
              </button>

              <NuxtLink
                to="/profile"
                class="w-full text-left px-4 py-3.5 rounded-xl text-[15px] font-medium text-white/80 hover:bg-white/5 flex items-center gap-3 transition-colors"
                @click="mobileNavOpen = false"
              >
                <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M4 20c0-4 3.6-7 8-7s8 3 8 7" /></svg>
                Profile
              </NuxtLink>

              <button
                class="w-full text-left px-4 py-3.5 rounded-xl text-[15px] font-semibold text-red-500/90 hover:bg-red-500/5 flex items-center gap-3 transition-colors mt-2"
                @click="handleLogout"
              >
                <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                Logout
              </button>
            </template>

            <template v-else>
              <NuxtLink
                to="/auth/login"
                class="w-full px-4 py-3.5 rounded-xl bg-yellow-500 text-black text-center font-bold mb-2 shadow-lg shadow-yellow-500/20"
                @click="mobileNavOpen = false"
              >
                Login
              </NuxtLink>
              <NuxtLink
                to="/auth/register"
                class="w-full px-4 py-3.5 rounded-xl border border-white/20 text-white text-center font-medium hover:bg-white/5"
                @click="mobileNavOpen = false"
              >
                Create Account
              </NuxtLink>
            </template>
          </div>
        </div>
      </Transition>
    </header>

    <!-- ── Page Content ───────────────────────────────────────────────────── -->
    <main class="flex-1">
      <Transition name="page-fade" mode="out-in">
        <slot />
      </Transition>
    </main>

    <!-- ── Modals ─────────────────────────────────────────────────────────── -->
    <DepositModal
      v-model="showDeposit"
      @deposited="auth.fetchWallet(); showDeposit = false"
    />
    <WithdrawalModal
      v-model="showWithdrawal"
      :balance="Number(auth.wallet?.balance ?? 0)"
      @withdrawn="auth.fetchWallet(); showWithdrawal = false"
    />

  </div>
</template>

<style>
/* ── Page transition ─────────────────────────────────────────────────── */
.page-fade-enter-active,
.page-fade-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.page-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.page-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
