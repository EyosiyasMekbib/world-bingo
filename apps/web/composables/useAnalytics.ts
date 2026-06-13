import { v4 as uuidv4 } from 'uuid'

const ALLOWED = new Set([
    'lobby_view',
    'game_view',
    'join_click',
    'deposit_modal_opened',
    'deposit_method_selected',
    'deposit_amount_entered',
    'identify',
])

interface RawEvent {
    name: string
    props?: Record<string, unknown> | null
}

interface QueuedEvent extends RawEvent {
    ts: number
}

let queue: QueuedEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

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
        if (!ALLOWED.has(name)) return
        queue.push({ name, props: props ?? null, ts: Date.now() })
        scheduleFlush()
    }

    const identify = () => {
        if (import.meta.server) return
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

    if (import.meta.client) {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush()
        })
    }

    return { track, identify, flush }
}
