/**
 * Composable that exposes admin-controlled feature flags.
 *
 * Flags are fetched once from GET /settings/features and shared through
 * `useAsyncData`, so every component reads the same reactive object without
 * redundant requests.
 *
 * WHY useAsyncData AND NOT A FIRE-AND-FORGET FETCH. The previous version called
 * an un-awaited `fetchFlags()` during setup. On the server that returned
 * immediately, so SSR rendered with the defaults — every flag false — and
 * whether the real values arrived before the payload was serialized was a race.
 * The visible symptom was a flag-gated nav item rendering its disabled branch on
 * one load and its enabled branch on the next, with no code change between them.
 *
 * `useAsyncData` makes Nuxt await the request during SSR and ships the result in
 * the payload, so the server and the client agree on the first paint. Keyed
 * shared state means it runs once per request, not once per component.
 */
export interface FeatureFlags {
  feature_referrals: boolean
  feature_tournaments: boolean
  feature_third_party_games: boolean
  [key: string]: boolean
}

const DEFAULT_FLAGS: FeatureFlags = {
  feature_referrals: false,
  feature_tournaments: false,
  feature_third_party_games: false,
}

export const useFeatureFlags = () => {
  const config = useRuntimeConfig()

  const { data, status, refresh } = useAsyncData<FeatureFlags>(
    'feature-flags',
    async () => {
      try {
        const fetched = await $fetch<FeatureFlags>(
          `${config.public.apiBase}/settings/features`,
        )
        return { ...DEFAULT_FLAGS, ...fetched }
      } catch {
        // An unreachable API must read as "everything off", never as an error
        // that blanks the page — a flag is an enhancement, not a dependency.
        return { ...DEFAULT_FLAGS }
      }
    },
    { default: () => ({ ...DEFAULT_FLAGS }) },
  )

  const flags = computed<FeatureFlags>(() => data.value ?? { ...DEFAULT_FLAGS })

  /**
   * True once the request has settled either way. Consumers that redirect on a
   * disabled flag must wait for this — flags read false while in flight, and
   * bouncing the player home on a slow request would make the feature look
   * broken rather than disabled.
   */
  const loaded = computed(() => status.value === 'success' || status.value === 'error')

  return {
    flags,
    loaded,
    fetchFlags: refresh,
    /** Shorthand getters */
    referralsEnabled: computed(() => flags.value.feature_referrals),
    tournamentsEnabled: computed(() => flags.value.feature_tournaments),
    thirdPartyGamesEnabled: computed(() => flags.value.feature_third_party_games),
  }
}
