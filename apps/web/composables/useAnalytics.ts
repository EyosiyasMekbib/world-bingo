import { v4 as uuidv4 } from 'uuid'
import type { PostHog } from 'posthog-js'
import { brandSlug, buildPersonProps } from '~/utils/posthog'

/**
 * Two sinks, one call.
 *
 * `track()` sends every event to PostHog (any name) AND, for names on the
 * allowlist below, to the custom `/events` endpoint that feeds the admin
 * analytics page. The allowlist only gates the second sink: a name missing
 * here still reaches PostHog, so a new event is never silently lost.
 */
const ALLOWED = new Set([
    'lobby_view',
    'games_lobby_view',
    'game_view',
    'join_click',
    'deposit_modal_opened',
    'deposit_method_selected',
    'deposit_amount_entered',
    'identify',
    'session_expired',
    'session_refresh_failed',
    'provider_game_view',
    'provider_session_ended',
    // Failure and timing events added 2026-09-08 (retention program, project 2).
    'login_failed',
    'register_failed',
    'deposit_checkout_redirect',
    'deposit_checkout_failed',
    'provider_launch_failed',
    'provider_game_loaded',
    // Kept in step with ALLOWED_EVENTS in apps/api/src/services/event.service.ts.
    // A name missing from either list is dropped by the /events sink (PostHog
    // still gets it).
    'hero_predictions_click',
    'lobby_predictions_click',
])

interface RawEvent {
    name: string
    props?: Record<string, unknown> | null
}

interface QueuedEvent extends RawEvent {
    ts: number
}

export interface IdentifiableUser {
    id: string
    serial: number
    telegramId?: string | null
    createdAt: Date | string
}

const queue: QueuedEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let visibilityBound = false

function getPosthog(): PostHog | null {
    try {
        return (useNuxtApp().$posthog as PostHog | null | undefined) ?? null
    } catch {
        return null
    }
}

function currentBrand(): string {
    try {
        const config = useRuntimeConfig()
        return brandSlug({
            brand: (config.public.posthog as { brand?: string } | undefined)?.brand,
            shortName: useBrand().value.shortName,
        })
    } catch {
        return ''
    }
}

// Fallback ids for when storage access throws (Safari/webview privacy modes
// raise a SecurityError on the `localStorage`/`sessionStorage` getter itself,
// not just on .getItem — merely wrapping the call site isn't enough, the
// property read has to be inside the try too). Regenerated per session since
// they can't be persisted; analytics still work, just without cross-visit
// continuity for that one browser.
let fallbackAnonId: string | null = null
let fallbackSessionId: string | null = null

function getAnonId(): string {
    if (import.meta.server) return ''
    try {
        let id = localStorage.getItem('wb_anon_id')
        if (!id) {
            id = uuidv4()
            localStorage.setItem('wb_anon_id', id)
        }
        return id
    } catch {
        return (fallbackAnonId ??= uuidv4())
    }
}

function getSessionId(): string {
    if (import.meta.server) return ''
    try {
        let id = sessionStorage.getItem('wb_session_id')
        if (!id) {
            id = uuidv4()
            sessionStorage.setItem('wb_session_id', id)
        }
        return id
    } catch {
        return (fallbackSessionId ??= uuidv4())
    }
}

async function flush() {
    if (!queue.length) return
    const batch = queue.splice(0)
    const config = useRuntimeConfig()
    const anonId = getAnonId()
    const sessionId = getSessionId()
    const payload = JSON.stringify({
        events: batch.map(e => ({ name: e.name, props: e.props ?? null })),
        anonId,
        sessionId,
    })
    const url = `${config.public.apiBase}/events`

    try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
            const sent = navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }))
            if (!sent) throw new Error('sendBeacon failed')
        } else {
            await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: payload,
                keepalive: true,
            })
        }
    } catch {
        // swallow — telemetry must never break the app
    }
}

function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
        flushTimer = null
        flush()
    }, 5000)
}

export const useAnalytics = () => {
    /**
     * `instant`: send now instead of batching. Use for an event tracked right
     * before the page navigates away (a checkout redirect): the batched
     * queue never got flushed and 0 of 174 checkout redirects arrived.
     */
    const track = (name: string, props?: Record<string, unknown> | null, opts?: { instant?: boolean }) => {
        if (import.meta.server) return
        const ph = getPosthog()
        if (ph) {
            try {
                if (opts?.instant) ph.capture(name, props ?? undefined, { send_instantly: true })
                else ph.capture(name, props ?? undefined)
            } catch {
                // never let analytics throw into the UI
            }
        }
        if (!ALLOWED.has(name)) return
        queue.push({ name, props: props ?? null, ts: Date.now() })
        if (opts?.instant) void flush()
        else scheduleFlush()
    }

    /**
     * Call after login / register / Telegram login. Links the anonymous trail
     * to the player in both sinks. Safe to call with no user: the /events link
     * still goes out, PostHog is skipped.
     */
    const identify = (user?: IdentifiableUser | null) => {
        if (import.meta.server) return
        const ph = getPosthog()
        if (ph && user) {
            try {
                ph.identify(user.id, buildPersonProps(user, currentBrand()))
            } catch {
                // ignore
            }
        }
        const config = useRuntimeConfig()
        const anonId = getAnonId()
        const sessionId = getSessionId()
        const url = `${config.public.apiBase}/events/identify`
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ anonId, sessionId }),
        }).catch(() => {})
    }

    /**
     * Call on logout. Forgets the PostHog person AND rotates the anonymous id,
     * so the next account on a shared phone does not inherit this trail.
     */
    const reset = () => {
        if (import.meta.server) return
        const ph = getPosthog()
        if (ph) {
            try {
                ph.reset()
            } catch {
                // ignore
            }
        }
        fallbackAnonId = null
        fallbackSessionId = null
        try {
            localStorage.removeItem('wb_anon_id')
            sessionStorage.removeItem('wb_session_id')
        } catch {
            // storage may be unavailable
        }
    }

    if (import.meta.client && !visibilityBound) {
        visibilityBound = true
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush()
        })
    }

    return { track, identify, reset, flush }
}
