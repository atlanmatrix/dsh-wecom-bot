import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Owns agents in the current Harness context; no subprocess and no second model client. */
export function createAgentRunner(ctx, config) {
  const handles = new Map()
  let closed = false
  return {
    async run(key, text, signal, identity = {}) {
      if (closed) throw new Error('Bridge stopped.')
      let handle = handles.get(key)
      if (!handle) {
        if (handles.size >= config.maxSessions) throw new Error('Session capacity reached.')
        const saved = config.catalog?.get(key)
        const title = saved?.title ?? `Wecom · ${identity.userId ?? 'user'}${identity.groupId ? ` · ${identity.groupId}` : ''}`
        const creation = (async () => {
          const workspaceRegistry = ctx.get('workspaceRegistry')
          if (workspaceRegistry) await workspaceRegistry.create(config.cwd)
          const existing = saved && ctx.agents.get(saved.sessionId)
          let acquired
          if (existing) acquired = { agent: existing, dispose: async () => {} }
          else if (saved) acquired = await ctx.agents.resume({
            resumeSessionId: saved.sessionId,
            agentOptions: { provider: config.provider, model: config.model },
            setup: (_agentCtx, agent) => { agent.model.select({ provider: config.provider, model: config.model }) },
          })
          else acquired = await ctx.agents.create({
            sessionId: `wecom-${randomUUID()}`,
            meta: { cwd: config.cwd },
            agentOptions: { provider: config.provider, model: config.model },
          })
          try {
            if (!saved) ctx.get('sessionTitle')?.rename(acquired.agent.session, title.slice(0, 80))
            if (config.catalog && !saved) await config.catalog.put({ key, sessionId: acquired.agent.session.id, title,
              userId: identity.userId ?? '', groupId: identity.groupId ?? '', chatType: identity.chatType ?? 'single', updatedAt: Date.now() })
            return acquired
          } catch (error) { await acquired.dispose(); throw error }
        })()
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
        if (config.catalog) {
          const row = config.catalog.get(key)
          if (row) await config.catalog.put({ ...row, updatedAt: Date.now() })
        }
        signal.throwIfAborted()
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        while (true) {
          await agent.whenIdle()
          const seq = agent.session.seq
          const subagents = ctx.get('subagents')
          const children = typeof subagents?.waitForTreeWork === 'function' ? await subagents.waitForTreeWork(agent) : undefined
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
