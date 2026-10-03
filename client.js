/** Browser settings contribution; all product copy comes from these locale dictionaries. */
window.__ModuleLoader__.load({ id: 'dsh-upgrade', factory: require => {
  const { Button, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
  const React = require('react')
  const { createElement: h, useState, useEffect, useSyncExternalStore } = React
  const dictionaries = {
    zh: {
      startup: '启动 Harness 时检查更新', periodic: '定时检查官方版本', time: '每天安装时段的开始时间（本机时间）', window: '安装时段长度（分钟）', nextCheck: '下次检查', nextUpdate: '下次安装时段', off: '已关闭', advanced: '高级设置与诊断',
      title: '软件更新', updateAvailable: '有新版', check: '检查更新', prepare: '下载并准备更新', apply: '安装并重启',
      running: '当前运行版本', latest: '官方发布版本', unknown: '尚未验证', source: '当前源码',
      dirty: '本地修改阻止自动更新，请先备份并处理这些修改。', monitor: '监督启动已启用', unsupervised: '通过监督启动脚本重启后才能切换版本。',
      interval: '检查间隔（分钟）', quiet: '空闲等待（秒）', automatic: '在指定时段自动安装更新', channel: '发布渠道', preview: '包含候选版本', stable: '仅稳定版本',
      saved: '设置已保存', refused: '设置保存被拒绝', changed: '此操作会重启 Harness；已运行的会话和任务会阻止切换。', failure: '操作失败',
      unchecked: '尚未检查', checking: '正在检查', available: '发现新版', current: '已是所选渠道最新版本', download: '下载官方源码', build: '隔离构建中', verify: '验证启动中', prepared: '新版已准备', handoff: '正在切换', failed: '准备失败', error: '检查失败',
      last: '最近检查', transaction: '最近更新', refresh: '刷新状态', savedData: '更新保留旧环境和用户数据快照；失败后保存新增数据并恢复。',
    },
    en: {
      startup: 'Check when Harness starts', periodic: 'Check official releases periodically', time: 'Daily installation start (local time)', window: 'Installation window (minutes)', nextCheck: 'Next check', nextUpdate: 'Next installation window', off: 'Off', advanced: 'Advanced settings and diagnostics',
      title: 'Software update', updateAvailable: 'Update available', check: 'Check for updates', prepare: 'Download and prepare update', apply: 'Install and restart',
      running: 'Running version', latest: 'Official release', unknown: 'Unverified', source: 'Running source',
      dirty: 'Local changes block automatic updates. Back up and resolve them first.', monitor: 'Supervised launch enabled', unsupervised: 'Restart through the supervisor script before switching versions.',
      interval: 'Check interval (minutes)', quiet: 'Idle wait (seconds)', automatic: 'Automatically install during the scheduled window', channel: 'Release channel', preview: 'Include preview releases', stable: 'Stable releases only',
      saved: 'Settings saved', refused: 'Settings write refused', changed: 'This restarts Harness. Active sessions and jobs prevent switching.', failure: 'Operation failed',
      unchecked: 'Not checked', checking: 'Checking', available: 'Update available', current: 'Latest in selected channel', download: 'Downloading official source', build: 'Building in isolation', verify: 'Verifying startup', prepared: 'Candidate prepared', handoff: 'Switching', failed: 'Preparation failed', error: 'Check failed',
      last: 'Last check', transaction: 'Latest update', refresh: 'Refresh status', savedData: 'Updates retain the old environment and a data snapshot. Failure saves new data and restores the previous environment.',
    },
  }
  function Card({ connection, form, locale }) {
    const language = useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot().active)
    const t = dictionaries[language?.startsWith('en') ? 'en' : 'zh']
    const settings = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
    const [state, setState] = useState(null); const [message, setMessage] = useState(''); const [connectionError, setConnectionError] = useState(''); const [busy, setBusy] = useState(false)
    const rpc = async action => {
      const result = await connection.rpc.call('/api', `safe-release-update.${action}`, {})
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    useEffect(() => {
      let mounted = true
      const refresh = () => rpc('status').then(value => { if (mounted) { setState(value); setConnectionError('') } }).catch(error => { if (mounted) setConnectionError(error.message) })
      refresh(); const timer = setInterval(refresh, 3000)
      return () => { mounted = false; clearInterval(timer) }
    }, [connection])
    const invoke = async action => {
      setBusy(true); setMessage('')
      try { await rpc(action); setState(await rpc('status')) }
      catch (error) { setMessage(`${t.failure}: ${error.message}`) }
      finally { setBusy(false) }
    }
    const save = async (field, value) => {
      try { const result = await form.set(field, value); setMessage(result === false ? t.refused : t.saved) }
      catch (error) { setMessage(error.message) }
    }
    const value = settings.value ?? {}
    return h('section', { 'aria-label': t.title, className: 'dsh-safe-update-settings' },
      h('style', null, `.dsh-safe-update-settings{display:grid;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}.dsh-safe-update-settings p,.dsh-safe-update-settings h3{margin:0}.dsh-safe-update-settings h3{font-size:20px;line-height:28px;font-weight:500}.dsh-safe-update-settings>label{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.dsh-safe-update-settings input:not([type=checkbox]),.dsh-safe-update-settings select{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:4px 8px}.dsh-safe-update-settings details{font-size:13px;line-height:20px}.dsh-safe-update-settings details>p,.dsh-safe-update-settings details>label{display:block;margin-top:12px}.dsh-safe-update-actions{display:flex;gap:8px;flex-wrap:wrap}`),
      h('h3', null, t.title),
      h('p', { role: 'status' }, state ? `${t[state.phase] ?? state.phase} · ${t.running}: ${state.running}` : t.unknown),
      h('p', null, `${t.latest}: ${state?.latest?.version ?? t.unknown}`),
      state?.latest?.url ? h('a', { href: state.latest.url, target: '_blank', rel: 'noreferrer' }, state.latest.tag) : null,
      h('div', { className: 'dsh-safe-update-actions' },
        h(Button, { variant: 'primary', disabled: busy || state?.phase === 'checking', onClick: () => invoke('check') }, t.check),
        h(Button, { variant: 'outline', disabled: busy || state?.phase !== 'available' || Boolean(state?.dirty?.length), onClick: () => invoke('prepare') }, t.prepare),
        h(Button, { variant: 'outline', disabled: busy || state?.phase !== 'prepared' || !state?.supervised, onClick: () => invoke('apply') }, t.apply)),
      h('label', null, h(Switch, { checked: value.checkOnStart ?? true, label: t.startup, onChange: checked => save('checkOnStart', checked) }), t.startup),
      h('label', null, h(Switch, { checked: value.scheduledChecks ?? true, label: t.periodic, onChange: checked => save('scheduledChecks', checked) }), t.periodic),
      h('label', null, t.interval, ' ', h('input', { type: 'number', min: 5, max: 1440, disabled: value.scheduledChecks === false, defaultValue: value.checkIntervalMinutes ?? 30, onBlur: event => save('checkIntervalMinutes', Number(event.target.value)) })),
      h('label', null, h(Switch, { checked: value.autoApply ?? false, label: t.automatic, onChange: checked => save('autoApply', checked) }), t.automatic),
      h('label', null, t.time, ' ', h('input', { type: 'time', disabled: !value.autoApply, value: `${String(Math.floor((value.updateTimeMinutes ?? 180) / 60)).padStart(2, '0')}:${String((value.updateTimeMinutes ?? 180) % 60).padStart(2, '0')}`, onChange: event => { const parts = event.target.value.split(':').map(Number); if (parts.length === 2 && parts.every(Number.isFinite)) save('updateTimeMinutes', parts[0] * 60 + parts[1]) } })),
      h('label', null, t.window, ' ', h('input', { type: 'number', min: 15, max: 240, disabled: !value.autoApply, defaultValue: value.updateWindowMinutes ?? 60, onBlur: event => save('updateWindowMinutes', Number(event.target.value)) })),
      h('p', null, `${t.nextCheck}: ${state?.nextCheckAt ? new Date(state.nextCheckAt).toLocaleString() : t.off}`),
      h('p', null, `${t.nextUpdate}: ${state?.nextUpdateAt ? new Date(state.nextUpdateAt).toLocaleString() : t.off}`),
      state?.dirty?.length ? h('p', { role: 'status' }, t.dirty) : null,
      h('details', null, h('summary', null, t.advanced),
        h('p', null, `${t.source}: ${state?.source ?? ''}`),
        h('p', null, state?.supervised ? t.monitor : t.unsupervised),
        state?.dirty?.length ? h('pre', { style: { whiteSpace: 'pre-wrap' } }, state.dirty.join('\n')) : null,
        h('label', null, t.channel, ' ', h('select', { value: value.channel ?? 'preview', onChange: event => save('channel', event.target.value) }, h('option', { value: 'preview' }, t.preview), h('option', { value: 'stable' }, t.stable))),
        h('label', null, t.quiet, ' ', h('input', { type: 'number', min: 30, max: 3600, defaultValue: value.idleQuietSeconds ?? 120, onBlur: event => save('idleQuietSeconds', Number(event.target.value)) }))),
      h('p', null, t.changed), h('p', null, t.savedData),
      state?.error ? h('p', { role: 'alert' }, state.error) : null,
      connectionError ? h('p', { role: 'alert' }, connectionError) : null,
      message ? h('p', { role: 'status' }, message) : null,
      state?.transaction ? h('p', null, `${t.transaction}: ${state.transaction.phase}`) : null,
      state?.checkedAt ? h('p', null, `${t.last}: ${new Date(state.checkedAt).toLocaleString()}`) : null)
  }
  function Badge({ connection, locale, navigation }) {
    const language = useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot().active)
    const t = dictionaries[language?.startsWith('en') ? 'en' : 'zh']
    const [state, setState] = useState(null)
    useEffect(() => {
      let mounted = true
      const refresh = () => connection.rpc.call('/api', 'safe-release-update.status', {}).then(result => { if (mounted && result.ok) setState(result.value) }).catch(() => { if (mounted) setState(null) })
      refresh(); const timer = setInterval(refresh, 30000)
      return () => { mounted = false; clearInterval(timer) }
    }, [connection])
    const available = ['available', 'prepared'].includes(state?.phase)
    return h('button', { onClick: () => navigation.openBundle('dsh-upgrade'), title: t.title, 'aria-label': available ? `${t.updateAvailable}: ${state.latest?.version}` : t.title }, available ? `${t.updateAvailable} ${state.latest?.version}` : '↑')
  }
  return {
    name: 'dsh-upgrade/client', inject: ['slots', 'connection', 'configForms', 'locale', 'pluginNavigation'],
    apply(ctx) {
      const form = ctx.configForms.get('safe-release-update')
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'safe-release-update', order: 90, inject: () => ({ connection: ctx.connection, locale: ctx.locale, navigation: ctx.pluginNavigation }) }, Badge))
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-upgrade', inject: () => ({ connection: ctx.connection, form, locale: ctx.locale }) }, Card))
    },
  }
} })
