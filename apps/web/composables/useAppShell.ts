import { useAuthStore } from '~/store/auth'

type Money = number | string | null | undefined

/** Total wallet balance, formatted for display. Pure — no Nuxt runtime needed. */
export function formatBalance(realBalance: Money, bonusBalance: Money): string {
  const total = Number(realBalance ?? 0) + Number(bonusBalance ?? 0)
  return total.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Shared chrome state for the layout shells. Every theme's shell renders the
 * same data through this composable, so adding a theme never duplicates wiring.
 *
 * Deliberately side-effect free: the layout dispatcher AND the active shell both
 * call this, so registering onMounted here would fire every effect twice. Mount
 * effects live in useShellBootstrap, which the dispatcher calls exactly once.
 */
export function useAppShell() {
  const auth = useAuthStore()
  const router = useRouter()
  const { locale, setLocale } = useI18n()
  const { referralsEnabled, flags } = useFeatureFlags()
  const { openChat } = useSupport()

  // useState, not ref: the Deposit/Withdraw buttons live inside a shell while the
  // modals are rendered by the layout dispatcher, so the flags must be shared.
  const showDeposit = useState<boolean>('shell-deposit-open', () => false)
  const showWithdrawal = useState<boolean>('shell-withdrawal-open', () => false)

  const mobileNavOpen = ref(false)
  const search = ref('')

  const predictionsEnabled = computed(() => flags.value.feature_prediction_market === true)

  const formattedBalance = computed(() =>
    formatBalance(auth.wallet?.realBalance, auth.wallet?.bonusBalance),
  )

  const playerId = computed(() => auth.user?.serial ?? '—')

  const toggleLocale = () => setLocale(locale.value === 'en' ? 'am' : 'en')

  function submitSearch() {
    const q = search.value.trim()
    if (q) navigateTo(`/search?q=${encodeURIComponent(q)}`)
  }

  async function handleLogout() {
    await (auth as any).logout()
    await router.push('/auth/login')
  }

  return {
    auth,
    locale,
    showDeposit,
    showWithdrawal,
    mobileNavOpen,
    search,
    predictionsEnabled,
    referralsEnabled,
    formattedBalance,
    playerId,
    toggleLocale,
    submitSearch,
    handleLogout,
    openChat,
  }
}

/**
 * Mount-time side effects for the shell. Call this from the layout dispatcher
 * and nowhere else — useAppShell is called by both the dispatcher and the active
 * shell, so anything registered there would run twice and fire a duplicate
 * fetchWallet on every page load. (connect() self-guards on an open socket;
 * fetchWallet does not.)
 */
export function useShellBootstrap() {
  const auth = useAuthStore()
  const { connect } = useSocket()

  onMounted(async () => {
    if (auth.isAuthenticated) {
      await auth.fetchWallet()
      connect()
    }
  })

  watch(
    () => auth.isAuthenticated,
    (val) => {
      if (val) connect()
    },
  )
}
