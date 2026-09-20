import type { AgentProfile } from './useAgentApi'

/**
 * The signed in agent's shop, float and daily counters. Shared state rather
 * than a per page fetch: the header and the counter screen show the same
 * numbers, and the float has to move the moment a deposit is fulfilled.
 */
export const useAgentProfile = () => {
  const api = useAgentApi()

  const profile = useState<AgentProfile | null>('agent_profile', () => null)
  const pending = useState<boolean>('agent_profile_pending', () => false)
  const error = useState<string | null>('agent_profile_error', () => null)

  const load = async () => {
    pending.value = true
    error.value = null
    try {
      profile.value = await api.getProfile()
    } catch (err) {
      error.value = apiErrorMessage(
        err,
        'Could not load your shop details. Check the connection and try again.',
      )
    } finally {
      pending.value = false
    }
  }

  /** Called after a fulfilment so the float on screen is the float the API just returned. */
  const applyFloat = (float: string) => {
    if (profile.value) profile.value = { ...profile.value, float }
  }

  const loadIfMissing = async () => {
    if (profile.value || pending.value) return
    await load()
  }

  return { profile, pending, error, load, loadIfMissing, applyFloat }
}
