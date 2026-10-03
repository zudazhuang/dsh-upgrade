/** Supervise only supported dsh web launches; stage switches retain whole environments and user data. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, cp, rename, unlink, open, readFile, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson, acquireLock } from './store.js'
import { command, sourceStatus, deploymentHash, validatePlan } from './engine.js'

/** Restore a complete home, keeping any post-update data in a separate directory. */
export async function restoreHome(home, backup, failedHome) {
  await rename(home, failedHome)
  await cp(backup, home, { recursive: true, dereference: false })
}
/** Switch a prepared environment; on any new-version failure restore data before old code starts. */
export async function transition(plan, io) {
  await io.validate(plan)
  await io.stop()
  await io.record({ phase: 'snapshot', from: plan.previous, to: plan.source })
  let snapshotReady = false
  try {
    await io.snapshot(); snapshotReady = true
    await io.record({ phase: 'switching', from: plan.previous, to: plan.source })
    await io.installProfile(plan.profile)
    await io.launch(plan.source)
    await io.health(plan.target.version)
    await io.record({ phase: 'completed', from: plan.previous, to: plan.source, version: plan.target.version })
    return true
  } catch (error) {
    await io.stop()
    if (snapshotReady) await io.restore()
    await io.record({ phase: 'recovering', from: plan.previous, to: plan.source, failedVersion: plan.target.version, error: error.message })
    await io.launch(plan.previous)
    await io.health((await io.previousVersion()).version)
    await io.record({ phase: 'recovered', from: plan.previous, to: plan.source, failedVersion: plan.target.version, error: error.message })
    return false
  }
}
/** Wait until all members of one owned child process group exit. */
async function stopGroup(child) {
  if (!child?.pid) return
  try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code === 'ESRCH') return; throw error }
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try { process.kill(-child.pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Old Harness did not shut down cleanly; no snapshot or version switch was performed')
}
/** Authenticate against the exact locally launched process, without printing its bearer URL. */
export async function healthFromLog(text, expected) {
  const match = text.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)
  if (!match) return false
  const origin = new URL(match[1]).origin
  const bootstrap = await fetch(match[1], { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const res = await fetch(`${origin}/api/safe-release-update.health`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify({ type: 'client-request', rpcId: 'supervisor', method: 'safe-release-update.health', params: {} }), signal: AbortSignal.timeout(5000) })
  if (!res.ok) return false
  const body = await res.json()
  return body.result?.ok && body.result.value.version === expected
}
/** Start a persistent supervisor for one Web profile. Existing update journals block uncertain recovery. */
export async function main(source, home, root) {
  source = resolve(source); home = resolve(home); root = resolve(root)
  if (root === home || root.startsWith(`${home}/`) || home === '/' || source === '/' || root === '/') throw new Error('Invalid update storage directories')
  const active = await readJson(join(root, 'active.json'))
  if (active) {
    if (typeof active.source !== 'string' || resolve(active.source) !== source && !resolve(active.source).startsWith(`${join(root, 'versions')}/`)) throw new Error('Invalid active installation record')
    source = resolve(active.source)
  }
  const initial = await sourceStatus(source)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const supervisorPath = join(root, 'supervisor.lock')
  const owner = randomUUID()
  const supervisorLock = await open(supervisorPath, 'wx', 0o600)
  await supervisorLock.writeFile(JSON.stringify({ pid: process.pid, owner }))
  await supervisorLock.close()
  let child = null; let current = source; let log = null; let stopped = false; let shutdown = false
  let transactionPromise = null
  const launch = async candidate => {
    const file = join(root, `runtime-${randomUUID()}.log`)
    log = await open(file, 'wx', 0o600)
    const args = ['dsh', 'web', '--no-open']
    if (process.env.DSH_SAFE_TEST_PICKER === '1') args.splice(2, 0, '--patch', join(candidate, 'apps/web/tests/pin-browse-picker.overlay.yml'))
    child = spawn('pnpm', args, { cwd: candidate, env: { ...process.env, DSH_HOME: home, DSH_SAFE_UPDATE_ROOT: root, DSH_SAFE_SUPERVISOR_ID: owner }, detached: true, stdio: ['ignore', log.fd, log.fd] })
    child.once('error', () => {})
    current = candidate; stopped = false
    await writeJson(join(root, 'runtime.json'), { source: current, pid: child.pid, supervisor: process.pid, log: file })
  }
  const stop = async () => { await stopGroup(child); child = null; stopped = true; await log?.close(); log = null }
  const health = async expected => {
    const runtime = await readJson(join(root, 'runtime.json'))
    const deadline = Date.now() + 90000
    while (Date.now() < deadline && !shutdown) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Harness exited before becoming healthy')
      if (await healthFromLog(await readFile(runtime.log, 'utf8'), expected)) return
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('Harness health check failed')
  }
  const record = async value => {
    const previous = await readJson(join(root, 'transaction.json'), {})
    await writeJson(join(root, 'transaction.json'), { ...previous, ...value, updatedAt: Date.now() })
    if (value.phase === 'completed') await writeJson(join(root, 'active.json'), { source: value.to, version: value.version })
    if (value.phase === 'recovered') await writeJson(join(root, 'active.json'), { source: value.from })
  }
  const requestStop = () => { shutdown = true }
  process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop)
  try {
    const journal = await readJson(join(root, 'transaction.json'))
    if (journal && !['completed', 'recovered', 'refused'].includes(journal.phase)) throw new Error('Interrupted update journal requires recovery; no automatic launch performed')
    await launch(source); await health(initial.version)
    console.log(`Harness ${initial.version} ready at http://127.0.0.1:3080/ (supervised)`)
    try {
      while (!shutdown) {
        const pending = await readJson(join(root, 'pending.json'))
        if (pending) {
          if (pending.supervisor !== owner) throw new Error('Handoff belongs to another supervisor; inspect pending.json')
          const plan = pending.plan
          const backup = join(root, 'backups', randomUUID())
          const failedHome = join(dirname(home), `${home.split('/').at(-1)}.failed-update-${randomUUID()}`)
          const releaseLock = await acquireLock(root)
          try {
            transactionPromise = transition(plan, {
              validate: async plan => {
                if (!plan || plan.previous !== current || plan.home !== home || !resolve(plan.source).startsWith(`${join(root, 'versions')}/`)
                    || plan.profile !== join(dirname(plan.source), '.smoke-home/profiles/web')) throw new Error('Prepared plan does not belong to this installation')
                const saved = await readJson(join(root, 'prepared.json'))
                if (JSON.stringify(saved) !== JSON.stringify(plan)) throw new Error('Prepared plan changed after handoff')
                validatePlan(await sourceStatus(current), plan.target)
                if (plan.previousCommit !== await command('git', ['rev-parse', 'HEAD'], { cwd: current })) throw new Error('Source commit changed after handoff')
                if (plan.deploymentHash !== await deploymentHash(home, current)) throw new Error('Configuration changed after handoff')
              },
              stop, record: value => record({ ...value, backup, failedHome }),
              snapshot: () => cp(home, backup, { recursive: true, dereference: false }),
              installProfile: async profile => {
                const destination = join(home, 'profiles/web')
                await rename(destination, join(home, 'profiles', `web.previous-${randomUUID()}`))
                await cp(profile, destination, { recursive: true, dereference: false })
              },
              launch, health,
              restore: () => restoreHome(home, backup, failedHome),
              previousVersion: () => sourceStatus(plan.previous),
            })
            await transactionPromise
            await unlink(join(root, 'pending.json'))
          } catch (error) {
            const journal = await readJson(join(root, 'transaction.json'))
            if (!stopped && (!journal || ['completed', 'recovered', 'refused'].includes(journal.phase))) {
              await writeJson(join(root, 'handoff-result.json'), { id: pending.id, error: error.message })
              await unlink(join(root, 'pending.json'))
              await record({ phase: 'refused', error: error.message, failedVersion: plan?.target?.version })
            } else {
              await stop()
              await record({ phase: 'recovery-required', error: error.message, failedVersion: plan?.target?.version })
              throw error
            }
          } finally { transactionPromise = null; await releaseLock() }
        }
        if (child?.exitCode !== null || child?.signalCode !== null) throw new Error('Harness exited; supervisor stopped')
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    } finally { process.off('SIGTERM', requestStop); process.off('SIGINT', requestStop) }
  } finally {
    process.off('SIGTERM', requestStop); process.off('SIGINT', requestStop)
    await transactionPromise?.catch(() => {})
    await stop()
    await unlink(supervisorPath)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) { console.error('Usage: node supervisor.mjs <Harness source> <Harness home> <update storage>'); process.exitCode = 1 }
  else await main(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
