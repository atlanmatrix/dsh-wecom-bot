/** WeCom group robot transport. Never include the webhook or remote body in errors. */
export class WeComError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WeComError'
  }
}

export function validateWebhook(value) {
  let url
  try { url = new URL(value) } catch { throw new WeComError('Set a valid WeCom robot webhook in the configured environment variable.') }
  if (url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com'
    || url.port || url.username || url.password || url.hash
    || url.pathname !== '/cgi-bin/webhook/send'
    || !url.searchParams.get('key')?.trim()
    || [...url.searchParams.keys()].some(key => key !== 'key')
    || url.searchParams.getAll('key').length !== 1) {
    throw new WeComError('Webhook must be https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…')
  }
  return url.href
}

export function createPayload(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !['content', 'msgtype', 'mentioned_list', 'mentioned_mobile_list'].includes(key))) {
    throw new WeComError('Expected content, optional msgtype, and optional text mentions.')
  }
  const { content, msgtype = 'text', mentioned_list, mentioned_mobile_list } = args
  if (!['text', 'markdown'].includes(msgtype)) throw new WeComError('msgtype must be text or markdown.')
  if (typeof content !== 'string' || !content.trim()) throw new WeComError('content must be a non-empty string.')
  const limit = msgtype === 'text' ? 2048 : 4096
  if (Buffer.byteLength(content, 'utf8') > limit) throw new WeComError(`${msgtype} content exceeds ${limit} UTF-8 bytes.`)
  const body = { content }
  for (const [key, value] of Object.entries({ mentioned_list, mentioned_mobile_list })) {
    if (value === undefined) continue
    if (msgtype !== 'text') throw new WeComError('Mentions are supported only for text messages.')
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
      throw new WeComError(`${key} must be an array of non-empty strings.`)
    }
    body[key] = [...new Set(value)]
  }
  return { msgtype, [msgtype]: body }
}

export function createClient({ webhook, timeoutMs = 10000, fetchImpl = globalThis.fetch }) {
  const endpoint = validateWebhook(webhook)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new WeComError('timeoutMs must be an integer from 1 to 120000.')
  }
  return {
    async send(args, signal) {
      const payload = createPayload(args)
      const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
      try {
        requestSignal.throwIfAborted()
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          redirect: 'error',
          signal: requestSignal,
        })
        if (!response.ok) throw new WeComError(`WeCom HTTP error ${response.status}; delivery is unconfirmed. Do not retry automatically.`)
        const result = await response.json()
        if (!result || !Number.isInteger(result.errcode)) throw new WeComError('Invalid WeCom response; delivery is unconfirmed.')
        if (result.errcode !== 0) throw new WeComError(`WeCom rejected the message (errcode ${result.errcode}).`)
        return { delivered: true, msgtype: payload.msgtype }
      } catch (error) {
        if (error instanceof WeComError) throw error
        if (signal?.aborted) throw new WeComError('WeCom request cancelled; delivery is unconfirmed.')
        if (requestSignal.aborted) throw new WeComError('WeCom request timed out; delivery is unconfirmed. Do not retry automatically.')
        throw new WeComError('WeCom request failed; delivery is unconfirmed. Check connectivity and webhook configuration.')
      }
    },
  }
}
