<script setup lang="ts">
const { user, logout } = useAdminAuth()
const { locale, setLocale } = useI18n()
const toggleLocale = () => setLocale(locale.value === 'en' ? 'am' : 'en')

const items = [
  {
    label: 'Dashboard',
    icon: 'i-heroicons-home',
    to: '/'
  },
  {
    label: 'Deposits',
    icon: 'i-heroicons-arrow-down-tray',
    to: '/deposits'
  },
  {
    label: 'Withdrawals',
    icon: 'i-heroicons-arrow-up-tray',
    to: '/withdrawals'
  },
  {
    label: 'Orders History',
    icon: 'i-heroicons-clipboard-document-list',
    to: '/orders'
  },
  {
    label: 'Games',
    icon: 'i-heroicons-puzzle-piece',
    to: '/games'
  },
  {
    label: 'Tournaments',
    icon: 'i-heroicons-trophy',
    to: '/tournaments'
  },
  {
    label: 'Users',
    icon: 'i-heroicons-users',
    to: '/users'
  },
  {
    label: 'Profile',
    icon: 'i-heroicons-user',
    to: '/settings/profile'
  }
]

const dropdownItems = [
  {
    label: 'Logout',
    icon: 'i-heroicons-arrow-left-on-rectangle',
    onSelect: () => logout()
  }
]
</script>

<template>
  <div class="min-h-screen bg-neutral-50 flex flex-col">
    <header class="bg-white border-b border-neutral-200 h-16 flex items-center justify-between px-6 sticky top-0 z-10 font-geist">
      <div class="flex items-center gap-2">
        <UIcon name="i-heroicons-globe-alt" class="w-8 h-8 text-primary-600" />
        <span class="font-bold text-xl text-neutral-900 tracking-tight">World Bingo Admin</span>
      </div>
      <div class="flex items-center gap-4">
        <!-- Language switcher -->
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          :label="locale === 'en' ? 'አማ' : 'EN'"
          :title="locale === 'en' ? 'Switch to Amharic' : 'Switch to English'"
          @click="toggleLocale"
        />
        <UDropdownMenu :items="dropdownItems" :content="{ align: 'end' }">
          <UButton color="neutral" variant="ghost" icon="i-heroicons-user-circle" :label="`Manager: ${user?.username || 'kira'}`" trailing-icon="i-heroicons-chevron-down-20-solid" />
        </UDropdownMenu>
      </div>
    </header>
    
    <div class="flex-1 flex overflow-hidden max-w-7xl w-full mx-auto">
      <aside class="w-64 flex-shrink-0 bg-white border-r border-neutral-200 hidden md:block select-none overflow-y-auto pt-6">
        <nav class="px-4">
          <UNavigationMenu orientation="vertical" :items="items" class="mt-2" />
        </nav>
      </aside>
      
      <main class="flex-1 overflow-y-auto bg-gray-50 p-6 md:p-8">
        <slot />
      </main>
    </div>
  </div>
</template>
