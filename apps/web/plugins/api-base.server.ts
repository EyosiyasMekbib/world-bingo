/**
 * Server-side plugin that intercepts $fetch calls during SSR so they reach the
 * API container via the internal Docker hostname (e.g. http://api:8080) while
 * the client-side config keeps the public URL (http://localhost:8080).
 *
 * IMPORTANT: We must NOT mutate config.public.apiBase because that value is
 * serialized into the SSR payload and sent to the browser. Mutating it causes
 * the browser to use the Docker-internal hostname, breaking all client-side
 * API calls (login, register, etc.).
 */
export default defineNuxtPlugin(() => {
  // No-op: the server-side base URL is handled via Nitro's built-in
  // routeRules or per-request options rather than mutating public config.
  // If you need SSR fetches to go through the internal hostname, use
  // `$fetch(url, { baseURL: useRuntimeConfig().apiBaseServer })` in
  // server-only composables or event handlers.
})
