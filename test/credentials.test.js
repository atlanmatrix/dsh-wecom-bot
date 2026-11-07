import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { profileCredentialKey, migrateProfileCredential } from '../src/credential-key.js'
import { repairCredentialsFile } from '../scripts/repair-credentials.mjs'
import * as plugin from '../src/index.js'

function directoryFor(root, startsWithDigit) {
  for (let index = 0; index < 1000; index++) {
    const path = join(root, `data-${index}`)
    const hash = createHash('sha256').update(path).digest('hex').slice(0, 24)
    if (/^[0-9]/.test(hash) === startsWithDigit) return { path, hash }
  }
  throw new Error('No fixture directory')
}
async function boot(path, dataDir) {
  const ctx = new Context()
  try {
    await ctx.plugin(Credentials, { path, watch: false })
    await ctx.plugin(Typert)
    ctx.provide('sessionController', {})
    await ctx.plugin(plugin, { dataDir })
    return ctx
  } catch (error) { await ctx.fiber.dispose(); throw error }
}

test('digit-leading profile hashes produce valid keys and survive provider + plugin restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wecom-digit-key-'))
  const { path: dataDir, hash } = directoryFor(root, true)
  const path = join(root, '.credentials.yaml')
  let ctx
  try {
    assert.throws(() => parseCredentialKey(`wecom-bot/${hash}`))
    assert.equal(parseCredentialKey(profileCredentialKey(dataDir)), profileCredentialKey(dataDir))
    ctx = await boot(path, dataDir)
    await ctx.wecomBot.configure({ botId: 'test-bot', secret: 'private-test-secret', cwd: root, allowedUsers: [] })
    await ctx.fiber.dispose()
    ctx = await boot(path, dataDir)
    assert.equal(ctx.wecomBot.state().configuration.botId, 'test-bot')
    assert.equal(ctx.wecomBot.state().configuration.secretConfigured, true)
    assert.equal((await ctx.credentials.readRecord(profileCredentialKey(dataDir))).payload.configuration.secret, 'private-test-secret')
  } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('valid legacy keys migrate through the provider without replacing newer credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wecom-old-key-'))
  const { path: dataDir, hash } = directoryFor(root, false)
  const ctx = new Context()
  try {
    await ctx.plugin(Credentials, { path: join(root, '.credentials.yaml'), watch: false })
    const legacy = parseCredentialKey(`wecom-bot/${hash}`)
    const record = { kind: 'grant', payload: { secret: 'private-test-value' } }
    await ctx.credentials.modifyRecord(legacy, async () => record)
    const key = await migrateProfileCredential(ctx.credentials, dataDir)
    assert.deepEqual(await ctx.credentials.readRecord(key), record)
    assert.equal(await ctx.credentials.readRecord(legacy), undefined)
    const newer = { kind: 'grant', payload: { secret: 'newer-private-value' } }
    await ctx.credentials.modifyRecord(key, async () => newer)
    await ctx.credentials.modifyRecord(legacy, async () => record)
    await migrateProfileCredential(ctx.credentials, dataDir)
    assert.deepEqual(await ctx.credentials.readRecord(key), newer)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('offline repair backs up and fixes invalid own keys while preserving other records and comments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wecom-repair-'))
  const path = join(root, '.credentials.yaml')
  const key = 'wecom-bot/0123456789abcdef01234567'
  const original = `# keep this comment\nversion: 1\nrefs:\n  EXISTING_KEY: retained-test-value\nrecords:\n  ${key}:\n    kind: grant\n    payload:\n      secret: private-test-value\n  other-plugin/account:\n    kind: grant\n    payload:\n      token: retained-test-token\n`
  const ctx = new Context()
  try {
    await writeFile(path, original, { mode: 0o600 })
    assert.deepEqual(await repairCredentialsFile(path, { check: true }), { changed: 1 })
    assert.equal(await readFile(path, 'utf8'), original)
    const result = await repairCredentialsFile(path)
    assert.equal(result.changed, 1)
    assert.equal(await readFile(result.backup, 'utf8'), original)
    assert.equal((await stat(result.backup)).mode & 0o777, 0o600)
    assert.match(await readFile(path, 'utf8'), /keep this comment/)
    await ctx.plugin(Credentials, { path, watch: false })
    assert.equal((await ctx.credentials.readRecord(parseCredentialKey('wecom-bot/profile-0123456789abcdef01234567'))).payload.secret, 'private-test-value')
    assert.equal((await ctx.credentials.readRecord(parseCredentialKey('other-plugin/account'))).payload.token, 'retained-test-token')
    assert.deepEqual(await repairCredentialsFile(path), { changed: 0 })
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})


test('offline repair refuses a duplicate destination without overwriting either credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wecom-repair-conflict-'))
  const path = join(root, '.credentials.yaml')
  const original = 'version: 1\nrecords:\n  wecom-bot/0123456789abcdef01234567:\n    kind: grant\n    payload: { secret: old-private-value }\n  wecom-bot/profile-0123456789abcdef01234567:\n    kind: grant\n    payload: { secret: newer-private-value }\n'
  try {
    await writeFile(path, original, { mode: 0o600 })
    await assert.rejects(repairCredentialsFile(path), /nothing was changed/)
    assert.equal(await readFile(path, 'utf8'), original)
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('offline repair CLI also works through an installed-package symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wecom-repair-cli-'))
  const path = join(root, '.credentials.yaml')
  try {
    await writeFile(path, 'version: 1\nrecords: {}\n', { mode: 0o600 })
    const script = join(root, 'repair.mjs')
    await symlink(fileURLToPath(new URL('../scripts/repair-credentials.mjs', import.meta.url)), script)
    const output = execFileSync(process.execPath, [script, '--check', path], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(output), { checkedOnly: true, changed: 0 })
  } finally { await rm(root, { recursive: true, force: true }) }
})
