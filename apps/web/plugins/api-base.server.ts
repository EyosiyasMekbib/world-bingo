/**
 * Server-side plugin that replaces apiBase with the internal Docker hostname
 * when NUXT_API_BASE_SERVER is set. This allows SSR fetches to reach the API
 * container directly (http://api:8080) while the client still uses the public
 * URL (http://localhost:8080 or whatever is in NUXT_PUBLIC_API_BASE).
 */
export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const serverBase = config.apiBaseServer as string
  if (serverBase) {
    config.public.apiBase = serverBase
    config.public.wsUrl = serverBase
  }
})
