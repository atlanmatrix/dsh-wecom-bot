import { createClient } from './client.js'

export const name = 'wecom-bot'
export const inject = ['tools']

/** Host-only Cordis plugin; secrets remain outside model arguments and results. */
export function apply(ctx, config = {}) {
  const webhookEnv = config.webhookEnv ?? 'WECOM_BOT_WEBHOOK'
  if (typeof webhookEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(webhookEnv)) {
    throw new Error('webhookEnv must name an environment variable.')
  }
  const client = createClient({ webhook: process.env[webhookEnv], timeoutMs: config.timeoutMs ?? 10000 })
  const lifetime = new AbortController()
  ctx.on('dispose', () => lifetime.abort())
  ctx.tools.register({
    name: 'wecom_send',
    description: 'Send a message to the configured WeCom group robot when the user requests it. Text supports mentions; Markdown does not. Never retry an unconfirmed delivery automatically.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        content: { type: 'string', description: 'Message content, up to 2048 UTF-8 bytes for text or 4096 for Markdown.' },
        msgtype: { type: 'string', enum: ['text', 'markdown'], description: 'Defaults to text.' },
        mentioned_list: { type: 'array', items: { type: 'string' }, description: 'Text only: member user IDs, or @all.' },
        mentioned_mobile_list: { type: 'array', items: { type: 'string' }, description: 'Text only: member mobile numbers, or @all.' },
      },
      required: ['content'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { delivered: { type: 'boolean' }, msgtype: { type: 'string', enum: ['text', 'markdown'] } },
        required: ['delivered', 'msgtype'],
      },
      render: (_args, value) => [{ type: 'text', text: `WeCom ${value.msgtype} message delivered.` }],
    },
    async execute(args, exec) {
      return client.send(args, AbortSignal.any([lifetime.signal, exec.signal]))
    },
  })
}
