import { randomUUID } from 'node:crypto'

/** UTF-8 safe truncation within WeCom's 20480-byte stream limit. */
export function replyText(text) {
  const suffix = '\n\n（回复过长，已截断）'
  if (Buffer.byteLength(text) <= 20480) return text
  let result = '', size = 0
  const budget = 20480 - Buffer.byteLength(suffix)
  for (const char of text) {
    size += Buffer.byteLength(char)
    if (size > budget) break
    result += char
  }
  return result + suffix
}

export function createBridge({ client, runner, timeoutMs = 120000, allowedUsers = [], maxPending = 10, log = () => {} }) {
  const pending = new Map(), seen = new Map(), tasks = new Set()
  const lifetime = new AbortController()
  const handle = async frame => {
    const body = frame?.body
    if (lifetime.signal.aborted || body?.msgtype !== 'text' || typeof body.text?.content !== 'string'
      || !body.text.content.trim() || typeof body.msgid !== 'string' || !body.msgid
      || typeof body.from?.userid !== 'string' || !body.from.userid
      || !frame.headers?.req_id || !['single', 'group'].includes(body.chattype)
      || (body.chattype === 'group' && !body.chatid)) return
    if (allowedUsers.length && !allowedUsers.includes(body.from.userid)) return
    const now = Date.now()
    for (const [id, until] of seen) { if (until <= now) seen.delete(id) }
    if (seen.has(body.msgid)) return
    seen.set(body.msgid, now + 10 * 60 * 1000)
    if (seen.size > 10000) seen.delete(seen.keys().next().value)
    // Group members do not share model history or tools' session state.
    const key = JSON.stringify([body.aibotid, body.chattype, body.chatid ?? '', body.from.userid])
    const previous = pending.get(key)
    if ((previous?.count ?? 0) >= maxPending) {
      await client.replyStream(frame, randomUUID(), '消息过多，请稍后重试。', true)
      return
    }
    const streamId = randomUUID()
    // Acknowledge promptly, before waiting for earlier turns in this conversation.
    const ack = client.replyStream(frame, streamId, '正在处理，请稍候…', false)
    const entry = { count: (previous?.count ?? 0) + 1 }
    entry.promise = (async () => {
      try {
        await ack
        await previous?.promise
        lifetime.signal.throwIfAborted()
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)])
        const answer = await runner.run(key, body.text.content, signal)
        if (!lifetime.signal.aborted) await client.replyStream(frame, streamId, replyText(answer), true)
      } catch {
        log('WeCom turn failed; details suppressed to protect credentials and message contents.')
        if (!lifetime.signal.aborted) {
          try { await client.replyStream(frame, streamId, '处理失败或超时，请稍后再试。', true) } catch { log('WeCom reply failed.') }
        }
      } finally {
        const current = pending.get(key)
        if (current === entry) pending.delete(key)
        else if (current) current.count--
      }
    })()
    pending.set(key, entry)
    await entry.promise
  }
  const listener = frame => {
    const task = handle(frame).catch(() => log('WeCom message failed.'))
    tasks.add(task)
    void task.finally(() => tasks.delete(task))
  }
  return {
    handle,
    start() { client.on('message.text', listener); client.connect() },
    async close() {
      lifetime.abort()
      client.off('message.text', listener)
      client.disconnect()
      await runner.close()
      await Promise.allSettled([...tasks])
    },
  }
}
