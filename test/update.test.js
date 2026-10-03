/** Keyless regressions use temporary installations and injected process adapters. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, cp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { selectRelease, validatePlan, prepare, buildEnvironment, command } from '../engine.js'
import { acquireLock, readJson, writeJson } from '../store.js'
import { transition, restoreHome } from '../supervisor.mjs'
import { installationRoot, activity, apply } from '../index.js'

const release = version => ({ tag_name: `dsh-v${version}`, html_url: `https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${version}`, prerelease: version.includes('-'), draft: false })
const packageRecord = version => ({ name: '@deepseek-ai/dsh', version, dist: { integrity: `sha512-${'A'.repeat(86)}==` } })
const target = { version: '0.3.0', tag: 'dsh-v0.3.0' }
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-safe-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function fixture(t) {
  const base = await temporary(t); const source = join(base, 'old'); const home = join(base, 'home'); const root = join(base, 'updates')
  await mkdir(join(source, 'apps/cli/src'), { recursive: true });
  await writeFile(join(source, 'apps/cli/src/bin.ts'), '// Temporary launcher fixture.\n'); await mkdir(join(home, 'profiles/web'), { recursive: true })
  await writeJson(join(source, 'apps/cli/package.json'), { name: '@deepseek-ai/dsh', version: '0.2.0' })
  await writeJson(join(home, 'profiles/web/package.json'), { dependencies: {} })
  await writeFile(join(source, 'old-built-file'), 'previous build')
  await writeFile(join(home, 'credentials'), 'test fixture secret')
  await writeFile(join(home, 'session'), 'previous session')
  return { source, home, root }
}

test('selects preview or stable versions from agreeing official sources', () => {
  const versions = ['0.2.0', '0.3.0-rc.1']; const registry = { versions: Object.fromEntries(versions.map(v => [v, packageRecord(v)])) }
  assert.equal(selectRelease(versions.map(release), registry, 'preview').version, '0.3.0-rc.1')
  assert.equal(selectRelease(versions.map(release), registry, 'stable').version, '0.2.0')
  assert.throws(() => selectRelease([release('0.4.0')], registry, 'preview'), /disagree/)
  assert.throws(() => selectRelease({}, registry, 'preview'), /Invalid/)
  assert.throws(() => selectRelease([release('0.2.0')], { versions: { '0.2.0': { ...packageRecord('0.2.0'), name: 'evil' } } }, 'preview'), /disagree/)
})
test('never stages equal versions, downgrades or dirty source trees', () => {
  assert.throws(() => validatePlan({ version: '0.3.0', dirty: [] }, target), /newer/)
  assert.throws(() => validatePlan({ version: '0.4.0', dirty: [] }, target), /newer/)
  assert.throws(() => validatePlan({ version: '0.2.0', dirty: [' M file'] }, target), /Local changes/)
})
test('build subprocesses do not inherit credentials', () => {
  assert.deepEqual(buildEnvironment({ PATH: '/bin', DEEPSEEK_API_KEY: 'secret', TOKEN: 'secret', GIT_ASKPASS: 'credential-program', DSH_HOME: '/real' }), { PATH: '/bin' })
})
test('commands report nonzero exits and cancellation without exposing output', async () => {
  await assert.rejects(command(process.execPath, ['-e', "console.error('private'); process.exit(2)"]), error => error.message.includes('2') && !error.message.includes('private'))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(command(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }), /cancelled/)
})
test('one private cross-process transaction lock excludes a second writer', async t => {
  const root = await temporary(t); const release = await acquireLock(root)
  await assert.rejects(acquireLock(root), error => error.code === 'EEXIST')
  await release(); const second = await acquireLock(root); await second()
})
test('failed build leaves current code, dependencies and user data untouched', async t => {
  const paths = await fixture(t); const phases = []
  const run = async (file, args, options) => {
    if (file === 'git' && args[0] === 'status') return ''
    if (file === 'git' && args[0] === 'clone') {
      await mkdir(join(args.at(-1), 'apps/cli'), { recursive: true })
      await writeJson(join(args.at(-1), 'apps/cli/package.json'), packageRecord(target.version)); return ''
    }
    if (file === 'pnpm' && args.includes('build')) throw new Error('fixture build failure')
    return ''
  }
  await assert.rejects(prepare({ ...paths, target, signal: new AbortController().signal, run, publish: async value => phases.push(value.phase) }), /fixture build failure/)
  assert.deepEqual(phases, ['download', 'build', 'failed'])
  assert.equal(await readFile(join(paths.source, 'old-built-file'), 'utf8'), 'previous build')
  assert.equal(await readFile(join(paths.home, 'credentials'), 'utf8'), 'test fixture secret')
  assert.equal(await readJson(join(paths.root, 'prepared.json')), null)
  assert.equal((await readdir(paths.root)).includes('transaction.lock'), false)
})
test('verified preparation persists a plan only after isolated boot succeeds', async t => {
  const paths = await fixture(t); let verified = false
  const run = async (file, args) => {
    if (file === 'git' && args[0] === 'status') return ''
    if (file === 'git' && args[0] === 'clone') {
      assert.equal(args.at(-2), 'https://github.com:443/deepseek-ai/deepseek-harness.git')
      await mkdir(join(args.at(-1), 'apps/cli'), { recursive: true })
      await writeJson(join(args.at(-1), 'apps/cli/package.json'), packageRecord(target.version))
    }
    return ''
  }
  const plan = await prepare({ ...paths, target, signal: new AbortController().signal, run, publish: async () => {}, verify: async (source, home) => {
    assert.notEqual(source, paths.source); assert.notEqual(home, paths.home)
    assert.equal(await readFile(join(home, 'credentials'), 'utf8'), 'test fixture secret'); verified = true
  } })
  assert.equal(verified, true); assert.deepEqual(await readJson(join(paths.root, 'prepared.json')), plan)
})
test('busy agents and session-owned jobs block switching', () => {
  const context = { agents: { list: () => [{ id: 'session', status: 'running', inbox: { hasPending: false } }] }, jobs: { list: () => [] }, sessions: { list: () => [{ id: 'session' }] } }
  assert.equal(activity(context), true)
  context.agents.list = () => [{ id: 'session', status: 'idle', inbox: { hasPending: false } }]
  context.jobs.list = owner => owner === 'session' ? [{ status: 'running' }] : []
  assert.equal(activity(context), true)
  context.jobs.list = () => [{ status: 'completed' }]; assert.equal(activity(context), false)
})
test('startup failure restores data before relaunching the previous environment', async t => {
  const { home } = await fixture(t); const backup = `${home}.snapshot`; const failed = `${home}.failed`; const steps = []
  const plan = { previous: 'old', source: 'new', profile: 'candidate', target }
  const io = {
    validate: async () => {}, stop: async () => steps.push('stop'), record: async state => steps.push(state.phase),
    snapshot: async () => cp(home, backup, { recursive: true }),
    installProfile: async () => writeFile(join(home, 'session'), 'new-format session'),
    launch: async source => steps.push(`launch:${source}`),
    health: async version => { if (version === target.version) throw new Error('fixture unhealthy') },
    restore: async () => { await restoreHome(home, backup, failed); steps.push('restored') },
    previousVersion: async () => ({ version: '0.2.0' }),
  }
  assert.equal(await transition(plan, io), false)
  assert.equal(await readFile(join(home, 'session'), 'utf8'), 'previous session')
  assert.equal(await readFile(join(failed, 'session'), 'utf8'), 'new-format session')
  assert.equal(await readFile(join(backup, 'credentials'), 'utf8'), 'test fixture secret')
  assert.ok(steps.indexOf('restored') < steps.indexOf('launch:old'))
  assert.equal(steps.at(-1), 'recovered')
})
test('successful switching retains snapshot and records actual health success', async () => {
  const steps = []; const plan = { previous: 'old', source: 'new', target }
  const io = Object.fromEntries(['validate', 'stop', 'snapshot', 'installProfile', 'launch', 'health'].map(name => [name, async () => steps.push(name)]))
  io.record = async record => steps.push(record.phase)
  assert.equal(await transition(plan, io), true)
  assert.deepEqual(steps, ['validate', 'stop', 'snapshot', 'snapshot', 'switching', 'installProfile', 'launch', 'health', 'completed'])
})
test('failed validation never stops the running application', async () => {
  let stopped = false
  await assert.rejects(transition({}, { validate: async () => { throw new Error('changed') }, stop: async () => { stopped = true } }), /changed/)
  assert.equal(stopped, false)
})
test('an incomplete restore never launches old code against potentially migrated data', async () => {
  const launched = []
  const io = { validate: async () => {}, stop: async () => {}, record: async () => {}, snapshot: async () => {}, installProfile: async () => {}, launch: async source => launched.push(source), health: async () => { throw new Error('unhealthy') }, restore: async () => { throw new Error('restore failed') } }
  await assert.rejects(transition({ previous: 'old', source: 'new', target }, io), /restore failed/)
  assert.deepEqual(launched, ['new'])
})
test('discovers source installation and rejects unrelated entrypoints', async t => {
  const { source } = await fixture(t)
  await writeJson(join(source, 'package.json'), { name: '@deepseek-ai/dsh-root' })
  assert.equal(installationRoot(join(source, 'apps/cli/src/bin.ts')), source)
  assert.throws(() => installationRoot('/tmp/unrelated/tool.js'), /supports/)
})

test('Host routes validate RPC input and refuse an unsupervised version switch', async t => {
  const base = await temporary(t); const home = join(base, 'home'); const root = join(base, 'update')
  await mkdir(home)
  const oldArg = process.argv[1]; const oldEnv = { DSH_HOME: process.env.DSH_HOME, DSH_SAFE_UPDATE_ROOT: process.env.DSH_SAFE_UPDATE_ROOT, DSH_SAFE_SMOKE: process.env.DSH_SAFE_SMOKE, DSH_SAFE_SUPERVISOR_ID: process.env.DSH_SAFE_SUPERVISOR_ID }
  const { source } = await fixture(t)
  await writeJson(join(source, 'package.json'), { name: '@deepseek-ai/dsh-root' })
  await command('git', ['init'], { cwd: source })
  process.argv[1] = join(source, 'apps/cli/src/bin.ts')
  Object.assign(process.env, { DSH_HOME: home, DSH_SAFE_UPDATE_ROOT: root, DSH_SAFE_SMOKE: '1' }); delete process.env.DSH_SAFE_SUPERVISOR_ID
  const routes = new Map(); const cleanups = []
  const ctx = { agents: { list: () => [] }, jobs: { list: () => [] }, sessions: { list: () => [] }, connection: { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } } }, on: () => {}, inject: () => {}, effect: factory => { const cleanup = factory(); if (cleanup) cleanups.push(cleanup) } }
  const box = value => ({ get: () => value })
  try {
    await apply(ctx, { checkOnStart: box(true), scheduledChecks: box(true), updateTimeMinutes: box(180), updateWindowMinutes: box(60), channel: box('preview'), autoApply: box(false), checkIntervalMinutes: box(30), idleQuietSeconds: box(120) })
    const endpoint = action => routes.get(`/api/safe-release-update.${action}`)
    assert.equal((await endpoint('health').fetch(new Request('http://localhost/api', { method: 'POST', body: '{}' }))).status, 415)
    assert.equal((await endpoint('health').fetch(new Request('http://localhost/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).status, 400)
    const call = async action => (await endpoint(action).fetch(new Request('http://localhost/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: `safe-release-update.${action}` }) }))).json()
    const status = await call('status'); assert.equal(typeof status.result.value.nextCheckAt, 'number'); assert.equal(status.result.value.nextUpdateAt, null)
    const health = await call('health'); assert.equal(health.result.ok, true); assert.equal(health.result.value.busy, false)
    const result = await call('apply'); assert.equal(result.result.ok, false); assert.match(result.result.error.message, /supervisor/)
    assert.equal(await readJson(join(root, 'pending.json')), null)
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    process.argv[1] = oldArg
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})
