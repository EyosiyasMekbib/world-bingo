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

function getAnonId(): string {
    if (import.meta.server) return ''
    let id = localStorage.getItem('wb_anon_id')
    if (!id) {
        id = uuidv4()
        localStorage.setItem('wb_anon_id', id)
    }
    return id
}

function getSessionId(): string {
    if (import.meta.server) return ''
    let id = sessionStorage.getItem('wb_session_id')
    if (!id) {
        id = uuidv4()
        sessionStorage.setItem('wb_session_id', id)
    }
    return id
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
    const track = (name: string, props?: Record<string, unknown> | null) => {
        if (import.meta.server) return
        const ph = getPosthog()
        if (ph) {
            try {
                ph.capture(name, props ?? undefined)
            } catch {
                // never let analytics throw into the UI
            }
        }
        if (!ALLOWED.has(name)) return
        queue.push({ name, props: props ?? null, ts: Date.now() })
        scheduleFlush()
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
