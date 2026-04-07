<script setup lang="ts">
const { user, logout } = useAdminAuth()
const { locale, setLocale } = useI18n()
const toggleLocale = () => setLocale(locale.value === 'en' ? 'am' : 'en')

const navGroups = [
  {
    label: null,
    items: [
      { label: 'Dashboard', icon: 'i-heroicons:squares-2x2', to: '/' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Deposits',     icon: 'i-heroicons:arrow-down-tray',         to: '/deposits'   },
      { label: 'Withdrawals',  icon: 'i-heroicons:arrow-up-tray',           to: '/withdrawals' },
      { label: 'House Wallet', icon: 'i-heroicons:building-library',        to: '/house'       },
      { label: 'Money Flow',   icon: 'i-heroicons:arrows-right-left',       to: '/money-flow'  },
    ],
  },
  {
    label: 'Games',
    items: [
      { label: 'Active Games',    icon: 'i-heroicons:puzzle-piece',   to: '/games'                    },
      { label: 'Game Templates',  icon: 'i-heroicons:cog-6-tooth',    to: '/settings/game-templates'  },
      { label: 'Tournaments',     icon: 'i-heroicons:trophy',         to: '/tournaments'              },
    ],
  },
  {
    label: null,
    items: [
      { label: 'Players',      icon: 'i-heroicons:user-group',              to: '/players'           },
      { label: 'Users',        icon: 'i-heroicons:users',                   to: '/users'             },
      { label: 'Providers',    icon: 'i-heroicons:globe-alt',               to: '/providers'         },
      { label: 'Cashback',     icon: 'i-heroicons:gift',                    to: '/cashback'          },
      { label: 'Feature Flags',icon: 'i-heroicons:adjustments-horizontal',  to: '/settings/features' },
      { label: 'Profile',      icon: 'i-heroicons:user-circle',             to: '/settings/profile'  },
    ],
  },
]

const mobileOpen = ref(false)
const menuButtonRef = ref<HTMLButtonElement | null>(null)
const route = useRoute()
const isDesktop = ref(false)

onMounted(() => {
  const mq = window.matchMedia('(min-width: 768px)')
  isDesktop.value = mq.matches
  mq.addEventListener('change', (e) => { isDesktop.value = e.matches })
})

// Sidebar is hidden (and should be inert) only when on mobile AND not open
const isMobileHidden = computed(() => !isDesktop.value && !mobileOpen.value)

watch(() => route.path, () => { mobileOpen.value = false })

function openSidebar() {
  mobileOpen.value = true
}

function closeSidebar() {
  mobileOpen.value = false
  nextTick(() => menuButtonRef.value?.focus())
}

function isNavActive(to: string) {
  return to === '/' ? route.path === '/' : route.path.startsWith(to)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && mobileOpen.value) closeSidebar()
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <div class="min-h-screen flex flex-col" style="background:var(--surface-base);color:var(--text-primary);">

    <!-- ── Top header ─────────────────────────────────────────────── -->
    <header class="sticky top-0 z-40 h-14 flex items-center justify-between px-4 md:px-6 border-b border-(--surface-border)"
      style="background:rgba(0,10,56,0.92);backdrop-filter:blur(12px);">

      <!-- Logo + mobile burger -->
      <div class="flex items-center gap-3">
        <button
          ref="menuButtonRef"
          class="md:hidden p-1.5 rounded-lg hover:bg-white/8 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yellow-400"
          :aria-expanded="mobileOpen"
          aria-controls="mobile-sidebar"
          :aria-label="mobileOpen ? 'Close navigation menu' : 'Open navigation menu'"
          @click="mobileOpen ? closeSidebar() : openSidebar()"
        >
          <UIcon :name="mobileOpen ? 'i-heroicons:x-mark' : 'i-heroicons:bars-3'" class="w-5 h-5 text-zinc-300" />
        </button>
        <NuxtLink to="/" class="flex items-center gap-2 group">
          <img src="/logo.png" alt="World Bingo" class="w-8 h-8 object-contain" />
          <span class="font-bold text-base text-yellow-500/90 tracking-tight group-hover:text-yellow-400 transition-colors hidden sm:block">
            Admin
          </span>
        </NuxtLink>
      </div>

      <!-- Right actions -->
      <div class="flex items-center gap-2">
        <UButton
          size="xs" color="neutral" variant="ghost"
          :label="locale === 'en' ? 'አማ' : 'EN'"
          class="hidden sm:flex"
          @click="toggleLocale"
        />
        <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-(--surface-border) text-sm" style="background:var(--surface-raised);">
          <UIcon name="i-heroicons:user-circle" class="w-4 h-4 text-yellow-500" />
          <span class="text-zinc-200 text-sm font-medium">{{ user?.username ?? 'Admin' }}</span>
        </div>
        <UButton size="xs" color="neutral" variant="ghost" icon="i-heroicons:arrow-left-on-rectangle"
          aria-label="Sign out" @click="logout()" />
      </div>
    </header>

    <div class="flex flex-1 overflow-hidden">

      <!-- ── Sidebar ───────────────────────────────────────────────── -->
      <!-- Mobile overlay -->
      <Transition name="fade">
        <div v-if="mobileOpen" class="fixed inset-0 z-30 bg-black/60 md:hidden" aria-hidden="true" @click="closeSidebar" />
      </Transition>

      <aside
        id="mobile-sidebar"
        class="fixed md:sticky top-14 left-0 z-30 h-[calc(100vh-3.5rem)] w-60 flex-shrink-0 flex flex-col py-4 overflow-y-auto transition-transform duration-200 border-r border-(--surface-border)"
        style="background:var(--surface-overlay); backdrop-filter: blur(16px);"
        :class="mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'"
        :aria-hidden="isMobileHidden ? 'true' : undefined"
        :inert="isMobileHidden ? true : undefined"
      >
        <nav class="flex-1 px-3 space-y-4">
          <div v-for="(group, gi) in navGroups" :key="gi">
            <p v-if="group.label" class="px-3 mb-1 text-[10px] font-bold text-white/30 uppercase tracking-widest">
              {{ group.label }}
            </p>
            <div class="space-y-0.5">
              <NuxtLink
                v-for="item in group.items"
                :key="item.to"
                :to="item.to"
                class="admin-nav-link flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/6 transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yellow-400"
                :class="isNavActive(item.to) ? 'bg-yellow-400/10 text-yellow-500!' : ''"
                :aria-current="isNavActive(item.to) ? 'page' : undefined"
              >
                <UIcon :name="item.icon" class="w-4.5 h-4.5 flex-shrink-0" />
                {{ item.label }}
              </NuxtLink>
            </div>
          </div>
        </nav>

        <div class="mt-auto px-3 pt-4 border-t border-(--surface-border)">
          <button
            class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-500 hover:text-red-400 hover:bg-red-500/8 transition-all"
            @click="logout()"
          >
            <UIcon name="i-heroicons:arrow-left-on-rectangle" class="w-4.5 h-4.5" />
            Sign out
          </button>
        </div>
      </aside>

      <!-- ── Main content ──────────────────────────────────────────── -->
      <main class="flex-1 overflow-y-auto min-w-0 p-5 md:p-7">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
