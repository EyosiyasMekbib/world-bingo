<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="$emit('update:modelValue', false)">
      <div class="modal">
        <div class="modal-header">
          <h3>Sign In to Play</h3>
          <button class="close-btn" @click="$emit('update:modelValue', false)">✕</button>
        </div>

        <div class="modal-body">
          <div class="icon-wrapper">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </div>

          <div class="content">
            <h4>Join the Game</h4>
            <p>Create an account or sign in to start playing bingo and winning real ETB.</p>
          </div>

          <div class="actions">
            <NuxtLink to="/auth/login" class="btn-primary" @click="$emit('update:modelValue', false)">
              Sign In
            </NuxtLink>
            <NuxtLink to="/auth/register" class="btn-secondary" @click="$emit('update:modelValue', false)">
              Create Account
            </NuxtLink>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
defineProps({
  modelValue: {
    type: Boolean,
    required: true,
  },
})

defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--color-surface, #1a1a2e);
  border: 1px solid var(--color-primary, #c9a96e);
  border-radius: 12px;
  width: 100%;
  max-width: 380px;
  padding: 0;
  animation: slideUp 0.2s ease-out;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.modal-header h3 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--color-primary, #c9a96e);
}

.close-btn {
  background: none;
  border: none;
  color: #999;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s;
}

.close-btn:hover {
  color: #ccc;
}

.modal-body {
  padding: 2rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  align-items: center;
  text-align: center;
}

.icon-wrapper {
  color: var(--color-primary, #c9a96e);
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-wrapper svg {
  width: 48px;
  height: 48px;
}

.content h4 {
  margin: 0 0 0.5rem 0;
  font-size: 1rem;
  color: #fff;
  font-weight: 600;
}

.content p {
  margin: 0;
  font-size: 0.9rem;
  color: #aaa;
  line-height: 1.5;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
}

.btn-primary,
.btn-secondary {
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 600;
  text-decoration: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
  width: 100%;
  text-align: center;
}

.btn-primary {
  background: var(--color-primary, #c9a96e);
  color: #000;
}

.btn-primary:hover {
  background: #d4af77;
  transform: translateY(-1px);
}

.btn-secondary {
  background: rgba(201, 169, 110, 0.15);
  color: var(--color-primary, #c9a96e);
  border: 1px solid rgba(201, 169, 110, 0.4);
}

.btn-secondary:hover {
  background: rgba(201, 169, 110, 0.25);
  border-color: rgba(201, 169, 110, 0.6);
}
</style>
