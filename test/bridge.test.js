import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createBridge, replyText } from '../src/bridge.js'

export function frame(id = '1', user = 'u1', chat = 'g1') {
  return { headers: { req_id: `req-${id}` }, body: { aibotid: 'bot', msgid: id, msgtype: 'text', chattype: 'group', chatid: chat, from: { userid: user }, text: { content: `question-${id}` } } }
}
function fixture(run, options = {}) {
  const replies = []
  const client = Object.assign(new EventEmitter(), { connect() {}, disconnect() {}, async replyStream(...args) { replies.push(args) } })
  const runner = { run, async close() {} }
  return { replies, bridge: createBridge({ client, runner, ...options }) }
}
test('deduplicates, serializes same conversation, and separates users and groups', async () => {
  const calls = []
  const gate = Promise.withResolvers()
  const { bridge, replies } = fixture(async (key, text) => { calls.push([key, text]); if (text === 'question-1') await gate.promise; return text })
  const first = bridge.handle(frame())
  await bridge.handle(frame())
  const second = bridge.handle(frame('2'))
  await bridge.handle(frame('3', 'u2'))
  await bridge.handle(frame('4', 'u1', 'g2'))
  assert.equal(calls.length, 3)
  assert.equal(new Set(calls.map(x => x[0])).size, 3)
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(calls.at(-1)[1], 'question-2')
  assert.equal(replies.filter(x => x[3]).length, 4)
  await bridge.close()
})
test('rejects unauthorized users and malformed messages before invoking the agent', async () => {
  const { bridge, replies } = fixture(() => assert.fail(), { allowedUsers: ['allowed'] })
  await bridge.handle(frame())
  await bridge.handle({ body: {} })
  assert.equal(replies.length, 0)
  await bridge.close()
})
test('turn errors are sanitized and do not poison the conversation queue', async () => {
  let count = 0
  const { bridge, replies } = fixture(async () => { if (!count++) throw new Error('SECRET'); return 'ok' })
  await bridge.handle(frame())
  await bridge.handle(frame('2'))
  assert.equal(replies.at(-1)[2], 'ok')
  assert.ok(!JSON.stringify(replies).includes('SECRET'))
  await bridge.close()
})
test('applies timeout and shutdown cancellation', async () => {
  const entered = Promise.withResolvers()
  const { bridge, replies } = fixture(async (_key, _text, signal) => {
    entered.resolve()
    await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  }, { timeoutMs: 10 })
  // Keep the test's event loop alive while AbortSignal.timeout's unref timer fires.
  const keepAlive = setInterval(() => {}, 100)
  try { await bridge.handle(frame()); assert.match(replies.at(-1)[2], /超时/) } finally { clearInterval(keepAlive); await bridge.close() }
})
test('truncates long Unicode responses within the stream byte limit', () => {
  const result = replyText('你好😀'.repeat(5000))
  assert.ok(Buffer.byteLength(result) <= 20480)
  assert.ok(!result.includes('\uFFFD'))
  assert.match(result, /已截断/)
})
