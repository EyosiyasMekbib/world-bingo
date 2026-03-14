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
    style="background: var(--surface-base, #0a0d14); color: var(--color-text-primary, #fff)"
  >
    <!-- ── Top Header ────────────────────────────────────────────────────── -->
    <header
      class="sticky top-0 z-40 border-b border-white/10"
      style="
        background: var(--surface-overlay, rgba(15, 18, 27, 0.92));
        backdrop-filter: blur(12px);
      "
    >
      <div class="max-w-6xl mx-auto px-4 h-20 flex items-center justify-between gap-4">
        <!-- Logo -->
        <NuxtLink to="/" class="h-20 flex items-center flex-shrink-0 group">
          <img src="/logo.png" alt="Arada Bingo Logo" class="h-full w-auto object-contain py-0.5" />
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
              <span class="text-amber-400 font-semibold">{{ formattedBalance }}</span>
              <span class="text-zinc-400 text-xs">ETB</span>
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
            <svg
              class="w-5 h-5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path
                v-if="!mobileNavOpen"
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M4 6h16M4 12h16M4 18h16"
              />
              <path
                v-else
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
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
          class="sm:hidden border-t border-white/10 px-4 py-3 flex flex-col gap-2 bg-zinc-950"
        >
          <NuxtLink
            v-if="referralsEnabled && auth.isAuthenticated"
            to="/refer"
            class="px-3 py-2 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-white/8 flex items-center gap-2"
            @click="mobileNavOpen = false"
          >
            <Icon name="heroicons:gift" class="w-4 h-4" />
            Refer &amp; Earn
          </NuxtLink>
          <NuxtLink
            v-if="tournamentsEnabled"
            to="/tournaments"
            class="px-3 py-2 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-white/8 flex items-center gap-2"
            @click="mobileNavOpen = false"
          >
            <Icon name="heroicons:trophy" class="w-4 h-4" />
            Tournaments
          </NuxtLink>
          <template v-if="auth.isAuthenticated">
            <div class="flex items-center justify-between px-3 py-2 rounded-lg bg-white/5">
              <span class="text-sm text-zinc-400 flex items-center gap-2">
                <Icon name="heroicons:wallet" class="w-4 h-4" />
                Balance
              </span>
              <span class="text-sm font-semibold text-amber-400">{{ formattedBalance }} ETB</span>
            </div>
            <button
              class="w-full text-left px-3 py-2 rounded-lg text-sm text-zinc-300 hover:bg-amber-400/10 hover:text-amber-400 flex items-center gap-2"
              @click="showDeposit = true; mobileNavOpen = false"
            >
              <Icon name="heroicons:plus-circle" class="w-4 h-4" />
              Deposit
            </button>
            <button
              class="w-full text-left px-3 py-2 rounded-lg text-sm text-zinc-300 hover:bg-white/8 flex items-center gap-2"
              @click="showWithdrawal = true; mobileNavOpen = false"
            >
              <Icon name="heroicons:arrow-up-circle" class="w-4 h-4" />
              Withdraw
            </button>
            <button
              class="w-full text-left px-3 py-2 rounded-lg text-sm text-zinc-300 hover:bg-white/8 flex items-center gap-2"
              @click="toggleLocale(); mobileNavOpen = false"
              :title="locale === 'en' ? 'Switch to Amharic' : 'Switch to English'"
            >
              <Icon name="heroicons:language" class="w-4 h-4" />
              <span>{{
                locale === 'en' ? 'Switch to Amharic (አማ)' : 'Switch to English (EN)'
              }}</span>
            </button>
            <NuxtLink
              to="/profile"
              class="px-3 py-2 rounded-lg text-sm text-zinc-300 hover:bg-white/8 flex items-center gap-2"
              @click="mobileNavOpen = false"
            >
              <Icon name="heroicons:user" class="w-4 h-4" />
              Profile
            </NuxtLink>
            <button
              class="w-full text-left px-3 py-2 rounded-lg text-sm text-red-400 hover:bg-red-500/10 flex items-center gap-2"
              @click="handleLogout"
            >
              <Icon name="heroicons:arrow-right-on-rectangle" class="w-4 h-4" />
              Logout
            </button>
          </template>
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
