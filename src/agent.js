import { randomUUID } from 'node:crypto'

/** Route robot messages through the same Session Controller used by the DSH UI. */
export function createAgentRunner(ctx, config) {
  const handles = new Map()
  let closed = false
  return {
    async run(key, text, signal, identity = {}) {
      signal.throwIfAborted()
      if (closed) throw new Error('Bridge stopped.')
      let handle = handles.get(key)
      if (!handle) {
        if (handles.size >= config.maxSessions) throw new Error('Session capacity reached.')
        const saved = config.catalog?.get(key)
        const title = saved?.title ?? `Wecom · ${identity.userId ?? 'user'}${identity.groupId ? ` · ${identity.groupId}` : ''}`
        const creation = (async () => {
          const controller = ctx.sessionController
          let sessionId = saved?.sessionId
          if (!sessionId) {
            const workspaceRegistry = ctx.get('workspaceRegistry')
            const workspace = workspaceRegistry && await workspaceRegistry.create(config.cwd)
            const created = await controller.create(workspace ? { workspaceId: workspace.id } : { cwd: config.cwd })
            sessionId = created.sessionId
          }
          if (!saved) await controller.rename({ sessionId, title: title.slice(0, 80) })
          if (config.catalog && !saved) await config.catalog.put({ key, sessionId, title,
            userId: identity.userId ?? '', groupId: identity.groupId ?? '', chatType: identity.chatType ?? 'single', updatedAt: Date.now() })
          return { sessionId }
        })()
        handles.set(key, creation)
        try { handle = await creation } catch (error) { handles.delete(key); throw error }
        if (closed) throw new Error('Bridge stopped.')
      }
      handle = await handle
      const resolved = await ctx.sessionController.resolveAgent(handle.sessionId)
      if ('error' in resolved) throw resolved.error
      const { agent } = resolved
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
      const cancel = () => { try { ctx.sessionController.cancel({ sessionId: agent.session.id }) } catch {} }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        signal.throwIfAborted()
        if (config.catalog) {
          const row = config.catalog.get(key)
          if (row) await config.catalog.put({ ...row, updatedAt: Date.now() })
        }
        signal.throwIfAborted()
        await ctx.sessionController.prompt({ sessionId: agent.session.id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] }, signal)
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
      // Sessions belong to DSH. Disconnecting a robot must not dispose reviewable sessions.
      await Promise.allSettled([...handles.values()])
      handles.clear()
    },
  }
}
