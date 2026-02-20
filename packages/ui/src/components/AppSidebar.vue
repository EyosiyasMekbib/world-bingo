<template>
  <Transition name="drawer">
    <div v-if="isOpen" class="sidebar-overlay" @click.self="emit('close')">
      <nav class="sidebar" role="dialog" aria-label="Navigation menu">
        <div class="sidebar__header">
          <span class="sidebar__title">MENU</span>
          <button class="sidebar__close" @click="emit('close')" aria-label="Close menu">✕</button>
        </div>

        <div class="sidebar__user">
          <div class="sidebar__avatar">{{ userInitial }}</div>
          <div>
            <div class="sidebar__username">{{ username }}</div>
            <div class="sidebar__balance">ETB {{ balance.toFixed(2) }}</div>
          </div>
        </div>

        <div class="sidebar__divider"></div>

        <ul class="sidebar__nav">
          <li v-for="item in navItems" :key="item.href">
            <a
              :href="item.href"
              class="sidebar__nav-item"
              :class="{ 'sidebar__nav-item--active': item.href === currentPath }"
              @click="emit('close')"
            >
              <span class="sidebar__nav-icon">{{ item.icon }}</span>
              <span>{{ item.label }}</span>
            </a>
          </li>
        </ul>

        <div class="sidebar__divider"></div>

        <button class="sidebar__logout" @click="emit('logout')">
          <span>🔓</span>
          <span>Logout</span>
        </button>
      </nav>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  isOpen: boolean
  username: string
  balance: number
  currentPath?: string
}>()

const emit = defineEmits<{
  close: []
  logout: []
}>()

const navItems = [
  { icon: '💰', label: 'Wallet', href: '/wallet' },
  { icon: '📋', label: 'Game History', href: '/history' },
  { icon: '🔔', label: 'Notifications', href: '/notifications' },
  { icon: '⚙️', label: 'Settings', href: '/settings' },
]

const userInitial = computed(() => props.username.charAt(0).toUpperCase())
</script>

<style scoped>
.sidebar-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.sidebar {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 280px;
  background: var(--surface-raised);
  border-right: 1px solid var(--surface-border);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-6);
  overflow-y: auto;
}

.sidebar__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar__title {
  font-family: var(--font-game);
  font-size: var(--text-lg);
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
}

.sidebar__close {
  width: 32px;
  height: 32px;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  transition: background var(--duration-fast), color var(--duration-fast);
}

.sidebar__close:hover {
  background: var(--status-error);
  color: white;
}

.sidebar__user {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--surface-overlay);
  border-radius: var(--radius-lg);
}

.sidebar__avatar {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-full);
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-game);
  font-weight: 700;
  font-size: var(--text-xl);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.sidebar__username {
  font-family: var(--font-game);
  font-weight: 600;
  font-size: var(--text-base);
  color: var(--text-primary);
}

.sidebar__balance {
  font-size: var(--text-sm);
  color: var(--brand-primary);
  font-weight: 600;
}

.sidebar__divider {
  height: 1px;
  background: var(--surface-border);
  margin: var(--space-2) 0;
}

.sidebar__nav {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.sidebar__nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  text-decoration: none;
  color: var(--text-secondary);
  font-size: var(--text-base);
  font-weight: 600;
  transition:
    background var(--duration-fast),
    color var(--duration-fast);
}

.sidebar__nav-item:hover,
.sidebar__nav-item--active {
  background: var(--surface-overlay);
  color: var(--text-primary);
}

.sidebar__nav-item--active {
  border-left: 3px solid var(--brand-primary);
  padding-left: calc(var(--space-4) - 3px);
  color: var(--brand-primary);
}

.sidebar__nav-icon {
  font-size: var(--text-lg);
  width: 24px;
  text-align: center;
}

.sidebar__logout {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: var(--text-base);
  font-weight: 600;
  cursor: pointer;
  width: 100%;
  transition: background var(--duration-fast), color var(--duration-fast);
  margin-top: auto;
}

.sidebar__logout:hover {
  background: rgba(239, 68, 68, 0.1);
  color: var(--status-error);
}

.drawer-enter-active,
.drawer-leave-active {
  transition: opacity var(--duration-normal) var(--ease-out);
}

.drawer-enter-active .sidebar,
.drawer-leave-active .sidebar {
  transition: transform var(--duration-normal) var(--ease-out);
}

.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}

.drawer-enter-from .sidebar,
.drawer-leave-to .sidebar {
  transform: translateX(-100%);
}
</style>
