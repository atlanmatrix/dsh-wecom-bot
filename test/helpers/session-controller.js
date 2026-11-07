import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Minimal Session Controller double for the isolated AgentLoop tests.
 * Full product acceptance uses the real DSH Session Controller instead.
 */
export function provideTestSessionController(ctx, { provider = 'mock', model = 'mock' } = {}) {
  const calls = []
  ctx.provide('sessionController', {
    async create(request) {
      calls.push(['create', request])
      const handle = await ctx.agents.create({ sessionId: `test-session-${randomUUID()}`, meta: { cwd: request.cwd }, agentOptions: { provider, model } })
      return { sessionId: handle.agent.session.id }
    },
    async resolveAgent(id) {
      calls.push(['resolveAgent', id])
      let agent = ctx.agents.get(id)
      if (!agent) agent = (await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider, model } })).agent
      return { agent }
    },
    async rename(request) {
      const agent = ctx.agents.get(request.sessionId)
      ctx.get('sessionTitle')?.rename(agent.session, request.title)
      return { title: request.title, seq: agent.session.seq }
    },
    async prompt(request, signal) {
      signal.throwIfAborted()
      calls.push(['prompt', request])
      ctx.agents.get(request.sessionId).followup(createUserMessage({ content: request.content, source: { kind: 'user' } }))
      return { accepted: true }
    },
    cancel({ sessionId }) { ctx.agents.get(sessionId).cancel({ kind: 'user' }); return { accepted: true } },
  })
  return calls
}
