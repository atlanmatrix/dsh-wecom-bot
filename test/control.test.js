import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { WecomBotController } from '../src/controller.js'
import { SessionCatalog } from '../src/catalog.js'
import { remoteContribution } from '../src/remote.js'
import * as plugin from '../src/index.js'

const connection = { botId: 'test-bot', secret: 'test-private-secret', provider: 'mock', model: 'mock', cwd: '/tmp', allowedUsers: ['user1'] }
async function setup(path) {
  const ctx = new Context()
  await ctx.plugin(Credentials, { path: join(path, '.credentials.yaml'), watch: false })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  ctx.typert.register({ package: 'dsh-wecom-bot', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: remoteContribution.descriptors })
  const catalog = new SessionCatalog(join(path, 'sessions.json'))
  await catalog.load()
  let started = 0, stopped = 0
  const controller = new WecomBotController(ctx, { catalog, credentialKey: 'wecom-bot/test', start: async (_configuration, status) => ({ start() { started++; status('connected') }, async close() { stopped++ } }) })
  const owner = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (method, args = {}, peer = owner) => ctx.typertGateway.invoke({ namespace: 'wecomBot', method, args, peer })
  return { ctx, controller, catalog, invoke, counts: () => ({ started, stopped }) }
}

test('owner RPC configures credentials, preserves Secret, connects/disconnects, and restores settings', async () => {
  const path = await mkdtemp(join(tmpdir(), 'wecom-control-'))
  let fixture
  try {
    fixture = await setup(path)
    await fixture.controller.initialize()
    assert.equal((await fixture.invoke('state')).status, 'unconfigured')
    const saved = await fixture.invoke('configure', { request: connection })
    assert.equal(saved.status, 'disconnected')
    assert.equal(saved.configuration.secretConfigured, true)
    assert.ok(!JSON.stringify(saved).includes(connection.secret))
    const { secret, ...withoutSecret } = connection
    await fixture.invoke('configure', { request: { ...withoutSecret, model: 'updated' } })
    assert.equal((await fixture.ctx.credentials.readRecord('wecom-bot/test')).payload.configuration.secret, secret)
    await assert.rejects(fixture.invoke('configure', { request: { ...withoutSecret, botId: 'other' } }), /Secret/)
    assert.equal((await fixture.invoke('connect')).status, 'connected')
    assert.equal((await fixture.invoke('disconnect')).status, 'disconnected')
    assert.deepEqual(fixture.counts(), { started: 1, stopped: 1 })
    await fixture.controller.close(); await fixture.ctx.fiber.dispose()
    fixture = await setup(path)
    await fixture.controller.initialize()
    assert.equal((await fixture.invoke('state')).configuration.model, 'updated')
    assert.equal((await fixture.invoke('state')).status, 'disconnected')
    await assert.rejects(fixture.invoke('configure', { request: { ...connection, unexpected: 'x' } }))
    const visitor = new Peer(fixture.ctx, { principal: { kind: 'guest' } })
    await assert.rejects(fixture.invoke('configure', { request: connection }, visitor), /denied/)
    await assert.rejects(fixture.invoke('state', {}, visitor), /denied/)
  } finally { await fixture?.controller.close(); await fixture?.ctx.fiber.dispose(); await rm(path, { recursive: true, force: true }) }
})

test('unconfigured Host plugin loads and exposes its control page without any bot credentials', async () => {
  const path = await mkdtemp(join(tmpdir(), 'wecom-empty-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Credentials, { path: join(path, '.credentials.yaml'), watch: false })
    await ctx.plugin(TypertRegistry)
    // Only the empty-plugin startup path needs an agent registry; it must never create an agent.
    ctx.provide('agents')
    ctx.agents = { create() { assert.fail('Unconfigured startup must not create agents') } }
    await ctx.plugin(plugin, { dataDir: path })
    assert.equal(ctx.wecomBot.state().status, 'unconfigured')
    assert.equal(ctx.typert.local.get('wecomBot/configure').parameters[0].wire, 'request')
  } finally { await ctx.fiber.dispose(); await rm(path, { recursive: true, force: true }) }
})
