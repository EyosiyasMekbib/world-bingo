import { useAuthStore } from '../store/auth'

export const useAuth = () => {
  const store = useAuthStore()
  return store
}
