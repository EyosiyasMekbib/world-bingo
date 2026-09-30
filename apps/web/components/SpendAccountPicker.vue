<script setup lang="ts">
import { canSpend, preselectedAccount, type SpendAccount, type SpendWallet } from '~/utils/spend-choice'

const props = defineProps<{
  wallet: SpendWallet
  busy?: boolean
  error?: string
}>()

const emit = defineEmits<{ choose: [account: SpendAccount] }>()

const { t } = useI18n()

const selected = ref<SpendAccount>(preselectedAccount(props.wallet))

function formatMoney(value: number | string): string {
  return Number(value).toLocaleString('en-ET', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

const options = computed(() => [
  {
    account: 'REAL' as const,
    label: t('providers.realBalance'),
    amount: props.wallet.realBalance,
    note: null,
  },
  {
    account: 'BONUS' as const,
    label: t('providers.bonusBalance'),
    amount: props.wallet.bonusBalance,
    note: t('providers.bonusWinsNote'),
  },
])
</script>

<template>
  <div class="spend-picker" role="dialog" aria-modal="false" aria-labelledby="spend-picker-title">
    <h2 id="spend-picker-title" class="spend-picker-title">{{ t('providers.playWith') }}</h2>

    <div class="spend-picker-options" role="radiogroup" :aria-labelledby="'spend-picker-title'">
      <button
        v-for="opt in options"
        :key="opt.account"
        type="button"
        role="radio"
        class="spend-option"
        :class="{
          'spend-option--active': selected === opt.account,
          'spend-option--bonus': opt.account === 'BONUS',
        }"
        :aria-checked="selected === opt.account"
        :disabled="busy || !canSpend(wallet, opt.account)"
        @click="selected = opt.account"
      >
        <span class="spend-option-label">{{ opt.label }}</span>
        <span class="spend-option-amount">
          {{ canSpend(wallet, opt.account) ? `${formatMoney(opt.amount)} ETB` : t('providers.emptyBalance') }}
        </span>
        <span v-if="opt.note" class="spend-option-note">{{ opt.note }}</span>
      </button>
    </div>

    <p v-if="error" class="spend-picker-error" role="alert">{{ error }}</p>

    <button type="button" class="spend-picker-start" :disabled="busy" @click="emit('choose', selected)">
      {{ busy ? t('providers.launching') : t('providers.startGame') }}
    </button>
  </div>
</template>

<style scoped>
.spend-picker {
  position: relative;
  z-index: 1;
  width: min(360px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border-radius: var(--radius-md, 12px);
  background: var(--surface-raised, rgba(12, 34, 72, 0.9));
  border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.1));
  font-family: var(--font-ui, 'Nunito', sans-serif);
  color: var(--text-primary, #fff);
}

.spend-picker-title {
  margin: 0;
  font-size: 17px;
  font-weight: 800;
  text-align: center;
}

.spend-picker-options {
  display: grid;
  gap: 10px;
}

.spend-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 14px 16px;
  min-height: 64px;
  border-radius: var(--radius-md, 12px);
  border: 1.5px solid var(--surface-border, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.spend-option--active {
  border-color: var(--brand-primary, #f59e0b);
  background: color-mix(in srgb, var(--brand-primary, #f59e0b) 12%, transparent);
}

.spend-option:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.spend-option:focus-visible,
.spend-picker-start:focus-visible {
  outline: 2px solid var(--brand-primary, #f59e0b);
  outline-offset: 2px;
}

.spend-option-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary, rgba(200, 215, 240, 0.75));
}

.spend-option-amount {
  font-size: 18px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.spend-option--bonus .spend-option-amount {
  color: var(--brand-primary, #f59e0b);
}

.spend-option-note {
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-secondary, rgba(200, 215, 240, 0.75));
}

.spend-picker-error {
  margin: 0;
  font-size: 13px;
  color: #f87171;
  text-align: center;
}

.spend-picker-start {
  min-height: 44px;
  border: none;
  border-radius: 8px;
  background: var(--brand-primary, #f59e0b);
  color: #0a0f1a;
  font: inherit;
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
}

.spend-picker-start:disabled {
  opacity: 0.6;
  cursor: progress;
}
</style>
