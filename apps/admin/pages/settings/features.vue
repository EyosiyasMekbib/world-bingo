<script setup lang="ts">
const { getFeatureFlags, updateFeatureFlags, getGameSettings, updateGameSettings, getGameTemplates } = useAdminApi()
const toast = useToast()

const loading = ref(true)
const saving = ref(false)
const savingGame = ref(false)

const features = reactive({
  feature_referrals: false,
  feature_tournaments: false,
  feature_third_party_games: false,
})

const gameSettings = reactive({
  ball_interval_secs: 3,
  bot_max_spend_etb: 500,
  first_deposit_bonus_amount: 0,
  featured_template_id: '__NONE__',
})

const templates = ref<{ id: string; title: string; active: boolean }[]>([])

const fetchAll = async () => {
  loading.value = true
  try {
    const [flags, gs, tmpl] = await Promise.all([getFeatureFlags(), getGameSettings(), getGameTemplates()])
    features.feature_referrals = flags.feature_referrals ?? false
    features.feature_tournaments = flags.feature_tournaments ?? false
    features.feature_third_party_games = flags.feature_third_party_games ?? false
    gameSettings.ball_interval_secs = gs.ball_interval_secs ?? 3
    gameSettings.bot_max_spend_etb = gs.bot_max_spend_etb ?? 500
    gameSettings.first_deposit_bonus_amount = gs.first_deposit_bonus_amount ?? 0
    gameSettings.featured_template_id = gs.featured_template_id ?? '__NONE__'
    templates.value = Array.isArray(tmpl) ? tmpl.filter((t: any) => t.active) : []
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load settings', color: 'error' })
  } finally {
    loading.value = false
  }
}

const saveFlags = async () => {
  saving.value = true
  try {
    await updateFeatureFlags({ ...features })
    toast.add({ title: 'Saved ✅', description: 'Feature flags updated successfully', color: 'success' })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to save feature flags', color: 'error' })
  } finally {
    saving.value = false
  }
}

const saveGameSettings = async () => {
  savingGame.value = true
  try {
    const result = await updateGameSettings({
      ball_interval_secs: gameSettings.ball_interval_secs,
      bot_max_spend_etb: gameSettings.bot_max_spend_etb,
      first_deposit_bonus_amount: gameSettings.first_deposit_bonus_amount,
      featured_template_id: gameSettings.featured_template_id === '__NONE__' ? null : gameSettings.featured_template_id,
    }) as any
    gameSettings.ball_interval_secs = result.ball_interval_secs
    gameSettings.bot_max_spend_etb = result.bot_max_spend_etb
    gameSettings.first_deposit_bonus_amount = result.first_deposit_bonus_amount
    gameSettings.featured_template_id = result.featured_template_id ?? '__NONE__'
    toast.add({ title: 'Saved ✅', description: 'Game settings updated successfully', color: 'success' })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to save game settings', color: 'error' })
  } finally {
    savingGame.value = false
  }
}

onMounted(fetchAll)
</script>

