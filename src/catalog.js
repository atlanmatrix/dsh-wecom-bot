import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sessionSchema } from './remote.js'

/** Plugin-owned metadata only. Credentials live in Harness's credential provider. */
export class SessionCatalog {
  constructor(path) { this.path = path; this.rows = new Map(); this.tail = Promise.resolve() }
  async load() {
    try {
      const rows = z.array(sessionSchema).parse(JSON.parse(await readFile(this.path, 'utf8')))
      this.rows = new Map(rows.map(row => [row.key, row]))
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read Wecom Bot session catalog.') }
  }
  list() { return [...this.rows.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(row => ({ ...row })) }
  get(key) { const row = this.rows.get(key); return row && { ...row } }
  put(row) {
    const next = this.tail.then(async () => {
      const valid = sessionSchema.parse(row)
      const rows = new Map(this.rows).set(valid.key, valid)
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify([...rows.values()]), { mode: 0o600 })
      await rename(temporary, this.path)
      this.rows = rows
    })
    this.tail = next.catch(() => {})
    return next
  }
}
