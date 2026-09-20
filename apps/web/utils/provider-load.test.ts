import { describe, it, expect } from 'vitest'
import {
  SLOW_AFTER_MS,
  TIMEOUT_AFTER_MS,
  canDismiss,
  crossedReady,
  crossedTimeout,
  elapsedSeconds,
  initialLoadState,
  reduceLoad,
  showsOverlay,
  type LoadEvent,
  type LoadState,
} from './provider-load'

const run = (events: LoadEvent[], start = 0): LoadState =>
  events.reduce(reduceLoad, initialLoadState(start))

describe('reduceLoad', () => {
  it('launches, loads when the URL arrives, and is ready on the frame load', () => {
    const s0 = initialLoadState(0)
    expect(s0.phase).toBe('launching')
    const s1 = reduceLoad(s0, { type: 'url', now: 900 })
    expect(s1).toMatchObject({ phase: 'loading', urlAt: 900 })
    const s2 = reduceLoad(s1, { type: 'frame_loaded', now: 4000 })
    expect(s2).toMatchObject({ phase: 'ready', loadedAt: 4000 })
    expect(crossedReady(s1, s2)).toBe(true)
  })

  it('turns slow at SLOW_AFTER_MS and times out at TIMEOUT_AFTER_MS, flagging the timeout once', () => {
    const loading = run([{ type: 'url', now: 1000 }])
    const slow = reduceLoad(loading, { type: 'tick', now: SLOW_AFTER_MS })
    expect(slow.phase).toBe('slow')
    const timedOut = reduceLoad(slow, { type: 'tick', now: TIMEOUT_AFTER_MS })
    expect(timedOut).toMatchObject({ phase: 'timeout', timedOut: true })
    expect(crossedTimeout(slow, timedOut)).toBe(true)
    const later = reduceLoad(timedOut, { type: 'tick', now: TIMEOUT_AFTER_MS + 5000 })
    expect(crossedTimeout(timedOut, later)).toBe(false)
  })

  it('times out while still launching when the api itself is slow', () => {
    expect(run([{ type: 'tick', now: TIMEOUT_AFTER_MS }])).toMatchObject({
      phase: 'timeout',
      urlAt: null,
      timedOut: true,
    })
  })

  it('still becomes ready if the frame loads after the timeout', () => {
    const s = run([
      { type: 'url', now: 2000 },
      { type: 'tick', now: TIMEOUT_AFTER_MS },
      { type: 'frame_loaded', now: TIMEOUT_AFTER_MS + 3000 },
    ])
    expect(s).toMatchObject({ phase: 'ready', timedOut: true })
  })

  it('keeps a launch-stage timeout when the URL arrives late, without re-flagging it', () => {
    const timedOut = run([{ type: 'tick', now: TIMEOUT_AFTER_MS }])
    const withUrl = reduceLoad(timedOut, { type: 'url', now: TIMEOUT_AFTER_MS + 100 })
    expect(withUrl).toMatchObject({ phase: 'timeout', urlAt: TIMEOUT_AFTER_MS + 100 })
    expect(crossedTimeout(timedOut, withUrl)).toBe(false)
  })

  it('ignores a frame load before any URL, and every event after ready', () => {
    expect(reduceLoad(initialLoadState(0), { type: 'frame_loaded', now: 10 }).phase).toBe(
      'launching',
    )
    const ready = run([
      { type: 'url', now: 1 },
      { type: 'frame_loaded', now: 2 },
    ])
    expect(reduceLoad(ready, { type: 'tick', now: TIMEOUT_AFTER_MS })).toBe(ready)
    expect(reduceLoad(ready, { type: 'frame_loaded', now: 99 })).toBe(ready)
  })

  it('records a launch failure as an error', () => {
    expect(
      run([{ type: 'launch_failed', message: 'This game could not be started' }]),
    ).toMatchObject({
      phase: 'error',
      error: 'This game could not be started',
    })
  })

  it('retry starts a fresh attempt with a new clock', () => {
    const timedOut = run([
      { type: 'url', now: 1000 },
      { type: 'tick', now: TIMEOUT_AFTER_MS },
    ])
    expect(reduceLoad(timedOut, { type: 'retry', now: 30_000 })).toEqual({
      phase: 'launching',
      attempt: 2,
      startedAt: 30_000,
      urlAt: null,
      loadedAt: null,
      timedOut: false,
      error: null,
    })
  })
})

// Some providers' frames never fire `load` although the game is playable.
describe('dismissing the load overlay', () => {
  const slow = run([
    { type: 'url', now: 1000 },
    { type: 'tick', now: SLOW_AFTER_MS },
  ])
  const timedOut = reduceLoad(slow, { type: 'tick', now: TIMEOUT_AFTER_MS })

  it('can be dismissed once the load is slow or timed out and a URL exists', () => {
    expect(canDismiss(slow)).toBe(true)
    expect(canDismiss(timedOut)).toBe(true)
    const fromSlow = reduceLoad(slow, { type: 'dismiss' })
    expect(fromSlow).toMatchObject({ phase: 'dismissed', urlAt: 1000, loadedAt: null })
    expect(showsOverlay(fromSlow)).toBe(false)
    expect(reduceLoad(timedOut, { type: 'dismiss' })).toMatchObject({
      phase: 'dismissed',
      timedOut: true,
    })
  })

  it('cannot be dismissed before a URL exists or before the load turns slow', () => {
    const launchTimeout = run([{ type: 'tick', now: TIMEOUT_AFTER_MS }])
    expect(canDismiss(launchTimeout)).toBe(false)
    expect(reduceLoad(launchTimeout, { type: 'dismiss' })).toBe(launchTimeout)
    const loading = run([{ type: 'url', now: 1000 }])
    expect(canDismiss(loading)).toBe(false)
    expect(reduceLoad(loading, { type: 'dismiss' })).toBe(loading)
  })

  it('stays dismissed through ticks, a late launch failure and a second dismiss', () => {
    const dismissed = reduceLoad(slow, { type: 'dismiss' })
    expect(reduceLoad(dismissed, { type: 'tick', now: TIMEOUT_AFTER_MS + 60_000 })).toBe(dismissed)
    expect(reduceLoad(dismissed, { type: 'launch_failed', message: 'late' })).toBe(dismissed)
    expect(reduceLoad(dismissed, { type: 'dismiss' })).toBe(dismissed)
  })

  it('still records a frame load that arrives after the dismissal', () => {
    const dismissed = reduceLoad(timedOut, { type: 'dismiss' })
    const ready = reduceLoad(dismissed, { type: 'frame_loaded', now: 90_000 })
    expect(ready).toMatchObject({ phase: 'ready', loadedAt: 90_000 })
    expect(crossedReady(dismissed, ready)).toBe(true)
  })
})

describe('showsOverlay', () => {
  it('covers the frame only while the load is still waiting', () => {
    for (const phase of ['launching', 'loading', 'slow', 'timeout'] as const) {
      expect(showsOverlay({ ...initialLoadState(0), phase })).toBe(true)
    }
    for (const phase of ['ready', 'error', 'dismissed'] as const) {
      expect(showsOverlay({ ...initialLoadState(0), phase })).toBe(false)
    }
  })
})

describe('elapsedSeconds', () => {
  it('counts whole seconds since this attempt started, never negative', () => {
    expect(elapsedSeconds(initialLoadState(1000), 6999)).toBe(5)
    expect(elapsedSeconds(initialLoadState(1000), 500)).toBe(0)
  })
})
