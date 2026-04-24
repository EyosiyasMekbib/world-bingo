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
      { label: 'Deposits',     icon: 'i-heroicons:arrow-down-tray',   to: '/deposits'    },
      { label: 'Withdrawals',  icon: 'i-heroicons:arrow-up-tray',     to: '/withdrawals' },
      { label: 'House Wallet', icon: 'i-heroicons:building-library',  to: '/house'       },
      { label: 'Money Flow',   icon: 'i-heroicons:arrows-right-left', to: '/money-flow'  },
    ],
  },
  {
    label: 'Games',
    items: [
      { label: 'Active Games',   icon: 'i-heroicons:puzzle-piece',  to: '/games'                   },
      { label: 'Game Templates', icon: 'i-heroicons:cog-6-tooth',   to: '/settings/game-templates' },
      { label: 'Tournaments',    icon: 'i-heroicons:trophy',        to: '/tournaments'             },
    ],
  },
  {
    label: 'Management',
    items: [
      { label: 'Players',       icon: 'i-heroicons:user-group',             to: '/players'           },
      { label: 'Users',         icon: 'i-heroicons:users',                  to: '/users'             },
      { label: 'Providers',     icon: 'i-heroicons:globe-alt',              to: '/providers'         },
      { label: 'Cashback',      icon: 'i-heroicons:gift',                   to: '/cashback'          },
      { label: 'Payment Methods', icon: 'i-heroicons:credit-card', to: '/settings/payment-methods' },
      { label: 'Feature Flags', icon: 'i-heroicons:adjustments-horizontal', to: '/settings/features' },
      { label: 'Profile',       icon: 'i-heroicons:user-circle',            to: '/settings/profile'  },
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

const isMobileHidden = computed(() => !isDesktop.value && !mobileOpen.value)

watch(() => route.path, () => { mobileOpen.value = false })

function openSidebar() { mobileOpen.value = true }

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
  <div class="admin-shell">

    <!-- ── Header ──────────────────────────────────────────────────── -->
    <header class="admin-header">
      <div class="header-left">
        <button
          ref="menuButtonRef"
          class="burger-btn md:hidden"
          :aria-expanded="mobileOpen"
          aria-controls="admin-sidebar"
          :aria-label="mobileOpen ? 'Close menu' : 'Open menu'"
          @click="mobileOpen ? closeSidebar() : openSidebar()"
        >
          <UIcon :name="mobileOpen ? 'i-heroicons:x-mark' : 'i-heroicons:bars-3'" class="w-5 h-5" />
        </button>

        <NuxtLink to="/" class="brand-link">
          <img src="/logo.png" alt="World Bingo" class="brand-logo" />
          <div class="brand-text">
            <span class="brand-name">World Bingo</span>
            <span class="brand-sub">Admin Console</span>
          </div>
        </NuxtLink>
      </div>

      <div class="header-right">
        <button class="locale-btn hidden sm:flex" @click="toggleLocale">
          {{ locale === 'en' ? 'አማ' : 'EN' }}
        </button>

        <div class="user-chip">
          <UIcon name="i-heroicons:user-circle" class="w-4 h-4 opacity-50" />
          <span>{{ user?.username ?? 'Admin' }}</span>
        </div>

        <button class="signout-btn" aria-label="Sign out" @click="logout()">
          <UIcon name="i-heroicons:arrow-left-on-rectangle" class="w-4 h-4" />
        </button>
      </div>
    </header>

    <div class="admin-body">

      <!-- ── Sidebar overlay (mobile) ─────────────────────────────── -->
      <Transition name="fade">
        <div
          v-if="mobileOpen"
          class="sidebar-overlay md:hidden"
          aria-hidden="true"
          @click="closeSidebar"
        />
      </Transition>

      <!-- ── Sidebar ───────────────────────────────────────────────── -->
      <aside
        id="admin-sidebar"
        class="admin-sidebar"
        :class="mobileOpen ? 'sidebar--open' : ''"
        :aria-hidden="isMobileHidden ? 'true' : undefined"
        :inert="isMobileHidden ? true : undefined"
      >
        <nav class="sidebar-nav">
          <template v-for="(group, gi) in navGroups" :key="gi">

            <!-- Group separator with label -->
            <div v-if="group.label" class="nav-group-label">
              <span>{{ group.label }}</span>
              <div class="nav-group-rule"></div>
            </div>

            <div class="nav-group-items" :class="{ 'nav-group-items--first': !group.label && gi === 0 }">
              <NuxtLink
                v-for="item in group.items"
                :key="item.to"
                :to="item.to"
                class="admin-nav-link nav-item"
                :class="{ 'nav-item--active': isNavActive(item.to) }"
                :aria-current="isNavActive(item.to) ? 'page' : undefined"
              >
                <UIcon :name="item.icon" class="nav-icon" />
                <span>{{ item.label }}</span>
              </NuxtLink>
            </div>
          </template>
        </nav>

        <div class="sidebar-footer">
          <button class="signout-full" @click="logout()">
            <UIcon name="i-heroicons:arrow-left-on-rectangle" class="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      <!-- ── Main ──────────────────────────────────────────────────── -->
      <main class="admin-main">
        <slot />
      </main>

    </div>
  </div>
</template>

<style scoped>
/* ── Shell ───────────────────────────────────────────────────────────── */
.admin-shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--surface-base);
  color: var(--text-primary);
  overflow: hidden;
}

