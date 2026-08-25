<script setup lang="ts">
import { resolveTheme } from '@world-bingo/shared-types'
import { shells, pickShell } from '~/theme/shells'

const route = useRoute()
const brand = useBrand()
const { auth, showDeposit, showWithdrawal } = useAppShell()

// Exactly one caller, by contract — see the comment on useShellBootstrap.
useShellBootstrap()

const shell = computed(() =>
  pickShell(shells, resolveTheme(brand.value.themeId).id, route.meta.shell),
)
</script>

<template>
  <component :is="shell">
    <slot />
  </component>

  <DepositModal v-model="showDeposit" @deposited="auth.fetchWallet(); showDeposit = false" />
  <WithdrawalModal
    v-model="showWithdrawal"
    :balance="Number(auth.wallet?.realBalance ?? 0)"
    @withdrawn="auth.fetchWallet(); showWithdrawal = false"
  />
  <SupportLauncher />
</template>
