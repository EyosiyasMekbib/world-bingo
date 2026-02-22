<script setup lang="ts">
import type { Notification } from '@world-bingo/shared-types'
import { useAuthStore } from '~/store/auth'

const auth = useAuthStore()
const { connect } = useSocket()

// ── State ──────────────────────────────────────────────────────────────────
const notifications = ref<Notification[]>([])
const isOpen = ref(false)
const loading = ref(false)

const unreadCount = computed(() => notifications.value.filter((n) => !n.isRead).length)

// ── Fetch unread notifications ─────────────────────────────────────────────
async function fetchNotifications() {
  if (!auth.token) return
  loading.value = true
  try {
    const data = await $fetch<Notification[]>('/user/notifications', {
      baseURL: useRuntimeConfig().public.apiBase,
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    notifications.value = data ?? []
  } catch {
    // fail silently
  } finally {
    loading.value = false
  }
}

// ── Mark one as read ───────────────────────────────────────────────────────
async function markRead(notif: Notification) {
  if (notif.isRead) return
  try {
    await $fetch(`/user/notifications/${notif.id}/read`, {
      method: 'POST',
      baseURL: useRuntimeConfig().public.apiBase,
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    const idx = notifications.value.findIndex((n) => n.id === notif.id)
    if (idx !== -1) notifications.value[idx] = { ...notif, isRead: true }
  } catch {
    // fail silently
  }
}

// ── Mark all as read ───────────────────────────────────────────────────────
async function markAllRead() {
  try {
    await $fetch('/user/notifications/read-all', {
      method: 'POST',
      baseURL: useRuntimeConfig().public.apiBase,
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    notifications.value = notifications.value.map((n) => ({ ...n, isRead: true }))
  } catch {
    // fail silently
  }
}

// ── Toggle dropdown ────────────────────────────────────────────────────────
function toggleOpen() {
  isOpen.value = !isOpen.value
  if (isOpen.value) fetchNotifications()
}

// ── Close on outside click ─────────────────────────────────────────────────
const bellRef = ref<HTMLElement | null>(null)
function onClickOutside(e: MouseEvent) {
  if (bellRef.value && !bellRef.value.contains(e.target as Node)) {
    isOpen.value = false
  }
}

// ── Icon per notification type ─────────────────────────────────────────────
function notifIcon(type: string): string {
  const map: Record<string, string> = {
    DEPOSIT_APPROVED: '✅',
    DEPOSIT_REJECTED: '❌',
    WITHDRAWAL_PROCESSED: '💸',
    WITHDRAWAL_REJECTED: '⛔',
    GAME_STARTING: '🎮',
    GAME_CANCELLED: '🚫',
    GAME_WON: '🏆',
    GENERAL: 'ℹ️',
  }
  return map[type] ?? 'ℹ️'
}

// ── Format relative time ───────────────────────────────────────────────────
function relativeTime(date: Date | string): string {
  const now = Date.now()
  const then = new Date(date).getTime()
  const diff = Math.floor((now - then) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// ── Socket: listen for new notifications ──────────────────────────────────
onMounted(() => {
  fetchNotifications()
  document.addEventListener('click', onClickOutside)

  const socket = connect()
  socket.on('notification:new', (notif) => {
    notifications.value.unshift(notif as any)
  })
})

onUnmounted(() => {
  document.removeEventListener('click', onClickOutside)
})
</script>

<template>
  <div ref="bellRef" class="relative">
    <!-- Bell button -->
    <button
      class="relative p-2 rounded-full hover:bg-white/10 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-400"
      aria-label="Notifications"
      @click.stop="toggleOpen"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
      <!-- Unread badge -->
      <span
        v-if="unreadCount > 0"
        class="absolute top-0.5 right-0.5 min-w-[18px] h-[18px] flex items-center justify-center bg-red-500 text-white text-[10px] font-bold rounded-full px-1 leading-none"
      >
        {{ unreadCount > 99 ? '99+' : unreadCount }}
      </span>
    </button>

    <!-- Dropdown panel -->
    <Transition
      enter-active-class="transition ease-out duration-150"
      enter-from-class="opacity-0 scale-95 translate-y-1"
      enter-to-class="opacity-100 scale-100 translate-y-0"
      leave-active-class="transition ease-in duration-100"
      leave-from-class="opacity-100 scale-100 translate-y-0"
      leave-to-class="opacity-0 scale-95 translate-y-1"
    >
      <div
        v-if="isOpen"
        class="absolute right-0 mt-2 w-80 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden origin-top-right"
        @click.stop
      >
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <span class="text-sm font-semibold text-white">Notifications</span>
          <button
            v-if="unreadCount > 0"
            class="text-xs text-amber-400 hover:text-amber-300 transition-colors"
            @click="markAllRead"
          >
            Mark all read
          </button>
        </div>

        <!-- List -->
        <div class="max-h-80 overflow-y-auto divide-y divide-white/5">
          <div v-if="loading" class="flex items-center justify-center py-8">
            <div class="w-5 h-5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
          </div>

          <div
            v-else-if="notifications.length === 0"
            class="flex flex-col items-center py-10 text-zinc-500 text-sm gap-2"
          >
            <span class="text-3xl">🔕</span>
            <span>No notifications yet</span>
          </div>

          <button
            v-for="notif in notifications"
            :key="notif.id"
            class="w-full text-left px-4 py-3 hover:bg-white/5 transition-colors flex gap-3"
            :class="{ 'bg-amber-400/5': !notif.isRead }"
            @click="markRead(notif)"
          >
            <span class="text-xl flex-shrink-0 mt-0.5">{{ notifIcon(notif.type) }}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-start justify-between gap-2">
                <p class="text-sm font-medium text-white leading-tight truncate">{{ notif.title }}</p>
                <span
                  v-if="!notif.isRead"
                  class="flex-shrink-0 w-2 h-2 rounded-full bg-amber-400 mt-1"
                />
              </div>
              <p class="text-xs text-zinc-400 mt-0.5 line-clamp-2">{{ notif.body }}</p>
              <p class="text-[11px] text-zinc-600 mt-1">{{ relativeTime(notif.createdAt) }}</p>
            </div>
          </button>
        </div>

        <!-- Footer -->
        <div v-if="notifications.length > 0" class="px-4 py-2 border-t border-white/10 text-center">
          <span class="text-xs text-zinc-500">{{ notifications.length }} total · {{ unreadCount }} unread</span>
        </div>
      </div>
    </Transition>
  </div>
</template>
