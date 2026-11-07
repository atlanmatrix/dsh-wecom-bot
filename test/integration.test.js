import { provideTestSessionController } from './helpers/session-controller.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import AiBot from '@wecom/aibot-node-sdk'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createBridge } from '../src/bridge.js'
import { createAgentRunner } from '../src/agent.js'

class Adapter extends LlmAdapter {
  requests = []
  async *stream(options) {
    this.requests.push(options)
    const text = `DSH回复${this.requests.length}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('official WeCom SDK → WebSocket callback → real DSH AgentLoop → WeCom stream reply', { timeout: 15000 }, async () => {
  const ctx = new Context()
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const adapter = new Adapter()
  let bridge
  const complete = Promise.withResolvers()
  const replies = []
  const silent = { info() {}, warn() {}, error() {}, debug() {} }
  try {
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)
    provideTestSessionController(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)
    const client = new AiBot.WSClient({ botId: 'local-test-bot', secret: 'local-test-secret', wsUrl: `ws://127.0.0.1:${server.address().port}`, logger: silent })
    client.on('error', complete.reject)
    server.on('connection', socket => {
      socket.on('message', raw => {
        const request = JSON.parse(raw)
        socket.send(JSON.stringify({ headers: request.headers, errcode: 0, errmsg: 'ok' }))
        if (request.cmd === 'aibot_subscribe') {
          assert.equal(request.body.bot_id, 'local-test-bot')
          socket.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'local-message' }, body: { msgid: 'm1', aibotid: 'bot', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: '你好' } } }))
        }
        if (request.cmd === 'aibot_respond_msg') {
          replies.push(request.body)
          if (request.body.stream?.finish) complete.resolve()
        }
      })
    })
    bridge = createBridge({ client, runner: createAgentRunner(ctx, { cwd: process.cwd(), maxSessions: 10 }) })
    bridge.start()
    await complete.promise
    assert.equal(adapter.requests.length, 1)
    assert.equal(replies.at(-1).stream.content, 'DSH回复1')
    assert.equal(replies[0].stream.finish, false)
  } finally {
    await bridge?.close()
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
    await ctx.fiber.dispose()
  }
})

test('agent runner preserves history, isolates sessions, and rejects capacity overflow', { timeout: 10000 }, async () => {
  const ctx = new Context()
  const adapter = new Adapter()
  const runner = createAgentRunner(ctx, { cwd: process.cwd(), maxSessions: 2 })
  try {
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)
    provideTestSessionController(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.provide('subagents', {}) // Older 0.2.2 compositions expose no tree-wait capability.
    const signal = new AbortController().signal
    assert.equal(await runner.run('user1', 'first', signal), 'DSH回复1')
    assert.equal(await runner.run('user1', 'second', signal), 'DSH回复2')
    await runner.run('user2', 'isolated', signal)
    assert.equal(ctx.agents.list().length, 2)
    await assert.rejects(runner.run('user3', 'overflow', signal), /capacity/)
    assert.ok(JSON.stringify(adapter.requests[1]).includes('first'))
    assert.ok(!JSON.stringify(adapter.requests[2]).includes('first'))
  } finally { await runner.close(); await ctx.fiber.dispose() }
})

test('real DSH agent is cancelled at the request deadline', { timeout: 10000 }, async () => {
  const ctx = new Context()
  const runner = createAgentRunner(ctx, { cwd: process.cwd(), maxSessions: 1 })
  let aborted = false
  class SlowAdapter extends LlmAdapter {
    async *stream(options) {
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) { aborted = true; reject(options.signal.reason); return }
        options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason) }, { once: true })
      })
    }
  }
  const keepAlive = setInterval(() => {}, 100)
  try {
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)
    provideTestSessionController(ctx)
    ctx.llm.registerAdapter(['mock'], new SlowAdapter())
    await assert.rejects(runner.run('timeout-user', 'wait forever', AbortSignal.timeout(100)))
    assert.ok(aborted)
  } finally { clearInterval(keepAlive); await runner.close(); await ctx.fiber.dispose() }
})

test('plugin configuration stays discoverable before a bot is configured', async () => {
  const plugin = await import('../src/index.js')
  const schema = plugin.Config.toJSON()
  assert.equal(schema.refs[schema.uid].type, 'object')
  assert.equal(plugin.Config({}).timeoutMs, 120000)
  assert.throws(() => plugin.Config({ timeoutMs: -1 }))
})
