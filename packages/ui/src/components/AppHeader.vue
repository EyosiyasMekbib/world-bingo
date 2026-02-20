<template>
  <header class="app-header">
    <button class="app-header__menu-btn" @click="emit('menu')" aria-label="Open menu">
      <span class="app-header__hamburger"></span>
    </button>

    <div class="app-header__logo">
      <span class="app-header__logo-text">WORLD BINGO</span>
    </div>

    <div class="app-header__actions">
      <button class="app-header__icon-btn" @click="emit('notifications')" aria-label="Notifications">
        <span>🔔</span>
        <span v-if="unreadCount > 0" class="app-header__badge">{{ unreadCount }}</span>
      </button>
      <WalletBalance :balance="balance" @click="emit('wallet')" />
    </div>
  </header>
</template>

<script setup lang="ts">
import WalletBalance from './WalletBalance.vue'

defineProps<{
  balance: number
  unreadCount?: number
}>()

const emit = defineEmits<{
  menu: []
  wallet: []
  notifications: []
}>()
</script>

<style scoped>
.app-header {
  position: sticky;
  top: 0;
  z-index: var(--z-dropdown);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: rgba(10, 15, 30, 0.9);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--surface-border);
  height: 60px;
}

.app-header__menu-btn {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  width: 40px;
  height: 40px;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  padding: 10px 8px;
  transition: background var(--duration-fast), border-color var(--duration-fast);
}

.app-header__menu-btn:hover {
  background: var(--surface-raised);
  border-color: var(--brand-primary);
}

.app-header__hamburger,
.app-header__hamburger::before,
.app-header__hamburger::after {
  display: block;
  height: 2px;
  width: 100%;
  background: var(--text-primary);
  border-radius: 2px;
  content: '';
}

.app-header__hamburger {
  position: relative;
}

.app-header__hamburger::before {
  position: absolute;
  top: -5px;
}

.app-header__hamburger::after {
  position: absolute;
  bottom: -5px;
}

.app-header__logo {
  flex: 1;
  text-align: center;
}

.app-header__logo-text {
  font-family: var(--font-game);
  font-size: var(--text-xl);
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--brand-primary);
  text-shadow: 0 0 20px var(--brand-primary-glow);
}

.app-header__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.app-header__icon-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: var(--text-base);
  transition: background var(--duration-fast), border-color var(--duration-fast);
}

.app-header__icon-btn:hover {
  background: var(--surface-raised);
  border-color: var(--surface-border);
}

.app-header__badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  background: var(--status-error);
  color: white;
  font-size: 10px;
  font-weight: 700;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
}
</style>
