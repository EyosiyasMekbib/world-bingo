<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

const auth = useAuthStore()
const router = useRouter()

const showDeposit = ref(false)
const showWithdrawal = ref(false)

async function handleLogout() {
  auth.logout()
  await router.push('/auth/login')
}

// Format balance with ETB
const formattedBalance = computed(() => {
  const bal = Number(auth.wallet?.balance ?? 0)
  return bal.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
})

// Mobile nav toggle
const mobileNavOpen = ref(false)
</script>

<template>
  <div class="min-h-screen flex flex-col" style="background: var(--color-background, #0a0d14); color: var(--color-text-primary, #fff);">

    <!-- ── Top Header ────────────────────────────────────────────────────── -->
    <header class="sticky top-0 z-40 border-b border-white/10"
      style="background: rgba(15,18,27,0.92); backdrop-filter: blur(12px);">
      <div class="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-4">

        <!-- Logo -->
        <NuxtLink to="/" class="flex items-center gap-2 flex-shrink-0 group">
          <div class="w-8 h-8 rounded-lg bg-amber-400 flex items-center justify-center">
            <span class="text-black font-bold text-base leading-none">B</span>
          </div>
          <span class="font-bold text-base text-white hidden sm:block tracking-tight group-hover:text-amber-400 transition-colors">
            World Bingo
          </span>
        </NuxtLink>

        <!-- Desktop nav links -->
        <nav class="hidden sm:flex items-center gap-1">
          <NuxtLink
            to="/"
            class="px-3 py-1.5 rounded-lg text-sm font-medium text-zinc-300 hover:text-white hover:bg-white/8 transition-all"
            active-class="text-amber-400 bg-amber-400/10"
          >
            🎮 Lobby
          </NuxtLink>
          <NuxtLink
            v-if="auth.isAuthenticated"
            to="/profile"
            class="px-3 py-1.5 rounded-lg text-sm font-medium text-zinc-300 hover:text-white hover:bg-white/8 transition-all"
            active-class="text-amber-400 bg-amber-400/10"
          >
            👤 Profile
          </NuxtLink>
        </nav>

        <!-- Right side actions -->
        <div class="flex items-center gap-2">

          <!-- Authenticated user -->
          <template v-if="auth.isAuthenticated">
            <!-- Wallet balance chip -->
            <div class="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/8 border border-white/10 text-sm">
              <span class="text-amber-400 font-semibold">{{ formattedBalance }}</span>
              <span class="text-zinc-400 text-xs">ETB</span>
            </div>

            <!-- Deposit button -->
            <button
              class="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-black text-sm font-semibold transition-colors"
              @click="showDeposit = true"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Deposit
            </button>

            <!-- Withdraw button -->
            <button
              class="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/20 hover:bg-white/8 text-white text-sm font-medium transition-colors"
              @click="showWithdrawal = true"
            >
              Withdraw
            </button>

            <!-- Notification bell -->
            <NotificationBell />

            <!-- User avatar / menu -->
            <div class="relative group">
              <button class="flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-white/8 transition-colors text-sm text-zinc-300">
                <div class="w-7 h-7 rounded-full bg-amber-400 flex items-center justify-center">
                  <span class="text-black text-xs font-bold leading-none">
                    {{ (auth.user?.username ?? 'U')[0].toUpperCase() }}
                  </span>
                </div>
                <span class="hidden md:block max-w-[100px] truncate">{{ auth.user?.username }}</span>
              </button>

              <!-- Dropdown -->
              <div class="absolute right-0 top-full mt-1 w-44 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 overflow-hidden">
                <NuxtLink to="/profile" class="flex items-center gap-2 px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/8 hover:text-white transition-colors">
                  <span>👤</span> Profile
                </NuxtLink>
                <hr class="border-white/10 my-1" />
                <button class="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors" @click="handleLogout">
                  <span>🚪</span> Logout
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
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path v-if="!mobileNavOpen" stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              <path v-else stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
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
        <div v-if="mobileNavOpen" class="sm:hidden border-t border-white/10 px-4 py-3 flex flex-col gap-2 bg-zinc-950">
          <NuxtLink to="/" class="px-3 py-2 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-white/8" @click="mobileNavOpen = false">🎮 Lobby</NuxtLink>
          <template v-if="auth.isAuthenticated">
            <div class="flex items-center justify-between px-3 py-2 rounded-lg bg-white/5">
              <span class="text-sm text-zinc-400">Balance</span>
              <span class="text-sm font-semibold text-amber-400">{{ formattedBalance }} ETB</span>
            </div>
            <button class="w-full text-left px-3 py-2 rounded-lg text-sm text-zinc-300 hover:bg-amber-400/10 hover:text-amber-400" @click="showDeposit = true; mobileNavOpen = false">💰 Deposit</button>
            <button class="w-full text-left px-3 py-2 rounded-lg text-sm text-zinc-300 hover:bg-white/8" @click="showWithdrawal = true; mobileNavOpen = false">💸 Withdraw</button>
            <NuxtLink to="/profile" class="px-3 py-2 rounded-lg text-sm text-zinc-300 hover:bg-white/8" @click="mobileNavOpen = false">👤 Profile</NuxtLink>
            <button class="w-full text-left px-3 py-2 rounded-lg text-sm text-red-400 hover:bg-red-500/10" @click="handleLogout">🚪 Logout</button>
          </template>
        </div>
      </Transition>
    </header>

    <!-- ── Page Content ───────────────────────────────────────────────────── -->
    <main class="flex-1">
      <slot />
    </main>

    <!-- ── Modals ─────────────────────────────────────────────────────────── -->
    <DepositModal
      v-if="showDeposit"
      @close="showDeposit = false"
      @deposited="auth.fetchWallet(); showDeposit = false"
    />
    <WithdrawalModal
      v-if="showWithdrawal"
      :balance="Number(auth.wallet?.balance ?? 0)"
      @close="showWithdrawal = false"
      @withdrawn="auth.fetchWallet(); showWithdrawal = false"
    />
  </div>
</template>
