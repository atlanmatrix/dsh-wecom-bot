import { z } from 'zod'

export const configurationSchema = z.strictObject({
  botId: z.string().trim().min(1).max(256),
  secret: z.string().min(1).max(4096).optional(),
  provider: z.string().trim().min(1).max(256),
  model: z.string().trim().min(1).max(256),
  cwd: z.string().trim().min(1),
  allowedUsers: z.array(z.string().trim().min(1)).max(10000),
})
const configurationView = configurationSchema.omit({ secret: true }).extend({ secretConfigured: z.boolean() })
export const sessionSchema = z.strictObject({
  key: z.string(), sessionId: z.string(), title: z.string(), userId: z.string(),
  groupId: z.string(), chatType: z.enum(['single', 'group']), updatedAt: z.number(),
})
const stateSchema = z.strictObject({
  status: z.enum(['unconfigured', 'disconnected', 'connecting', 'connected', 'error']),
  configuration: configurationView.nullable(),
  sessions: z.array(sessionSchema),
})
const codec = (symbol, schema) => ({ mode: 'strict', typeSymbol: `dsh-wecom-bot#${symbol}`, create: () => schema })
export const remoteContribution = {
  package: 'dsh-wecom-bot',
  descriptors: ['state', 'configure', 'connect', 'disconnect'].map(method => ({
    id: `dsh-wecom-bot#wecomBot/${method}`, service: 'wecomBot', namespace: 'wecomBot', method,
    invocation: { kind: 'direct' },
    parameters: method === 'configure' ? [{ name: 'request', wire: 'request', source: 'json', codec: codec('Configuration', configurationSchema) }] : [],
    result: codec('State', stateSchema),
  })),
}
