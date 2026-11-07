import z from '@deepseek-ai/schemastery'
import AiBot from '@wecom/aibot-node-sdk'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { createAgentRunner } from './agent.js'
import { createBridge } from './bridge.js'

export const name = 'wecom-bot'
export const inject = ['agents']
export const Config = z.object({
  botIdEnv: z.string().default('WECOM_BOT_ID').description('Environment variable containing the WeCom Bot ID.'),
  secretEnv: z.string().default('WECOM_BOT_SECRET').description('Environment variable containing the WeCom Secret.'),
  provider: z.string().default('deepseek').description('Configured DSH model provider ID.'),
  model: z.string().default('deepseek-chat'),
  cwd: z.string().description('Working directory for new agent sessions.'),
  timeoutMs: z.number().step(1).min(1).max(240000).default(120000),
  maxSessions: z.number().step(1).min(1).max(10000).default(100),
  maxPending: z.number().step(1).min(1).max(100).default(10),
  allowedUsers: z.array(z.string()).default([]).description('Allowed WeCom user IDs; empty permits all bot contacts.'),
})

export function apply(ctx, config = {}) {
  for (const field of ['botIdEnv', 'secretEnv']) {
    if (config[field] !== undefined && (typeof config[field] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config[field]))) throw new Error(`Invalid ${field}.`)
  }
  const botId = process.env[config.botIdEnv ?? 'WECOM_BOT_ID']
  const secret = process.env[config.secretEnv ?? 'WECOM_BOT_SECRET']
  if (!botId || !secret) throw new Error('Set WECOM_BOT_ID and WECOM_BOT_SECRET (or configured environment variable names).')
  if (typeof config.provider !== 'string' || !config.provider.trim() || typeof config.model !== 'string' || !config.model.trim()) throw new Error('Configure a DSH provider and model for the WeCom agent.')
  const options = { ...config, cwd: config.cwd ?? process.cwd(), maxSessions: config.maxSessions ?? 100 }
  for (const [key, value, max] of [['timeoutMs', config.timeoutMs ?? 120000, 240000], ['maxSessions', options.maxSessions, 10000], ['maxPending', config.maxPending ?? 10, 100]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${key}.`)
  }
  if (config.allowedUsers !== undefined && (!Array.isArray(config.allowedUsers) || config.allowedUsers.some(id => typeof id !== 'string' || !id))) throw new Error('allowedUsers must contain user IDs.')
  const log = message => console.info(`[wecom-bot] ${message}`)
  // SDK debug logs contain full message frames, so never forward their arguments.
  const logger = { debug() {}, info() {}, warn() { log('Connection warning.') }, error() { log('Connection error.') } }
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY
  const client = new AiBot.WSClient({ botId, secret, logger,
    ...(proxy ? { wsOptions: { agent: new HttpsProxyAgent(proxy) } } : {}),
  })
  client.on('error', () => log('WeCom connection failed.'))
  client.on('authenticated', () => log('WeCom authenticated.'))
  const bridge = createBridge({ client, runner: createAgentRunner(ctx, options), timeoutMs: config.timeoutMs, allowedUsers: config.allowedUsers, maxPending: config.maxPending, log })
  ctx.on('dispose', () => bridge.close())
  bridge.start()
}
