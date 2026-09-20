import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisMock = vi.hoisted(() => ({ set: vi.fn() }))
vi.mock('../lib/redis', () => ({ default: redisMock }))

const configMock = vi.hoisted(() => ({
  webhookSecret: vi.fn(() => 'the-real-secret'),
  supportGroupId: vi.fn(() => '-1001111111111'),
}))
vi.mock('../gateways/telegram/config', () => configMock)

const playerHandlerMock = vi.hoisted(() => ({ handlePlayerMessage: vi.fn() }))
vi.mock('../services/telegram/player-handlers', () => playerHandlerMock)

const staffHandlerMock = vi.hoisted(() => ({ handleStaffGroupMessage: vi.fn() }))
vi.mock('../services/telegram/staff-handlers', () => staffHandlerMock)

import Fastify from 'fastify'
import { processUpdate } from '../routes/telegram/webhook'
import telegramWebhookRoute from '../routes/telegram/webhook'

function privateMessage(overrides: Partial<{ update_id: number }> = {}) {
  return {
    update_id: overrides.update_id ?? 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 555, type: 'private' as const },
      from: { id: 555, is_bot: false },
      text: 'hello',
    },
  }
}

function groupMessage(chatId: number, update_id = 2) {
  return {
    update_id,
    message: {
      message_id: 1,
      date: 0,
      message_thread_id: 42,
      chat: { id: chatId, type: 'supergroup' as const },
      from: { id: 999, is_bot: false },
      text: '/queue',
    },
  }
}

describe('processUpdate — dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.set.mockResolvedValue('OK') // first delivery, by default
  })

  it('routes a private-chat message to handlePlayerMessage', async () => {
    const update = privateMessage()
    await processUpdate(update as never)
    expect(playerHandlerMock.handlePlayerMessage).toHaveBeenCalledWith(update.message)
    expect(staffHandlerMock.handleStaffGroupMessage).not.toHaveBeenCalled()
  })

  it('routes a message from the configured staff group to handleStaffGroupMessage', async () => {
    const update = groupMessage(-1001111111111)
    await processUpdate(update as never)
    expect(staffHandlerMock.handleStaffGroupMessage).toHaveBeenCalledWith(update.message)
    expect(playerHandlerMock.handlePlayerMessage).not.toHaveBeenCalled()
  })

  it('ignores a group message from a chat that is not the configured staff group', async () => {
    const update = groupMessage(-999999)
    await processUpdate(update as never)
    expect(staffHandlerMock.handleStaffGroupMessage).not.toHaveBeenCalled()
    expect(playerHandlerMock.handlePlayerMessage).not.toHaveBeenCalled()
  })

  it('ignores every group message when no staff group is configured', async () => {
    configMock.supportGroupId.mockReturnValue(null)
    const update = groupMessage(-1001111111111)
    await processUpdate(update as never)
    expect(staffHandlerMock.handleStaffGroupMessage).not.toHaveBeenCalled()
  })

  it('is a no-op for an update with no message field (e.g. edited_message)', async () => {
    await processUpdate({ update_id: 3 } as never)
    expect(playerHandlerMock.handlePlayerMessage).not.toHaveBeenCalled()
    expect(staffHandlerMock.handleStaffGroupMessage).not.toHaveBeenCalled()
  })

  it('claims the dedupe key with NX and a TTL, keyed on update_id', async () => {
    const update = privateMessage({ update_id: 77 })
    await processUpdate(update as never)
    expect(redisMock.set).toHaveBeenCalledWith('tg:update:77', '1', 'EX', 86_400, 'NX')
  })

  it('does not dispatch a second time for an update_id the dedupe key already claimed', async () => {
    redisMock.set.mockResolvedValue(null) // NX lost — someone/something already has this key
    const update = privateMessage()
    await processUpdate(update as never)
    expect(playerHandlerMock.handlePlayerMessage).not.toHaveBeenCalled()
  })
})

describe('POST /v1/telegram/webhook — secret header', () => {
  async function post(headers: Record<string, string>, body: object = privateMessage()) {
    const app = Fastify({ logger: false })
    await app.register(telegramWebhookRoute, { prefix: '/v1/telegram/webhook' })
    const res = await app.inject({ method: 'POST', url: '/v1/telegram/webhook', headers, payload: body })
    return res
  }

  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.set.mockResolvedValue('OK')
  })

  it('rejects a request with no secret header', async () => {
    const res = await post({})
    expect(res.statusCode).toBe(401)
  })

  it('rejects a request with the wrong secret', async () => {
    const res = await post({ 'x-telegram-bot-api-secret-token': 'guessed' })
    expect(res.statusCode).toBe(401)
  })

  it('accepts a request with the correct secret and acks 200 immediately', async () => {
    const res = await post({ 'x-telegram-bot-api-secret-token': 'the-real-secret' })
    expect(res.statusCode).toBe(200)
  })

  it('acks 200 for a malformed body rather than erroring — never retry-worthy', async () => {
    const res = await post({ 'x-telegram-bot-api-secret-token': 'the-real-secret' }, { not: 'an update' })
    expect(res.statusCode).toBe(200)
  })
})
