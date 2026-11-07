import z from '@deepseek-ai/schemastery'
import AiBot from '@wecom/aibot-node-sdk'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { createAgentRunner } from './agent.js'
import { createBridge } from './bridge.js'
import { SessionCatalog } from './catalog.js'
import { WecomBotController } from './controller.js'
import { remoteContribution } from './remote.js'

export const name = 'wecom-bot'
export const inject = ['agents', 'credentials', 'typert']
export const Config = z.object({
  dataDir: z.string().description('Optional plugin data directory; defaults to this Harness profile.'),
  timeoutMs: z.number().step(1).min(1).max(240000).default(120000),
  maxSessions: z.number().step(1).min(1).max(10000).default(100),
  maxPending: z.number().step(1).min(1).max(100).default(10),
})

export async function apply(ctx, config = {}) {
  const profile = process.env.DSH_PROFILE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE ?? 'default')
  const dataDir = resolve(config.dataDir ?? join(profile, 'wecom-bot'))
  const credentialKey = `wecom-bot/${createHash('sha256').update(dataDir).digest('hex').slice(0, 24)}`
  const catalog = new SessionCatalog(join(dataDir, 'sessions.json'))
  await catalog.load()
  ctx.typert.register({ package: 'dsh-wecom-bot', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: remoteContribution.descriptors })
  const controller = new WecomBotController(ctx, { catalog, credentialKey,
    async start(connection, onStatus) {
      const log = message => console.info(`[wecom-bot] ${message}`)
      // SDK debug logs include message frames. Never forward their arguments.
      const logger = { debug() {}, info() {}, warn() { log('Connection warning.') }, error() { log('Connection error.') } }
      const proxy = process.env.https_proxy || process.env.HTTPS_PROXY
      const client = new AiBot.WSClient({ botId: connection.botId, secret: connection.secret, logger,
        ...(proxy ? { wsOptions: { agent: new HttpsProxyAgent(proxy) } } : {}),
      })
      client.on('error', () => onStatus('error'))
      client.on('authenticated', () => onStatus('connected'))
      client.on('disconnected', () => onStatus('disconnected'))
      client.on('reconnecting', () => onStatus('connecting'))
      return createBridge({ client, runner: createAgentRunner(ctx, { ...connection, maxSessions: config.maxSessions ?? 100, catalog }),
        timeoutMs: config.timeoutMs ?? 120000, maxPending: config.maxPending ?? 10, allowedUsers: connection.allowedUsers, botId: connection.botId, log })
    },
  })
  ctx.on('dispose', () => controller.close())
  await controller.initialize()
}