<template>
  <div class="space-y-8 max-w-2xl">
    <div>
      <h1 class="text-2xl font-bold text-white tracking-tight">System Configuration</h1>
      <p class="text-sm text-white/50 mt-0.5 font-medium">Manage global game settings and active features</p>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" />
      Loading…
    </div>

    <template v-else>
      <!-- ── Game Settings ── -->
      <div class="space-y-4">
        <h2 class="text-base font-bold text-white flex items-center gap-2">
          <UIcon name="i-heroicons:cog-6-tooth" class="w-5 h-5 text-yellow-500" />
          Game Engine
        </h2>

        <div
          class="rounded-2xl border border-(--surface-border) p-5 shadow-lg"
          style="background: var(--surface-raised);"
        >
          <div class="flex items-start gap-4 mb-4">
            <div class="p-3 rounded-xl border border-yellow-500/20 shrink-0" style="background:var(--surface-overlay);">
              <UIcon name="i-heroicons:clock" class="w-6 h-6 text-yellow-500" />
            </div>
            <div class="flex-1">
              <p class="text-sm font-bold text-white">Ball Interval</p>
              <p class="text-xs text-white/40 mt-1 font-medium leading-relaxed">Adjust the speed of ball calling transitions during active bingo sessions.</p>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <div class="flex items-center gap-2 flex-1">
              <UInput
                v-model.number="gameSettings.ball_interval_secs"
                type="number"
                min="1"
                max="30"
                class="w-32"
              />
              <span class="text-sm text-white/40 font-medium lowercase">seconds</span>
            </div>
            <div class="flex items-center gap-2">
              <span
                class="text-[10px] px-2.5 py-1 rounded-full font-bold uppercase tracking-wider"
                :class="gameSettings.ball_interval_secs <= 3 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : gameSettings.ball_interval_secs <= 8 ? 'bg-yellow-500/10 text-yellow-500 border border-yellow-500/20' : 'bg-red-500/10 text-red-500 border border-red-500/20'"
              >
                {{ gameSettings.ball_interval_secs <= 3 ? 'Fast' : gameSettings.ball_interval_secs <= 8 ? 'Normal' : 'Slow' }}
              </span>
            </div>
          </div>

          <!-- Bot Max Spend -->
          <div class="flex items-start gap-4 mt-5 pt-5 border-t border-white/8">
            <div class="p-3 rounded-xl border border-yellow-500/20 shrink-0" style="background:var(--surface-overlay);">
              <UIcon name="i-heroicons:cpu-chip" class="w-6 h-6 text-yellow-500" />
            </div>
            <div class="flex-1">
              <p class="text-sm font-bold text-white">Global Bot Max Spend (ETB)</p>
              <p class="text-xs text-white/40 mt-1 font-medium leading-relaxed">Maximum ETB a single bot can spend across all games. Can be overridden per template.</p>
              <div class="flex items-center gap-2 mt-3">
                <UInput
                  v-model.number="gameSettings.bot_max_spend_etb"
                  type="number"
                  min="0"
                  class="w-36"
                />
                <span class="text-sm text-white/40 font-medium">ETB</span>
              </div>
            </div>
          </div>

          <!-- First Deposit Bonus -->
          <div class="flex items-start gap-4 mt-5 pt-5 border-t border-white/8">
            <div class="p-3 rounded-xl border border-yellow-500/20 shrink-0" style="background:var(--surface-overlay);">
              <UIcon name="i-heroicons:gift" class="w-6 h-6 text-yellow-500" />
            </div>
            <div class="flex-1">
              <p class="text-sm font-bold text-white">First Deposit Bonus (ETB)</p>
              <p class="text-xs text-white/40 mt-1 font-medium leading-relaxed">Bonus credited to player's bonus balance on their first approved deposit. Set to 0 to disable.</p>
              <div class="flex items-center gap-2 mt-3">
                <UInput
                  v-model.number="gameSettings.first_deposit_bonus_amount"
                  type="number"
                  min="0"
                  class="w-36"
                />
                <span class="text-sm text-white/40 font-medium">ETB</span>
              </div>
            </div>
          </div>

          <!-- Featured Hero Game -->
          <div class="flex items-start gap-4 mb-4 mt-4 pt-4 border-t border-white/10">
            <div class="p-3 rounded-xl border border-amber-500/20 shrink-0" style="background:var(--surface-overlay);">
              <UIcon name="i-heroicons:star" class="w-6 h-6 text-amber-400" />
            </div>
            <div class="flex-1">
              <p class="text-sm font-bold text-white">Featured Hero Game</p>
              <p class="text-xs text-white/40 mt-1 font-medium leading-relaxed">Select a game template to feature in the home page hero banner. Leave empty to show the default bingo card art.</p>
              <div class="mt-3">
                <USelect
                  v-model="gameSettings.featured_template_id"
                  :items="[{ label: '— None (default art) —', value: '__NONE__' }, ...templates.map(t => ({ label: t.title, value: t.id }))]"
                  class="w-72"
                  placeholder="Select a template…"
                />
              </div>
            </div>
          </div>

          <div class="flex justify-end mt-4">
            <UButton
              color="primary"
              :loading="savingGame"
              icon="i-heroicons:check"
              size="sm"
              @click="saveGameSettings"
            >
              Save
            </UButton>
          </div>
        </div>
      </div>

      <!-- ── Feature Flags ── -->
      <div class="space-y-4">
        <h2 class="text-base font-bold text-white flex items-center gap-2">
          <UIcon name="i-heroicons:beaker" class="w-5 h-5 text-cyan-400" />
          Experimental Features
        </h2>

        <div class="space-y-3">
          <!-- Refer & Earn -->
          <div
            class="flex items-center justify-between rounded-2xl border border-(--surface-border) p-5 hover:border-yellow-500/30 transition-all shadow-md"
            style="background: var(--surface-raised);"
          >
            <div class="flex items-center gap-4">
              <div class="p-2.5 rounded-xl border border-yellow-500/20" style="background:var(--surface-overlay);">
                <UIcon name="i-heroicons:gift" class="w-5 h-5 text-yellow-500" />
              </div>
              <div>
                <p class="text-sm font-bold text-white">Referral System</p>
                <p class="text-xs text-white/40 mt-1 font-medium">Enable rewards and bonuses for player referrals</p>
              </div>
            </div>
            <USwitch v-model="features.feature_referrals" color="primary" />
          </div>

          <!-- Tournaments -->
          <div
            class="flex items-center justify-between rounded-2xl border border-(--surface-border) p-5 hover:border-yellow-500/30 transition-all shadow-md"
            style="background: var(--surface-raised);"
          >
            <div class="flex items-center gap-4">
              <div class="p-2.5 rounded-xl border border-yellow-500/20" style="background:var(--surface-overlay);">
                <UIcon name="i-heroicons:trophy" class="w-5 h-5 text-yellow-500" />
              </div>
              <div>
                <p class="text-sm font-bold text-white">Tournament Mode</p>
                <p class="text-xs text-white/40 mt-1 font-medium">Enable competitive tournament events across the platform</p>
              </div>
            </div>
            <USwitch v-model="features.feature_tournaments" color="primary" />
          </div>

          <!-- Third-Party Games -->
          <div
            class="flex items-center justify-between rounded-2xl border border-(--surface-border) p-5 hover:border-yellow-500/30 transition-all shadow-md"
            style="background: var(--surface-raised);"
          >
            <div class="flex items-center gap-4">
              <div class="p-2.5 rounded-xl border border-yellow-500/20" style="background:var(--surface-overlay);">
                <UIcon name="i-heroicons:puzzle-piece" class="w-5 h-5 text-yellow-500" />
              </div>
              <div>
                <p class="text-sm font-bold text-white">Third-Party Games</p>
                <p class="text-xs text-white/40 mt-1 font-medium">Show GASea slots, live casino, and crash games in the lobby</p>
              </div>
            </div>
            <USwitch v-model="features.feature_third_party_games" color="primary" />
          </div>
        </div>

        <!-- Save button -->
        <div class="flex justify-end pt-2">
          <UButton
            color="primary"
            :loading="saving"
            icon="i-heroicons-check"
            @click="saveFlags"
          >
            Save Changes
          </UButton>
        </div>
      </div>
    </template>
  </div>
</template>
