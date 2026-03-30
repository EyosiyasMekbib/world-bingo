/**
 * Composable that exposes admin-controlled feature flags.
 *
 * Flags are fetched once from GET /settings/features and cached
 * in a Pinia-like shared state via useState so every component
 * reads the same reactive object without redundant requests.
 */
export interface FeatureFlags {
  feature_referrals: boolean
  feature_tournaments: boolean
  feature_third_party_games: boolean
  [key: string]: boolean
}

export const useFeatureFlags = () => {
  const config = useRuntimeConfig()

  const flags = useState<FeatureFlags>('feature-flags', () => ({
    feature_referrals: false,
    feature_tournaments: false,
    feature_third_party_games: false,
  }))

  const loaded = useState<boolean>('feature-flags-loaded', () => false)
  const loading = useState<boolean>('feature-flags-loading', () => false)

  const fetchFlags = async () => {
    if (loading.value) return
    loading.value = true
    try {
      const data = await $fetch<FeatureFlags>(`${config.public.apiBase}/settings/features`)
      flags.value = { ...flags.value, ...data }
      loaded.value = true
    } catch {
      // If the API is unreachable, keep defaults (all disabled)
    } finally {
      loading.value = false
    }
  }

  // Auto-fetch on first use
  if (!loaded.value && !loading.value) {
    fetchFlags()
  }

  return {
    flags,
    loaded,
    fetchFlags,
    /** Shorthand getters */
    referralsEnabled: computed(() => flags.value.feature_referrals),
    tournamentsEnabled: computed(() => flags.value.feature_tournaments),
    thirdPartyGamesEnabled: computed(() => flags.value.feature_third_party_games),
  }
}
