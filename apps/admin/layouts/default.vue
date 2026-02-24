<script setup lang="ts">
const { user, logout } = useAdminAuth()
const { locale, setLocale } = useI18n()
const toggleLocale = () => setLocale(locale.value === 'en' ? 'am' : 'en')

const navItems = [
  { label: 'Dashboard',      icon: 'i-heroicons-squares-2x2',              to: '/'                },
  { label: 'Deposits',       icon: 'i-heroicons-arrow-down-tray',           to: '/deposits'        },
  { label: 'Withdrawals',    icon: 'i-heroicons-arrow-up-tray',             to: '/withdrawals'     },
  { label: 'Orders History', icon: 'i-heroicons-clipboard-document-list',   to: '/orders'          },
  { label: 'Games',          icon: 'i-heroicons-puzzle-piece',              to: '/games'           },
  { label: 'Tournaments',    icon: 'i-heroicons-trophy',                    to: '/tournaments'     },
  { label: 'Users',          icon: 'i-heroicons-users',                     to: '/users'           },
  { label: 'Profile',        icon: 'i-heroicons-user-circle',               to: '/settings/profile'},
]

const mobileOpen = ref(false)
const route = useRoute()
watch(() => route.path, () => { mobileOpen.value = false })
</script>

<template>
  <div class="min-h-screen flex flex-col" style="background:#0a0f1e;color:#f1f5f9;">

    <!-- ── Top header ─────────────────────────────────────────────── -->
    <header class="sticky top-0 z-40 h-14 flex items-center justify-between px-4 md:px-6 border-b border-white/8"
      style="background:rgba(10,15,30,0.92);backdrop-filter:blur(12px);">

      <!-- Logo + mobile burger -->
      <div class="flex items-center gap-3">
        <button class="md:hidden p-1.5 rounded-lg hover:bg-white/8 transition-colors" @click="mobileOpen = !mobileOpen">
          <UIcon name="i-heroicons-bars-3" class="w-5 h-5 text-zinc-300" />
        </button>
        <NuxtLink to="/" class="flex items-center gap-2 group">
          <div class="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-black text-base" style="background:#f59e0b;">B</div>
          <span class="font-bold text-base text-white tracking-tight group-hover:text-amber-400 transition-colors hidden sm:block">
            World Bingo <span class="text-amber-400/70 font-normal text-sm">Admin</span>
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
        <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/10 text-sm" style="background:rgba(255,255,255,0.05);">
          <UIcon name="i-heroicons-user-circle" class="w-4 h-4 text-amber-400" />
          <span class="text-zinc-200 text-sm font-medium">{{ user?.username ?? 'kira' }}</span>
        </div>
        <UButton size="xs" color="neutral" variant="ghost" icon="i-heroicons-arrow-left-on-rectangle"
          title="Logout" @click="logout()" />
      </div>
    </header>

    <div class="flex flex-1 overflow-hidden">

      <!-- ── Sidebar ───────────────────────────────────────────────── -->
      <!-- Mobile overlay -->
      <Transition name="fade">
        <div v-if="mobileOpen" class="fixed inset-0 z-30 bg-black/60 md:hidden" @click="mobileOpen = false" />
      </Transition>

      <aside
        class="fixed md:sticky top-14 left-0 z-30 h-[calc(100vh-3.5rem)] w-60 flex-shrink-0 flex flex-col py-4 overflow-y-auto transition-transform duration-200 border-r border-white/8"
        style="background:#0d1220;"
        :class="mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'"
      >
        <nav class="flex-1 px-3 space-y-0.5">
          <NuxtLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="admin-nav-link flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/6 transition-all"
            :class="route.path === item.to || (item.to !== '/' && route.path.startsWith(item.to))
              ? 'bg-amber-400/10 !text-amber-400'
              : ''"
          >
            <UIcon :name="item.icon" class="w-4.5 h-4.5 flex-shrink-0" />
            {{ item.label }}
          </NuxtLink>
        </nav>

        <div class="mt-auto px-3 pt-4 border-t border-white/8">
          <button
            class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-500 hover:text-red-400 hover:bg-red-500/8 transition-all"
            @click="logout()"
          >
            <UIcon name="i-heroicons-arrow-left-on-rectangle" class="w-4.5 h-4.5" />
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
