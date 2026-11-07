import { provideTestSessionController } from './helpers/session-controller.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Titles from '@deepseek-ai/dsh-session-title'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAgentRunner } from '../src/agent.js'
import { SessionCatalog } from '../src/catalog.js'
class Adapter extends LlmAdapter {
  requests = []
  async *stream(options) {
    this.requests.push(options)
    const text = 'ok'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function boot(path) {
  const ctx = new Context(), adapter = new Adapter()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Persistence, { root: join(path, 'history'), compression: 'none' })
  await mountAgentLoopTestHarness(ctx)
  provideTestSessionController(ctx)
  await ctx.plugin(Titles, { fallbackMaxWords: 12, fallbackMaxBytes: 160, maxTitleBytes: 512 })
  ctx.llm.registerAdapter(['mock'], adapter)
  const catalog = new SessionCatalog(join(path, 'catalog.json'))
  await catalog.load()
  const runner = createAgentRunner(ctx, { catalog, cwd: path, maxSessions: 10 })
  return { ctx, adapter, catalog, runner }
}
test('distinct users and groups have durable, titled, reviewable DSH sessions that resume after restart', { timeout: 15000 }, async () => {
  const path = await mkdtemp(join(tmpdir(), 'wecom-history-'))
  let fixture
  try {
    fixture = await boot(path)
    const signal = new AbortController().signal
    const identities = [{ userId: 'u1', groupId: '', chatType: 'single' }, { userId: 'u2', groupId: '', chatType: 'single' }, { userId: 'u1', groupId: 'g1', chatType: 'group' }, { userId: 'u1', groupId: 'g2', chatType: 'group' }, { userId: 'u2', groupId: 'g1', chatType: 'group' }]
    for (const identity of identities) await fixture.runner.run(JSON.stringify(identity), `private-${identity.userId}-${identity.groupId}`, signal, identity)
    const rows = fixture.catalog.list()
    assert.equal(new Set(rows.map(row => row.sessionId)).size, 5)
    for (const row of rows) {
      const stored = await fixture.ctx.sessionPersistence.stat(row.sessionId)
      assert.ok(stored)
      assert.equal(fixture.ctx.agents.get(row.sessionId).session.snapshotEvents().find(event => event.type === 'session/title').data.title, row.title)
    }
    const original = fixture.catalog.get(JSON.stringify(identities[0])).sessionId
    await fixture.runner.close(); await fixture.ctx.fiber.dispose()
    fixture = await boot(path)
    await fixture.runner.run(JSON.stringify(identities[0]), 'follow-up after restart', signal, identities[0])
    assert.equal(fixture.catalog.get(JSON.stringify(identities[0])).sessionId, original)
    assert.ok(JSON.stringify(fixture.adapter.requests[0]).includes('private-u1-'))
    assert.ok(!JSON.stringify(fixture.adapter.requests[0]).includes('private-u2-'))
  } finally { await fixture?.runner.close(); await fixture?.ctx.fiber.dispose(); await rm(path, { recursive: true, force: true }) }
})
