/**
 * PostHog reverse proxy. Replaces the `/ingest/static/**` + `/ingest/**` route
 * rules, which leaked the player's `auth` cookie (JWT access + refresh token and
 * the full user record) to PostHog on every event and replay batch — h3's
 * `getProxyRequestHeaders` forwards `cookie`, and the persisted Pinia auth store
 * lives in a same-site cookie that rides along on every same-origin request.
 *
 * `sendProxy` is used rather than `proxyRequest` on purpose: `proxyRequest`
 * merges `getProxyRequestHeaders(event)` into whatever headers it is given, so
 * the stripped headers would come straight back. `sendProxy` sends only what it
 * is handed — which also means the request body is ours to forward.
 *
 * Everything here is inert when PostHog is unconfigured: with an empty
 * NUXT_PUBLIC_POSTHOG_KEY the browser plugin never initialises, so nothing ever
 * calls `/ingest`.
 */
import { resolveIngestTarget, stripSensitiveHeaders } from '../../../utils/posthog-proxy'

/** h3's own list: the methods whose body is worth reading. */
const PAYLOAD_METHODS = new Set(['PATCH', 'POST', 'PUT', 'DELETE'])

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const target = resolveIngestTarget(event.path, {
    ingest: config.posthogProxyTarget,
    assets: config.posthogAssetsProxyTarget,
  })

  const headers = stripSensitiveHeaders(getProxyRequestHeaders(event))
  const raw = PAYLOAD_METHODS.has(event.method)
    ? await readRawBody(event, false).catch(() => undefined)
    : undefined
  // readRawBody hands back a Node Buffer, whose type is Buffer<ArrayBufferLike>.
  // BodyInit only accepts ArrayBufferView<ArrayBuffer>, so neither the Buffer nor
  // a zero-copy view over its (ArrayBufferLike) backing store satisfies it —
  // copying into a fresh Uint8Array does. Ingest payloads are small; the copy is
  // nothing next to the network hop.
  const body = raw ? new Uint8Array(raw) : undefined

  return sendProxy(event, target, {
    fetchOptions: { method: event.method, body, headers },
  })
})
