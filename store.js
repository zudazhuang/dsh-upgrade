/** Private, atomic update records; a live owner never loses its exclusive lock. */
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Read an optional JSON file; malformed records fail visibly. */
export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}
/** Publish one record atomically with owner-only permissions. */
export async function writeJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temp, path)
}
/** Acquire a cross-process lock. Stale locks require an explicit recovery action. */
export async function acquireLock(root) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, 'transaction.lock')
  const token = randomUUID()
  await writeFile(path, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 })
  return async () => {
    const current = await readJson(path)
    if (current?.token !== token) throw new Error('Update lock owner changed')
    await unlink(path)
  }
}