/* ── Header ──────────────────────────────────────────────────────────── */
.admin-header {
  position: sticky;
  top: 0;
  z-index: 40;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background: rgba(3, 12, 34, 0.96);
  border-bottom: 1px solid var(--surface-border);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.burger-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: none;
  border: none;
  color: rgba(255,255,255,0.55);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.burger-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.85); }
.burger-btn:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 2px; }

.brand-link {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
}
.brand-logo {
  width: 28px;
  height: 28px;
  object-fit: contain;
  flex-shrink: 0;
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1;
  gap: 1px;
}
.brand-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--brand-primary);
  letter-spacing: -0.01em;
}
.brand-sub {
  font-size: 10px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  display: none;
}
@media (min-width: 640px) { .brand-sub { display: block; } }

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.locale-btn {
  height: 28px;
  padding: 0 10px;
  border-radius: 5px;
  background: none;
  border: 1px solid var(--surface-border);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  letter-spacing: 0.04em;
  font-family: 'Space Grotesk', system-ui, sans-serif;
  transition: background 0.12s ease, color 0.12s ease;
}
.locale-btn:hover { background: rgba(255,255,255,0.05); color: var(--text-primary); }

.user-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border-radius: 5px;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.signout-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 5px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.signout-btn:hover { background: rgba(248,113,113,0.08); color: #f87171; }
.signout-btn:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 2px; }

/* ── Body ────────────────────────────────────────────────────────────── */
.admin-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Sidebar overlay ─────────────────────────────────────────────────── */
.sidebar-overlay {
  position: fixed;
  inset: 0;
  z-index: 30;
  background: rgba(0,0,0,0.6);
}

/* ── Sidebar ─────────────────────────────────────────────────────────── */
.admin-sidebar {
  position: fixed;
  top: 52px;
  left: 0;
  z-index: 30;
  width: 224px;
  height: calc(100vh - 52px);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-overlay);
  border-right: 1px solid var(--surface-border);
  overflow-y: auto;
  transform: translateX(-100%);
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

@media (min-width: 768px) {
  .admin-sidebar {
    position: relative;
    top: auto;
    height: 100%;
    transform: none !important;
    z-index: 1;
    will-change: auto;
  }
}

.sidebar--open { transform: translateX(0); }

/* ── Nav ─────────────────────────────────────────────────────────────── */
.sidebar-nav {
  flex: 1;
  padding: 12px 0;
}

.nav-group-label {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 16px 6px;
}

.nav-group-label span {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}

.nav-group-rule {
  flex: 1;
  height: 1px;
  background: var(--surface-border);
}

.nav-group-items {
  padding: 0 8px;
}

.nav-group-items--first {
  padding-top: 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-bottom: 1px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  text-decoration: none;
  border-radius: 0 6px 6px 0;
  border-left: 2px solid transparent;
  transition: color 0.12s ease, background 0.12s ease, border-color 0.12s ease;
}

.nav-item:hover {
  color: var(--text-primary);
  background: rgba(255,255,255,0.04);
}

.nav-item--active,
.nav-item.router-link-active,
.nav-item.router-link-exact-active {
  color: var(--brand-primary) !important;
  background: var(--brand-glow) !important;
  border-left-color: var(--brand-primary) !important;
  font-weight: 600;
}

.nav-item:focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: -2px;
}

.nav-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  opacity: 0.7;
}

.nav-item--active .nav-icon,
.nav-item.router-link-active .nav-icon {
  opacity: 1;
}

/* ── Sidebar footer ──────────────────────────────────────────────────── */
.sidebar-footer {
  padding: 12px 8px;
  border-top: 1px solid var(--surface-border);
}

.signout-full {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  background: none;
  border: none;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  cursor: pointer;
  font-family: 'Space Grotesk', system-ui, sans-serif;
  transition: background 0.12s ease, color 0.12s ease;
}
.signout-full:hover { background: rgba(248,113,113,0.07); color: #f87171; }
.signout-full:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 2px; }

/* ── Main ────────────────────────────────────────────────────────────── */
.admin-main {
  flex: 1;
  overflow-y: auto;
  min-width: 0;
  min-height: 0;
  padding: 28px 24px;
}

@media (min-width: 768px) {
  .admin-main { padding: 32px 32px; }
}

/* ── Transitions ─────────────────────────────────────────────────────── */
.fade-enter-active, .fade-leave-active { transition: opacity 0.18s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
