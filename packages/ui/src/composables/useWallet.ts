import { ref, computed } from 'vue'

export interface WalletTransaction {
  id: string
  type: string
  amount: number
  status: string
  note?: string
  createdAt: string
}

export function useWallet(apiBase: string) {
  const balance = ref(0)
  const transactions = ref<WalletTransaction[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchWallet() {
    loading.value = true
    error.value = null
    try {
      const res = await fetch(`${apiBase}/wallet`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch wallet')
      const data = await res.json()
      balance.value = data.balance
      transactions.value = data.transactions ?? []
    } catch (err: any) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function deposit(payload: { amount: number; receiptUrl: string }) {
    const res = await fetch(`${apiBase}/wallet/deposit`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error((await res.json()).message ?? 'Deposit failed')
    return res.json()
  }

  async function withdraw(payload: { amount: number }) {
    const res = await fetch(`${apiBase}/wallet/withdraw`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error((await res.json()).message ?? 'Withdrawal failed')
    return res.json()
  }

  return { balance, transactions, loading, error, fetchWallet, deposit, withdraw }
}
