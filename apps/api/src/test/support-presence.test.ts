import { describe, it, expect, vi, beforeEach } from 'vitest'

const shiftMock = vi.hoisted(() => ({ anyOnShift: vi.fn() }))
vi.mock('../services/telegram/shift.service', () => shiftMock)

import { anyAgentOnline, AGENTS_ROOM } from '../services/support/presence'

function fakeIo(agentCount: number) {
  return { in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue(new Array(agentCount)) })) }
}

describe('anyAgentOnline', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is true when the socket room has an agent, without checking shift presence', async () => {
    const io = fakeIo(1)
    expect(await anyAgentOnline(io)).toBe(true)
    expect(io.in).toHaveBeenCalledWith(AGENTS_ROOM)
    expect(shiftMock.anyOnShift).not.toHaveBeenCalled()
  })

  it('falls back to Telegram shift presence when the room is empty', async () => {
    shiftMock.anyOnShift.mockResolvedValue(true)
    expect(await anyAgentOnline(fakeIo(0))).toBe(true)
  })

  it('is false when neither the room nor Telegram shift presence has anyone', async () => {
    shiftMock.anyOnShift.mockResolvedValue(false)
    expect(await anyAgentOnline(fakeIo(0))).toBe(false)
  })
})
