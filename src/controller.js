import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import { Service } from '@deepseek-ai/cordis'
import { bindTypertRemote, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { configurationSchema } from './remote.js'

/** One owner-only control surface shared by the menu page and lifecycle. */
export class WecomBotController extends Service {
  constructor(ctx, { catalog, credentialKey, start }) {
    super(ctx, 'wecomBot')
    this.typertRemote = bindTypertRemote(this, 'wecomBot')
    this.catalog = catalog
    this.credentialKey = credentialKey
    this.startBridge = start
    this.status = 'unconfigured'
    this.tail = Promise.resolve()
    this.current = undefined
    this.bridge = undefined
    this.closed = false
  }
  assertOwner() {
    const invocation = this.ctx.invocation
    if (invocation && invocation.peer.principal.kind !== 'owner') throw new RemoteError('remote-access/denied', 'Only the Harness owner can configure Wecom Bot.', { action: 'wecomBot/configure', reason: 'owner-required' })
  }
  async initialize() {
    const record = await this.ctx.credentials.readRecord(this.credentialKey)
    if (record) {
      const { provider: _legacyProvider, model: _legacyModel, ...configuration } = record.payload.configuration
      this.current = configurationSchema.required({ secret: true }).parse(configuration)
      if (_legacyProvider !== undefined || _legacyModel !== undefined) {
        await this.ctx.credentials.modifyRecord(this.credentialKey, () => ({ kind: 'grant', payload: { configuration: this.current, enabled: record.payload.enabled === true } }))
      }
      this.status = 'disconnected'
      // Saved configuration reconnects automatically after a normal Harness restart.
      if (record.payload.enabled) await this.connect()
    }
  }
  state() {
    this.assertOwner()
    const { secret, ...publicConfiguration } = this.current ?? {}
    return { status: this.status, configuration: this.current ? { ...publicConfiguration, secretConfigured: !!secret } : null, sessions: this.catalog.list() }
  }
  enqueue(task) {
    this.assertOwner()
    const next = this.tail.then(async () => { if (this.closed) throw new Error('Wecom Bot stopped.'); return task() })
    this.tail = next.catch(() => {})
    return next
  }
  configure(request) {
    return this.enqueue(async () => {
      const parsed = configurationSchema.parse(request)
      if (!isAbsolute(parsed.cwd) || !(await stat(parsed.cwd)).isDirectory()) throw new Error('Choose an existing absolute working directory.')
      const secret = parsed.secret ?? this.current?.secret
      if (!secret) throw new Error('Enter the robot Secret.')
      // A changed bot cannot silently inherit the previous bot's credentials.
      if (this.current && parsed.botId !== this.current.botId && !parsed.secret) throw new Error('Enter the Secret for the new Bot ID.')
      const next = { ...parsed, secret }
      await this.ctx.credentials.modifyRecord(this.credentialKey, () => ({ kind: 'grant', payload: { configuration: next, enabled: false } }))
      await this.stopBridge()
      this.current = next
      this.status = 'disconnected'
      return this.state()
    })
  }
  connect() {
    return this.enqueue(async () => {
      if (!this.current) throw new Error('Configure the robot first.')
      await this.stopBridge()
      this.status = 'connecting'
      try {
        const configuration = this.current
        const bridge = await this.startBridge(configuration, status => { if (this.bridge === bridge && !this.closed) this.status = status })
        this.bridge = bridge
        await this.ctx.credentials.modifyRecord(this.credentialKey, () => ({ kind: 'grant', payload: { configuration, enabled: true } }))
        bridge.start()
      } catch {
        await this.stopBridge()
        this.status = 'error'
        throw new Error('Cannot connect Wecom Bot. Check robot configuration and network access.')
      }
      return this.state()
    })
  }
  disconnect() {
    return this.enqueue(async () => {
      if (this.current) await this.ctx.credentials.modifyRecord(this.credentialKey, () => ({ kind: 'grant', payload: { configuration: this.current, enabled: false } }))
      await this.stopBridge()
      this.status = this.current ? 'disconnected' : 'unconfigured'
      return this.state()
    })
  }
  async stopBridge() { const previous = this.bridge; this.bridge = undefined; await previous?.close() }
  async close() { this.closed = true; await this.tail; await this.stopBridge() }
}
