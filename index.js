/** Cordis Host: version checks, update preparation and idle-only supervised handoff. */
import { UpdateSchedule } from './schedule.js'
import z from '@deepseek-ai/schemastery'
import { realpathSync } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import semver from 'semver'
import { checkRelease, prepare, command, sourceStatus, deploymentHash, validatePlan } from './engine.js'
import { readJson, writeJson } from './store.js'

export const name = 'dsh-update'
export const inject = ['connection', 'agents', 'jobs', 'sessions']
export const Config = z.object({
  checkOnStart: z.boolean().default(true).volatile(),
  scheduledChecks: z.boolean().default(true).volatile(),
  updateTimeMinutes: z.number().min(0).max(1439).step(1).default(180).volatile(),
  updateWindowMinutes: z.number().min(15).max(240).step(1).default(60).volatile(),
  checkIntervalMinutes: z.number().min(5).max(1440).default(30).volatile(),
  idleQuietSeconds: z.number().min(30).max(3600).default(120).volatile(),
  autoApply: z.boolean().default(false).volatile(),
  channel: z.union(['preview', 'stable']).default('preview').volatile(),
})
/** Discover the running source installation without guessing from the user's current directory. */
export function installationRoot(bin = realpathSync(process.argv[1])) {
  let root = dirname(bin)
  for (let i = 0; i < 6; i++, root = dirname(root)) {
    try { if (JSON.parse(realpathPackage(root)).name === '@deepseek-ai/dsh-root') return root }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
  }
  throw new Error('Safe updater supports Harness source installations only')
}
import { readFileSync } from 'node:fs'
function realpathPackage(root) { return readFileSync(join(root, 'package.json'), 'utf8') }
/** Read-only, complete activity check across live agents and all visible job owners. */
export function activity(ctx) {
  const agents = ctx.agents.list()
  return agents.some(agent => agent.status !== 'idle' || agent.inbox.hasPending) || [undefined, ...ctx.sessions.list().map(session => session.id)]
    .some(owner => ctx.jobs.list(owner).some(job => job.status === 'running'))
}
/** Mount authenticated routes and withdraw timers, requests and maintenance claims on disposal. */
export async function apply(ctx, config) {
  const source = installationRoot()
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const root = process.env.DSH_SAFE_UPDATE_ROOT ?? join(homedir(), '.local/share/dsh-safe-release-update')
  if (!isAbsolute(root) || !isAbsolute(home) || root === home || root.startsWith(`${home}/`)) throw new Error('Updater storage must be an absolute directory outside Harness home')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const running = await sourceStatus(source)
  let state = { phase: 'unchecked', running: running.version, source, home, dirty: running.dirty, supervised: Boolean(process.env.DSH_SAFE_SUPERVISOR_ID), latest: null, checkedAt: null }
  let active = null; let disposed = false; let transitioning = false; let lastActivity = Date.now(); let pendingId = null
  const schedule = new UpdateSchedule(Date.now())
  const scheduling = () => schedule.view(Date.now(), Object.fromEntries(
    ['scheduledChecks', 'checkIntervalMinutes', 'autoApply', 'updateTimeMinutes', 'updateWindowMinutes'].map(key => [key, config[key].get()])))
  const controller = new AbortController()
  const claims = []; let releaseClaims
  let held; releaseClaims = () => {}
  const publish = async update => {
    state = { ...state, ...update }
    if (!process.env.DSH_SAFE_SMOKE) await writeJson(join(root, 'status.json'), state)
  }
  const refresh = async () => {
    await publish({ phase: 'checking', error: null, latest: null })
    try {
      const [target, current] = await Promise.all([checkRelease(config.channel.get(), controller.signal), sourceStatus(source)])
      const prepared = await readJson(join(root, 'prepared.json'))
      const ready = prepared?.previous === source && prepared?.target?.version === target.version && prepared.deploymentHash === await deploymentHash(home, source)
      await publish({ phase: semver.gt(target.version, running.version) ? (ready ? 'prepared' : 'available') : 'current', latest: target, checkedAt: Date.now(), dirty: current.dirty })
      return state
    } catch (error) { await publish({ phase: 'error', latest: null, checkedAt: null, error: error.message }); throw error }
    finally { schedule.checked(Date.now()) }
  }
  const runExclusive = operation => {
    if (active || transitioning || disposed) throw new Error('Updater is already busy or shutting down')
    active = Promise.resolve().then(operation).finally(() => { active = null })
    return active
  }
  const prepareRelease = async () => {
    const checked = await refresh()
    validatePlan({ version: running.version, dirty: checked.dirty }, checked.latest)
    try {
      const plan = await prepare({ source, home, root, target: checked.latest, signal: controller.signal, publish })
      await writeJson(join(root, 'failed-version.json'), { version: null }); return plan
    } catch (error) {
      await writeJson(join(root, 'failed-version.json'), { version: checked.latest.version }); throw error
    }
  }
  const handoff = async () => {
    if (!state.supervised) throw new Error('Restart through the supplied supervisor before applying an update')
    if (activity(ctx) || Date.now() - lastActivity < config.idleQuietSeconds.get() * 1000) throw new Error('Wait until sessions and jobs have been idle for the configured interval')
    const plan = await readJson(join(root, 'prepared.json'))
    if (!plan || plan.previous !== source || plan.home !== home) throw new Error('No verified candidate for this running installation')
    validatePlan(await sourceStatus(source), plan.target)
    if (plan.previousCommit !== await command('git', ['rev-parse', 'HEAD'], { cwd: source })) throw new Error('Source commit changed; prepare again')
    if (plan.deploymentHash !== await deploymentHash(home, source)) throw new Error('Configuration changed; prepare again')
    transitioning = true
    held = new Promise(resolve => { releaseClaims = resolve })
    claims.length = 0
    try {
      for (const agent of ctx.agents.list()) {
        claims.push(agent.runMaintenance(async () => held))
      }
      // runMaintenance claims synchronously; a thrown acquisition restores all earlier claims.
      const failure = new Promise((resolve, reject) => { for (const claim of claims) claim.catch(reject) })
      await Promise.race([failure, new Promise(resolve => setImmediate(resolve))])
      await publish({ phase: 'handoff', target: plan.target.version })
      pendingId = randomUUID()
      await writeJson(join(root, 'pending.json'), { id: pendingId, supervisor: process.env.DSH_SAFE_SUPERVISOR_ID, plan })
      return state
    } catch (error) { transitioning = false; releaseClaims(); throw error }
  }
  ctx.on('agent/created', () => { if (transitioning) throw new Error('Harness is switching to a verified update; retry after restart') })
  ctx.on('agent/status', () => { lastActivity = Date.now() })
  ctx.on('session/event', () => { lastActivity = Date.now() })
  ctx.inject(['settings'], child => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))
  for (const action of ['status', 'check', 'prepare', 'apply', 'health']) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/safe-release-update.${action}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return new Response('JSON required', { status: 415 })
        let body
        try { body = await request.json() } catch (error) { return new Response('Invalid JSON', { status: 400 }) }
        if (body?.type !== 'client-request' || typeof body.rpcId !== 'string' || body.method !== `safe-release-update.${action}`) return new Response('Invalid RPC', { status: 400 })
        let result
        try {
          let value
          if (action === 'health') value = { version: running.version, transitioning, busy: activity(ctx) }
          else if (action === 'status') value = { ...state, ...scheduling(), transaction: await readJson(join(root, 'transaction.json')) }
          else if (action === 'check') value = await runExclusive(refresh)
          else if (action === 'prepare') value = await runExclusive(prepareRelease)
          else value = await runExclusive(handoff)
          result = { ok: true, value }
        } catch (error) { result = { ok: false, error: { code: 'safe-update/refused', message: error.message, details: {} } } }
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result })
      },
    }))
  }
  if (!process.env.DSH_SAFE_SMOKE) {
    const tick = (forceCheck = false) => {
      if (active || transitioning || disposed) return
      const due = scheduling()
      if (!forceCheck && !due.checkDue && !due.updateDue) return
      void runExclusive(async () => {
        if (forceCheck || due.checkDue || due.updateCheckDue) {
          if (due.updateCheckDue) schedule.attempted(due.updateDay)
          await refresh()
        }
        const transaction = await readJson(join(root, 'transaction.json'))
        const failed = await readJson(join(root, 'failed-version.json'))
        if (scheduling().updateDue && ['available', 'prepared'].includes(state.phase) && !state.dirty.length && state.supervised && !activity(ctx)
            && Date.now() - lastActivity >= config.idleQuietSeconds.get() * 1000 && transaction?.failedVersion !== state.latest.version && failed?.version !== state.latest.version) {
          if (state.phase !== 'prepared') await prepareRelease()
          if (scheduling().updateDue) await handoff()
        }
      }).catch(error => { ctx.logger.warn('Safe update: %s', error.message) })
    }
    let polling = false
    const timer = setInterval(() => {
      tick()
      if (transitioning && !polling) {
        polling = true
        void readJson(join(root, 'handoff-result.json')).then(async result => {
          if (result?.id === pendingId && result.error) { transitioning = false; releaseClaims(); await publish({ phase: 'failed', error: result.error }) }
        }).catch(error => ctx.logger.warn('Safe update handoff: %s', error.message)).finally(() => { polling = false })
      }
    }, 1000)
    timer.unref()
    if (config.checkOnStart.get()) tick(true)
    ctx.effect(() => () => clearInterval(timer))
  }
  ctx.effect(() => async () => {
    disposed = true; controller.abort(); releaseClaims()
    await Promise.allSettled([active, ...claims].filter(Boolean))
  })
}
