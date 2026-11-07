import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseDocument, isMap, isScalar } from 'yaml'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** Offline repair, with DSH stopped. Only this plugin's legacy hashed IDs are renamed. */
export async function repairCredentialsFile(filename, { check = false } = {}) {
  const path = await realpath(filename)
  const facts = await stat(path)
  if (!facts.isFile() || facts.size > 8 * 1024 * 1024) throw new Error('Expected a credentials file smaller than 8 MiB.')
  const original = await readFile(path, 'utf8')
  const document = parseDocument(original, { uniqueKeys: true, logLevel: 'silent' })
  if (document.errors.length || !isMap(document.contents) || document.get('version') !== 1) throw new Error('Unsupported or invalid credential document; nothing was changed.')
  const records = document.get('records', true)
  if (records === undefined) return { changed: 0 }
  if (!isMap(records)) throw new Error('Expected a records mapping; nothing was changed.')
  let changed = 0
  for (const pair of records.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue
    const match = /^wecom-bot\/([a-f0-9]{24})$/.exec(pair.key.value)
    if (!match) continue
    const target = credentialKey('wecom-bot', `profile-${match[1]}`)
    if (records.has(target)) throw new Error('A migrated Wecom Bot record already exists. Resolve the duplicate before repair; nothing was changed.')
    pair.key.value = target
    changed++
  }
  if (check || changed === 0) return { changed }
  const backup = `${path}.wecom-backup-${randomUUID()}`
  const temporary = `${path}.wecom-repair-${randomUUID()}.tmp`
  async function writePrivate(destination, content) {
    const file = await open(destination, 'wx', 0o600)
    try { await file.writeFile(content, 'utf8'); await file.sync() } finally { await file.close() }
  }
  await writePrivate(backup, original)
  try {
    await writePrivate(temporary, document.toString())
    if (await readFile(path, 'utf8') !== original) throw new Error('Credentials changed during repair. Stop DSH and retry; nothing was overwritten.')
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  return { changed, backup }
}

const entrypoint = process.argv[1] && await realpath(process.argv[1]).catch(() => undefined)
if (entrypoint === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const files = args.filter(arg => arg !== '--check')
  if (files.length !== 1) {
    console.error('Usage (with DSH stopped): node scripts/repair-credentials.mjs [--check] /path/to/.credentials.yaml')
    process.exitCode = 1
  } else {
    try {
      const result = await repairCredentialsFile(files[0], { check })
      console.log(JSON.stringify({ checkedOnly: check, ...result }))
    } catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}
