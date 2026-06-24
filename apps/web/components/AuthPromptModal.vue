<template>
  <Teleport to="body">
    <div v-if="modelValue" class="wb-overlay" @click.self="$emit('update:modelValue', false)">
      <div class="wb-modal wb-modal--sm">
        <div class="wb-modal__head">
          <h3 class="wb-modal__title">Sign In to Play</h3>
          <button class="wb-close" aria-label="Close" @click="$emit('update:modelValue', false)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div class="wb-modal__body prompt">
          <div class="prompt-icon">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </div>

          <div class="prompt-copy">
            <h4>Join the Game</h4>
            <p>Create an account or sign in to start playing bingo and winning real ETB.</p>
          </div>

          <div class="prompt-actions">
            <NuxtLink to="/auth/login" class="wb-btn wb-btn--primary wb-btn--block" @click="$emit('update:modelValue', false)">
              Sign In
            </NuxtLink>
            <NuxtLink to="/auth/register" class="wb-btn wb-btn--ghost wb-btn--block" @click="$emit('update:modelValue', false)">
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
.prompt {
  align-items: center;
  text-align: center;
  gap: 22px;
  padding: 30px 24px 28px;
}

.prompt-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 76px;
  height: 76px;
  border-radius: var(--radius-full, 9999px);
  color: var(--brand-primary);
  background: color-mix(in srgb, var(--brand-primary) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 32%, transparent);
}

.prompt-copy h4 {
  margin: 0 0 7px;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 17px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--text-primary);
}
.prompt-copy p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.prompt-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}
</style>
