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
        background: rgba(0, 10, 56, 0.92);
        backdrop-filter: blur(12px);
      "
    >
      <div class="max-w-6xl mx-auto px-4 h-20 flex items-center justify-between gap-4">
        <!-- Logo -->
        <NuxtLink to="/" class="h-20 flex items-center flex-shrink-0 group">
          <img src="/logo.png" alt="Arada Bingo Logo" class="h-14 w-auto object-contain" />
        </NuxtLink>

        <nav class="hidden sm:flex items-center gap-1">
          <NuxtLink
            v-if="auth.isAuthenticated && referralsEnabled"
            to="/refer"
            class="px-3 py-1.5 rounded-lg text-sm font-medium text-zinc-300 hover:text-white hover:bg-white/8 transition-all flex items-center gap-1.5"
            active-class="text-amber-400 bg-amber-400/10"
          >
            <svg
              class="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"
              />
            </svg>
            {{ t('nav.refer') }}
          </NuxtLink>
          <NuxtLink
            v-if="tournamentsEnabled"
            to="/tournaments"
            class="px-3 py-1.5 rounded-lg text-sm font-medium text-zinc-300 hover:text-white hover:bg-white/8 transition-all flex items-center gap-1.5"
            active-class="text-amber-400 bg-amber-400/10"
          >
            <svg
              class="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"
              />
            </svg>
            {{ t('nav.tournaments') }}
          </NuxtLink>
        </nav>

        <!-- Right side actions -->
        <div class="flex items-center gap-2">
          <!-- Authenticated user -->
          <template v-if="auth.isAuthenticated">
            <!-- Wallet balance chip -->
            <div
              class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/8 border border-white/10 text-sm"
            >
              <span class="text-yellow-500 font-semibold md:font-bold">{{ formattedBalance }}</span>
              <span class="text-white/50 text-[10px] uppercase font-bold tracking-tight">ETB</span>
            </div>

            <!-- Deposit button -->
            <button
              class="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-black text-sm font-semibold transition-all hover:shadow-[0_0_20px_rgba(245,158,11,0.5)] hover:-translate-y-px"
              @click="showDeposit = true"
            >
              <svg
                class="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Deposit
            </button>

            <!-- Withdraw button -->
            <button
              class="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/20 hover:bg-white/8 hover:border-white/30 text-white text-sm font-medium transition-all"
              @click="showWithdrawal = true"
            >
              <svg
                class="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m-7 7l7-7 7 7" />
              </svg>
              Withdraw
            </button>

            <!-- Notification bell -->
            <NotificationBell class="hidden md:flex" />

            <!-- Language switcher -->
            <button
              class="hidden md:block px-2 py-1 rounded-lg text-xs font-semibold border border-white/20 hover:bg-white/8 text-zinc-300 transition-colors"
              :title="locale === 'en' ? 'Switch to Amharic' : 'Switch to English'"
              @click="toggleLocale"
            >
              {{ locale === 'en' ? 'አማ' : 'EN' }}
            </button>

            <!-- User avatar / menu -->
            <div class="hidden md:block relative group">
              <button
                class="flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-white/8 transition-colors text-sm text-zinc-300"
              >
                <div class="w-7 h-7 rounded-full bg-amber-400 flex items-center justify-center">
                  <span class="text-black text-xs font-bold leading-none">
                    {{ (auth.user?.username ?? 'U')[0].toUpperCase() }}
                  </span>
                </div>
                <span class="hidden md:block max-w-[100px] truncate">{{
                  auth.user?.username
                }}</span>
              </button>

              <!-- Dropdown -->
              <div
                class="absolute right-0 top-full mt-1 w-44 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 overflow-hidden"
              >
                <NuxtLink
                  to="/profile"
                  class="flex items-center gap-2 px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/8 hover:text-white transition-colors"
                >
                  <Icon name="heroicons:user" class="w-4 h-4" />
                  Profile
                </NuxtLink>
                <hr class="border-white/10 my-1" />
                <button
                  class="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                  @click="handleLogout"
                >
                  <Icon name="heroicons:arrow-right-on-rectangle" class="w-4 h-4" />
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
          <div class="h-20 px-4 flex items-center justify-between border-b border-white/10" style="background: rgba(0, 10, 56, 1);">
            <img src="/logo.png" alt="Arada Bingo" class="h-10 w-auto object-contain" />
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
                Deposit
              </button>
              
              <button
                class="w-full text-left px-4 py-3.5 rounded-xl text-[15px] font-medium text-white/80 hover:bg-white/5 flex items-center gap-3 transition-colors"
                @click="showWithdrawal = true; mobileNavOpen = false"
              >
                Withdraw
              </button>

              <button
                class="w-full text-left px-4 py-3.5 rounded-xl text-[15px] font-medium text-white/80 hover:bg-white/5 flex items-center gap-3 transition-colors"
                @click="toggleLocale(); mobileNavOpen = false"
              >
                {{ locale === 'en' ? 'Switch to Amharic (አማ)' : 'Switch to English (EN)' }}
              </button>

              <NuxtLink
                to="/profile"
                class="w-full text-left px-4 py-3.5 rounded-xl text-[15px] font-medium text-white/80 hover:bg-white/5 flex items-center gap-3 transition-colors"
                @click="mobileNavOpen = false"
              >
                Profile
              </NuxtLink>

              <button
                class="w-full text-left px-4 py-3.5 rounded-xl text-[15px] font-semibold text-red-500/90 hover:bg-red-500/5 flex items-center gap-3 transition-colors mt-2"
                @click="handleLogout"
              >
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
