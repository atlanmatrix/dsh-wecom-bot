import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Owns agents in the current Harness context; no subprocess and no second model client. */
export function createAgentRunner(ctx, config) {
  const handles = new Map()
  let closed = false
  return {
    async run(key, text, signal) {
      if (closed) throw new Error('Bridge stopped.')
      let handle = handles.get(key)
      if (!handle) {
        if (handles.size >= config.maxSessions) throw new Error('Session capacity reached.')
        const creation = ctx.agents.create({
          sessionId: `wecom-${randomUUID()}`,
          meta: { cwd: config.cwd },
          agentOptions: { provider: config.provider, model: config.model },
        })
        handles.set(key, creation)
        try { handle = await creation } catch (error) { handles.delete(key); throw error }
        if (closed) { await handle.dispose(); throw new Error('Bridge stopped.') }
      }
      handle = await handle
      const { agent } = handle
      let final = ''
      let failure
      const offEvent = ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        if (event.type === 'assistant/message') {
          final = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        }
        if (event.type === 'turn/end' && event.data.reason?.kind !== 'completed') failure = new Error('Agent did not complete.')
      })
      const offError = ctx.on('agent/error', payload => {
        if (payload.agent === agent) failure = new Error('Agent failed.')
      })
      const cancel = () => agent.cancel({ kind: 'hook', reason: 'WeCom request cancelled' })
      signal.addEventListener('abort', cancel, { once: true })
      try {
        signal.throwIfAborted()
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        while (true) {
          await agent.whenIdle()
          const seq = agent.session.seq
          const children = await ctx.get('subagents')?.waitForTreeWork(agent)
          if (!children && agent.status === 'idle' && agent.session.seq === seq) break
        }
        signal.throwIfAborted()
        if (failure) throw failure
        return final || '本轮处理完成，没有文本回复。'
      } finally {
        signal.removeEventListener('abort', cancel)
        offEvent()
        offError()
      }
    },
    async close() {
      closed = true
      await Promise.allSettled([...handles.values()].map(async pending => (await pending).dispose()))
      handles.clear()
    },
  }
}
