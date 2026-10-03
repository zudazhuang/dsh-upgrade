/** Official source release preparation. All writes stay in private staging directories. */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import semver from 'semver'
import { readJson, writeJson, acquireLock } from './store.js'

export const OFFICIAL_REPO = 'https://github.com:443/deepseek-ai/deepseek-harness.git'
const RELEASES = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100'
const REGISTRY = 'https://registry.npmjs.org/@deepseek-ai%2fdsh'
/** Remove credentials from build subprocess environments and avoid Git redirect overrides. */
export function buildEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^GIT_|^DSH_|^npm_config_|^pnpm_/i.test(key)))
}
/** Run an argument array, bound its lifetime, and hide arbitrary command output from UI errors. */
export async function command(file, args, options = {}) {
  if (options.signal?.aborted) throw new Error('Operation cancelled')
  const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? buildEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let output = ''; let errorOutput = ''
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-1024 * 1024) })
  child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-1024 * 1024) })
  let timedOut = false; let killTimer
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    killTimer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }, 10000)
  }
  const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs ?? 600000)
  const abort = () => stop()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) stop()
  try {
    const [code, signal] = await once(child, 'close')
    if (code !== 0 || signal || timedOut || options.signal?.aborted) throw new Error(`${file} failed (${timedOut ? 'timeout' : options.signal?.aborted ? 'cancelled' : signal ?? code})`)
    return output.trim()
  } finally { clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener('abort', abort) }
}
/** Validate official release records and select the highest compatible channel version. */
export function selectRelease(releases, registry, channel) {
  if (!Array.isArray(releases) || !registry?.versions) throw new Error('Invalid official release metadata')
  const candidates = releases.filter(item => !item.draft && typeof item.tag_name === 'string' && /^dsh-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item.tag_name))
    .map(item => ({ version: item.tag_name.slice(5), tag: item.tag_name, url: item.html_url, prerelease: item.prerelease }))
    .filter(item => semver.valid(item.version) && (channel === 'preview' || (!item.prerelease && !semver.prerelease(item.version))))
    .sort((a, b) => semver.rcompare(a.version, b.version))
  const release = candidates[0]
  if (!release) throw new Error('No published version in the selected channel')
  const pkg = registry.versions[release.version]
  if (pkg?.name !== '@deepseek-ai/dsh' || pkg.version !== release.version || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.dist?.integrity ?? '')) throw new Error('Official npm and GitHub release metadata disagree')
  if (release.url !== `https://github.com/deepseek-ai/deepseek-harness/releases/tag/${release.tag}`) throw new Error('Invalid official release URL')
  return { ...release, integrity: pkg.dist.integrity }
}
/** Fetch both official authorities. Network errors invalidate the verdict. */
export async function checkRelease(channel, signal) {
  const fetchJson = async url => {
    const res = await fetch(url, { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20000)]), headers: { 'User-Agent': 'dsh-upgrade' }, redirect: 'error' })
    if (!res.ok) throw new Error(`Official source returned HTTP ${res.status}`)
    return res.json()
  }
  const [releases, registry] = await Promise.all([fetchJson(RELEASES), fetchJson(REGISTRY)])
  return selectRelease(releases, registry, channel)
}
/** Fingerprint deployment files to detect changes between preparation and switching. */
export async function deploymentHash(home, source) {
  const hash = createHash('sha256')
  for (const file of [join(home, 'cordis.patch.yml'), join(home, 'profiles/web/cordis.patch.yml'), join(home, 'profiles/web/package.json'), join(home, 'profiles/web/pnpm-lock.yaml'), join(home, 'profiles/web/pnpm-workspace.yaml'), join(home, 'profiles/web/.npmrc'), join(source, 'pnpm-workspace.yaml')]) {
    hash.update(file)
    try { hash.update(await readFile(file)) }
    catch (error) { if (error.code !== 'ENOENT') throw error; hash.update('absent') }
  }
  return hash.digest('hex')
}
/** Source identity and dirty files; no Git mutation is needed for checks. */
export async function sourceStatus(source, run = command) {
  const pkg = await readJson(join(source, 'apps/cli/package.json'))
  if (pkg?.name !== '@deepseek-ai/dsh' || !semver.valid(pkg.version)) throw new Error('Source directory is not a Harness installation')
  const dirty = await run('git', ['status', '--porcelain'], { cwd: source, timeoutMs: 20000 })
  return { version: pkg.version, dirty: dirty.split('\n').filter(Boolean) }
}
/** Require a newer target and a clean source tree before staging or switching. */
export function validatePlan(current, target) {
  if (!semver.gt(target.version, current.version)) throw new Error('Target must be newer than the running installation')
  if (current.dirty.length) throw new Error('Local changes block updating; preserve and resolve them before retrying')
}
/** Start one supported dsh profile and wait for its complete authenticated Web boot. */
export async function smoke(source, home, timeoutMs, signal) {
  const env = { ...buildEnvironment(), DSH_HOME: home, DSH_SAFE_SMOKE: '1' }
  const child = spawn('pnpm', ['dsh', 'web', '--port', '0', '--no-open'], { cwd: source, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; let exited = false
  const closed = once(child, 'close').then(() => { exited = true }).catch(() => { exited = true })
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-262144) })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-262144) })
  const started = Date.now()
  try {
    while (Date.now() - started < timeoutMs && !exited && !signal.aborted) {
      const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)?.[1]
      if (url) {
        const bootstrap = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
        const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
        const response = await fetch(new URL('/api/safe-release-update.health', url), { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: new URL(url).origin }, body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'safe-release-update.health', params: {} }), signal: AbortSignal.timeout(10000) })
        const body = await response.json()
        if (!response.ok || !body.result?.ok || body.result.value.version !== (await readJson(join(source, 'apps/cli/package.json'))).version) throw new Error('Candidate health or version check failed')
        return
      }
      await new Promise(r => setTimeout(r, 250))
    }
    throw new Error('Candidate boot did not become healthy')
  } finally {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await closed
  }
}
/** Build and smoke-test an official tag in isolation, retaining the current environment. */
export async function prepare({ source, home, root, target, signal, publish, run = command, verify = smoke }) {
  const releaseLock = await acquireLock(root)
  const directory = join(root, 'versions', `${target.version}-${randomUUID()}`)
  const smokeHome = join(directory, '.smoke-home')
  try {
    validatePlan(await sourceStatus(source, run), target)
    const previousCommit = await run('git', ['rev-parse', 'HEAD'], { cwd: source, timeoutMs: 20000 })
    const beforeHash = await deploymentHash(home, source)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await publish({ phase: 'download', target: target.version })
    await run('git', ['clone', '--depth', '1', '--branch', target.tag, '--single-branch', OFFICIAL_REPO, join(directory, 'source')], { signal })
    const staged = join(directory, 'source')
    const pkg = await readJson(join(staged, 'apps/cli/package.json'))
    if (pkg.version !== target.version) throw new Error('Tagged source version differs from release metadata')
    await publish({ phase: 'build', target: target.version })
    await run('pnpm', ['install', '--frozen-lockfile'], { cwd: staged, signal })
    await run('pnpm', ['run', 'build'], { cwd: staged, signal })
    await cp(home, smokeHome, { recursive: true, dereference: false, filter: path => !['backups', 'cache'].includes(path.slice(resolve(home).length + 1).split('/')[0]) })
    const profile = await readJson(join(smokeHome, 'profiles/web/package.json'))
    for (const name of Object.keys(profile.dependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))) {
      await run(process.execPath, ['--import', 'tsx/esm', join(staged, 'apps/cli/src/bin.ts'), 'plugin', '--profile', 'web', 'add', `${name}@${target.version}`], { cwd: staged, env: { ...buildEnvironment(), DSH_HOME: smokeHome }, signal })
    }
    await publish({ phase: 'verify', target: target.version })
    await verify(staged, smokeHome, 90000, signal)
    if (beforeHash !== await deploymentHash(home, source)) throw new Error('Configuration changed during preparation; prepare again')
    const plan = { source: staged, previous: source, previousCommit, home, profile: join(smokeHome, 'profiles/web'), deploymentHash: beforeHash, target, preparedAt: Date.now() }
    await writeJson(join(root, 'prepared.json'), plan)
    await publish({ phase: 'prepared', target: target.version })
    return plan
  } catch (error) {
    await publish({ phase: 'failed', target: target.version, error: error.message })
    throw error
  } finally { await releaseLock() }
}
