/**
 * One provider-game load attempt, as a pure reducer over timestamps the page
 * passes in (performance.now()). Median load was 5.4 s and p90 17.9 s, and for
 * all of it the player saw a blank frame; this state drives a visible overlay,
 * a slow hint with retry, and a once-per-attempt timeout event.
 *
 * Some providers' frames never fire `load` although the game is playable
 * (sessions of 60-180 s+ with no provider_game_loaded), so a slow load with a
 * URL can also be `dismissed`: the overlay goes and the frame is left alone.
 */
export const SLOW_AFTER_MS = 8_000
export const TIMEOUT_AFTER_MS = 20_000

export type LoadPhase =
  | 'launching'
  | 'loading'
  | 'slow'
  | 'timeout'
  | 'ready'
  | 'error'
  | 'dismissed'

export interface LoadState {
  phase: LoadPhase
  /** 1-based; bumps on retry and keys the iframe so a retry replaces it. */
  attempt: number
  /** When this attempt's launch call started. */
  startedAt: number
  /** When the launch URL arrived; null while launching. */
  urlAt: number | null
  /** When the iframe fired `load`; null until ready. */
  loadedAt: number | null
  /** This attempt crossed TIMEOUT_AFTER_MS. Stays true even if it loads later. */
  timedOut: boolean
  error: string | null
}

export type LoadEvent =
  | { type: 'url'; now: number }
  | { type: 'frame_loaded'; now: number }
  | { type: 'launch_failed'; message: string }
  | { type: 'tick'; now: number }
  | { type: 'retry'; now: number }
  | { type: 'dismiss' }

const WAITING: readonly LoadPhase[] = ['launching', 'loading', 'slow', 'timeout']

/** The overlay covers the frame only while the load is still waiting. */
export function showsOverlay(state: LoadState): boolean {
  return WAITING.includes(state.phase)
}

/** "Show game anyway": once the load is slow, and only if there is a frame to show. */
export function canDismiss(state: LoadState): boolean {
  return (state.phase === 'slow' || state.phase === 'timeout') && state.urlAt !== null
}

export function initialLoadState(now: number): LoadState {
  return {
    phase: 'launching',
    attempt: 1,
    startedAt: now,
    urlAt: null,
    loadedAt: null,
    timedOut: false,
    error: null,
  }
}

function waitingPhase(state: LoadState, now: number): LoadPhase {
  const elapsed = now - state.startedAt
  if (elapsed >= TIMEOUT_AFTER_MS) return 'timeout'
  if (elapsed >= SLOW_AFTER_MS) return 'slow'
  return state.urlAt === null ? 'launching' : 'loading'
}

function settleWaiting(state: LoadState, now: number): LoadState {
  const phase = waitingPhase(state, now)
  const timedOut = state.timedOut || phase === 'timeout'
  if (phase === state.phase && timedOut === state.timedOut) return state
  return { ...state, phase, timedOut }
}

export function reduceLoad(state: LoadState, event: LoadEvent): LoadState {
  switch (event.type) {
    case 'retry':
      return { ...initialLoadState(event.now), attempt: state.attempt + 1 }
    case 'launch_failed':
      return WAITING.includes(state.phase)
        ? { ...state, phase: 'error', error: event.message }
        : state
    case 'url':
      if (!WAITING.includes(state.phase) || state.urlAt !== null) return state
      return settleWaiting({ ...state, urlAt: event.now }, event.now)
    case 'tick':
      return WAITING.includes(state.phase) ? settleWaiting(state, event.now) : state
    case 'dismiss':
      return canDismiss(state) ? { ...state, phase: 'dismissed' } : state
    case 'frame_loaded':
      // A frame `load` before any URL is the empty frame, not the game. One
      // after a dismissal still counts: the game did load, only late.
      if (state.urlAt === null) return state
      if (!WAITING.includes(state.phase) && state.phase !== 'dismissed') return state
      return { ...state, phase: 'ready', loadedAt: event.now }
  }
}

export function elapsedSeconds(state: LoadState, now: number): number {
  return Math.max(0, Math.floor((now - state.startedAt) / 1000))
}

/** True on the transition that should emit `provider_game_load_timeout`. */
export function crossedTimeout(prev: LoadState, next: LoadState): boolean {
  return !prev.timedOut && next.timedOut
}

/** True on the transition that should emit `provider_game_loaded`. */
export function crossedReady(prev: LoadState, next: LoadState): boolean {
  return prev.phase !== 'ready' && next.phase === 'ready'
}
