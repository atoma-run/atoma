import { recommendedComputeBudget, type ComputeResourceBudget } from '../../contracts/computeLocal.js';
import { ButtonIcon } from '../../viz/client-gl/ButtonIcon.js';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ComputeDesktopApi, ComputeDesktopCommand, ComputeDesktopState, ComputeDesktopUpdateState, ComputeDesktopUpdateAction } from '../../contracts/computeDesktop.js';
import { computeDesktopStateSchema, computeDesktopUpdateStateSchema } from '../../contracts/computeDesktop.js';
import { SUPPORTED_LOCALES, LOCALE_NAMES, isLocale, localeDirection, type Locale } from '../../contracts/locales.js';
import { translate } from '../../viz/client/i18n-catalog.js';
import './style.css';
declare global { interface Window { compute: ComputeDesktopApi } }
function initialLocale(): Locale {
  const saved = localStorage.getItem('compute.locale');
  const language = saved ?? navigator.language.split('-')[0];
  return isLocale(language) ? language : 'en';
}
export function ComputeApp() {
  const [state, setState] = useState<ComputeDesktopState>();
  const [update, setUpdate] = useState<ComputeDesktopUpdateState>();
  const [locale, setLocale] = useState(initialLocale);
  const [view, setView] = useState('connection');
  const [name, setName] = useState<string>();
  const [budgetDraft, setBudgetDraft] = useState<ComputeResourceBudget>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const t = (key: string, vars?: Record<string, unknown>) => translate(locale, `compute.app.${key}`, vars);
  useEffect(() => {
    document.documentElement.lang = locale; document.documentElement.dir = localeDirection(locale); localStorage.setItem('compute.locale', locale); void window.compute.language(locale).catch(() => {});
  }, [locale]);
  useEffect(() => {
    const update = (input: ComputeDesktopState) => { const parsed = computeDesktopStateSchema.safeParse(input); if (parsed.success) setState(parsed.data); };
    const off = window.compute.subscribe(update);
    void window.compute.state().then(update).catch(() => setFailed(true));
    return off;
  }, []);
  useEffect(() => {
    const receive = (value: ComputeDesktopUpdateState) => { const parsed = computeDesktopUpdateStateSchema.safeParse(value); if (parsed.success) setUpdate(parsed.data); };
    const off = window.compute.subscribeUpdates(receive);
    void window.compute.updateState().then(receive).catch(() => {});
    return off;
  }, []);
  const updateAction = (action: ComputeDesktopUpdateAction) => { void window.compute.update(action).catch(() => setFailed(true)); };
  async function command(input: ComputeDesktopCommand) {
    setPending(true); setFailed(false);
    try { await window.compute.command(input); } catch { setFailed(true); }
    finally { setPending(false); }
  }
  const action = (input: ComputeDesktopCommand) => { void command(input); };
  const open = (link: 'atoma' | 'docker' | 'updates') => { void window.compute.open(link).catch(() => setFailed(true)); };
  const updatePending = update?.phase === 'waiting' || update?.phase === 'installing';
  const busy = pending || updatePending || Boolean(state && !['idle', 'error', 'connected'].includes(state.phase));
  const active = state?.allocations.filter(row => row.state !== 'stopped') ?? [];
  const current = active.find(row => row.state === 'unconfirmed') ?? active[0];
  const working = state?.connected && current && current.state !== 'unconfirmed' && state.phase === 'connected';
  const statusKey = state?.phase === 'connected' && current ? `allocation.${current.state}` : `phase.${state?.phase ?? 'loading'}`;
  const resourceLabel = (name: string) => {
    if (name.startsWith('atoma-worker-')) return t('service.tools');
    if (name.endsWith('-retrieval')) return t('service.search');
    if (name.endsWith('-control')) return t('service.workspace');
    if (name.startsWith('atoma-proxy-')) return t('service.network');
    if (name.includes('preview')) return t('service.preview');
    return name;
  };
  const checkpoints = state?.allocations.filter(row => row.checkpoint).sort((a, b) => (b.checkpoint?.confirmedAt ?? '').localeCompare(a.checkpoint?.confirmedAt ?? '')) ?? [];
  const bytes = (value: number) => `${(value / 1024 ** 3).toLocaleString(locale, { maximumFractionDigits: 1 })} GiB`;
  return <div className="shell">
    <aside><div className="brand"><img src="icon.png" alt="" /><span>Atoma <strong>Compute</strong></span></div>
      <nav aria-label={t('navigation')}>{['connection', 'diagnostic', 'activity', 'resources'].map(key => <button key={key} aria-current={view === key ? 'page' : undefined} onClick={() => setView(key)}>{t(`nav.${key}`)}</button>)}</nav>
      <p className="aside-note">{t('companion')}</p>
      <label className="language">{t('language')}<select value={locale} onChange={event => { if (isLocale(event.target.value)) setLocale(event.target.value); }}>{SUPPORTED_LOCALES.map(item => <option key={item} value={item}>{LOCALE_NAMES[item]}</option>)}</select></label>
    </aside>
    <main className={view === 'resources' ? 'resources-view' : undefined}><header><span className="eyebrow">{t('eyebrow')}</span><span className={`status ${state?.connected && current?.state !== 'unconfirmed' ? 'ready' : ''}`} role="status">{t(statusKey)}</span></header>
      {update && ['available', 'downloading', 'waiting', 'installing', 'error'].includes(update.phase) ? <section className="update-notice" aria-label={t('update.title')} aria-live="polite">
        <strong>{t(`update.${update.phase}`, { version: update.version ?? '' })}</strong>
        {update.phase === 'available' ? <><p>{t('update.body')}</p><button className="primary" onClick={() => updateAction('install')}>{t('update.install')}</button></> : null}
        {update.phase === 'downloading' ? <progress max="100" value={update.percent ?? 0} aria-label={t('download')} /> : null}
        {update.phase === 'waiting' ? <><p>{t('update.waitingBody')}</p><button onClick={() => updateAction('cancel')}>{t('update.cancel')}</button></> : null}
        {update.phase === 'error' ? <><p>{t('update.errorBody')}</p><button onClick={() => updateAction(update.version ? 'install' : 'check')}>{t('retry')}</button></> : null}
      </section> : null}
      {failed ? <div className="notice" role="alert">{t('commandFailed')} <button onClick={() => action({ action: 'refresh' })}>{t('retry')}</button></div> : null}
      {state?.issue ? <div className="notice" role="alert">{t(state.issue === 'docker' ? `issue.docker.${state.preparation?.target === 'windows-x64' ? 'windows' : 'mac'}` : `issue.${state.issue}`)}</div> : null}
      {view === 'connection' ? <>
        <h1>{t(working ? 'working' : state?.connected ? 'readyTitle' : 'welcome')}</h1><p className="lead">{t(working ? 'runningBody' : state?.connected ? 'readyBody' : 'intro')}</p>
        {!state?.connected ? <ol className="steps">{['account', 'prepare', 'run'].map((key, i) => <li key={key} className={(i === 0 && state?.paired) || (i === 1 && state?.connected) ? 'complete' : ''}><span>{i + 1}</span>{t(`step.${key}`)}</li>)}</ol> : null}
        <section className="card">
          {!state ? <p>{t('phase.loading')}</p> : !state.paired ? <>
            <h2>{t('accountTitle')}</h2><p>{t('accountBody')}</p>
            <label>{t('computerName')}<input maxLength={120} value={name ?? state.deviceName} onChange={event => setName(event.target.value)} disabled={busy} /></label>
            <button className="primary" disabled={busy || !(name ?? state.deviceName).trim()} onClick={() => action({ action: 'pair', name: (name ?? state.deviceName).trim() })}>{t('pair')}</button>
          </> : state.connected ? <><h2>{t(current ? `allocation.${current.state}` : state.allocations.length ? 'idle' : 'connectedTitle')}</h2>{current ? <p>{t('runIdentifier', { id: current.execution.runId.slice(0, 8) })}</p> : <p>{t(state.allocations.length ? 'waitingBody' : 'chooseProject')}</p>}{current ? <button className="primary" onClick={() => setView('activity')}>{t('viewActivity')}</button> : null}<button className="primary" onClick={() => open('atoma')}>{t('openAtoma')}</button><p className="fine">{t('background')}</p></> : <>
            <h2>{t('prepareTitle')}</h2><p>{t(state.preparation?.stage === 'ready' ? 'prepareDetected' : 'prepareBody')}</p>
            {state.download ? <><progress max={state.download.total} value={state.download.completed} aria-label={t('download')} /><p>{t('downloadProgress', { completed: state.download.completed, total: state.download.total })}</p>{state.phase === 'downloading' && state.download.completed < state.download.total ? <p role="status">{t(`component.${['workspace', 'tools', 'search', 'preview'][state.download.completed]}`)}{state.imageProgress ? <> · {t('imageProgress', { ready: state.imageProgress.readyLayers, total: state.imageProgress.layers, minutes: Math.floor(state.imageProgress.elapsedSeconds / 60), seconds: String(state.imageProgress.elapsedSeconds % 60).padStart(2, '0') })}</> : null}</p> : null}</> : null}
            <button className="primary" disabled={busy} onClick={() => action({ action: 'prepare' })}>{t('prepare')}</button>
            <button disabled={busy} onClick={() => action({ action: 'connect' })}>{t('connect')}</button>
            
          </>}
          {(busy || state?.preparationPending) && state?.phase !== 'stopping' ? <button onClick={() => action({ action: 'cancel' })} disabled={pending}>{t('cancel')}</button> : null}
        </section>
        {state?.preparation && !state.connected ? <section className="card" aria-live="polite">
          <h2>{t('preparation.title')}</h2><p>{t(state.preparation.stage === 'start-failed' ? `preparation.start-failed.${state.preparation.target === 'windows-x64' ? 'windows' : 'mac'}` : `preparation.${state.preparation.stage}`)}</p>
          {state.preparation.stage === 'installer-download' ? <><progress max={state.preparation.totalBytes ?? undefined} value={state.preparation.totalBytes ? state.preparation.downloadedBytes : undefined} aria-label={t('preparation.installer-download')} /><p>{bytes(state.preparation.downloadedBytes)}</p></> : null}
          {['install-required', 'download-failed', 'installer-open'].includes(state.preparation.stage) ? <button className="primary" disabled={busy} onClick={() => action({ action: 'install-docker' })}><ButtonIcon kind="download" />{t('preparation.installDocker')}</button> : null}
          {state.preparation.stage === 'wsl-required' ? <button className="primary" disabled={busy} onClick={() => action({ action: 'install-wsl' })}><ButtonIcon kind="download" />{t('preparation.installWsl')}</button> : null}
          <button disabled={busy} onClick={() => action({ action: 'refresh' })}><ButtonIcon kind="refresh" />{t('preparation.check')}</button>{state?.preparation && state.preparation.stage !== 'ready' && state.preparation.stage !== 'starting' ? <button onClick={() => open('docker')}>{t('dockerHelp')}</button> : null}
          {state.preparation.stage !== 'ready' && state.preparation.stage !== 'starting' ? <p className="fine">{t('preparation.consent')}</p> : null}{state.preparationPending ? <p className="fine">{t('preparation.resume')}</p> : null}
        </section> : null}<p className="fine">{t('privacy')}</p>
      </> : view === 'diagnostic' ? <>
        <h1>{t('nav.diagnostic')}</h1><p className="lead">{t('diagnosticBody')}</p>
        <section className="card"><h2>Docker Desktop</h2><p>{state?.diagnostic ? t('diagnosticOk', { version: state.diagnostic.version }) : t('diagnosticNeeded')}</p>
          <button className="primary" disabled={busy || state?.connected || !state?.paired} onClick={() => action({ action: 'diagnose' })}>{t('diagnose')}</button>{state?.preparation && state.preparation.stage !== 'ready' && state.preparation.stage !== 'starting' ? <button onClick={() => open('docker')}>{t('dockerHelp')}</button> : null}
          <p className="fine">{t(state?.preparation?.target === 'windows-x64' ? 'requirements.windows' : 'requirements.mac')}</p></section>
      </> : view === 'activity' ? <>
        <h1>{t('nav.activity')}</h1><p className="lead">{t(state?.accepting ? 'accepting' : 'draining')}</p>
        <section className="card"><h2>{active.length ? t('working') : t('idle')}</h2>{active.map(row => <p key={row.allocationId}>{t(`allocation.${row.state}`)} · <code>{row.execution.runId.slice(0, 8)}</code></p>)}
          <div className="actions"><button disabled={pending || updatePending || !state?.connected} onClick={() => action({ action: state?.accepting ? 'drain' : 'accept' })}>{t(state?.accepting ? 'drain' : 'accept')}</button>
          <button disabled={pending || !state?.connected || !active.length} onClick={() => action({ action: 'pause' })}>{t('pause')}</button>
          <button className="danger" disabled={pending || !state?.connected || !active.length} onClick={() => { if (window.confirm(t('stopConfirm'))) action({ action: 'stop' }); }}>{t('stop')}</button></div>
          <p className="fine">{t('recovery')}</p>
        </section><section className="card"><h2>{t('checkpoint')}</h2><p>{checkpoints[0]?.checkpoint ? new Date(checkpoints[0].checkpoint.confirmedAt).toLocaleString(locale) : t('noCheckpoint')}</p></section>
        {state?.transfers.length ? <section className="card"><h2>{t('transfers')}</h2>{state.transfers.map(row => <p key={row.id}>{t(`transfer.${row.state}`)} · {bytes(row.bytes)}</p>)}</section> : null}
      </> : <>
        <h1>{t('nav.resources')}</h1><p className="lead">{t('resourcesBody')}</p>
        <div className="metrics">{[['cpu', state?.diagnostic?.cpus.toString()], ['ram', state?.diagnostic && bytes(state.diagnostic.memoryBytes)], ['disk', state?.diagnostic && bytes(state.diagnostic.hostDiskBytes)]].map(([key, value]) => <section className="card" key={key}><h2>{t(`resource.${key}`)}</h2><strong>{value ?? '—'}</strong></section>)}</div>
        <section className="card"><h2>{t('usage')}</h2>{state?.resources.length ? state.resources.map(row => <div className="resource-row" key={row.workload}><h3>{resourceLabel(row.workload)}</h3><p>{row.cpuPercent.toLocaleString(locale, { maximumFractionDigits: 1 })}% CPU · {row.memory}</p></div>) : <p>{t('idle')}</p>}<p className="fine">{t('resourceBudget')}</p></section>
        {state?.diagnostic && state.resourceBudget && <details className="resource-settings"><summary>{t('budget.title')} · {state.resourceBudget.cpus} CPU · {state.resourceBudget.memoryGiB} GiB</summary>
          <p className="fine">{t('budget.help')}</p>
          <form onSubmit={event => { event.preventDefault(); void command({ action: 'resources', budget: budgetDraft ?? state.resourceBudget! }); }}>
            <div className="budget-fields">
              <label>{t('budget.cpu')}<input type="number" min="5" max={state.diagnostic.cpus} step="1" required value={(budgetDraft ?? state.resourceBudget).cpus} onChange={event => setBudgetDraft({ ...(budgetDraft ?? state.resourceBudget!), cpus: event.currentTarget.valueAsNumber })}/></label>
              <label>{t('budget.memory')}<input type="number" min="6" max={Math.floor(state.diagnostic.memoryBytes / 1024 ** 3)} step="1" required value={(budgetDraft ?? state.resourceBudget).memoryGiB} onChange={event => setBudgetDraft({ ...(budgetDraft ?? state.resourceBudget!), memoryGiB: event.currentTarget.valueAsNumber })}/></label>
            </div>
            <button type="submit" disabled={pending}>{t('budget.save')}</button>
            <button type="button" onClick={() => setBudgetDraft(recommendedComputeBudget(state.diagnostic!))}>{t('budget.recommended')}</button>
          </form>
          <p className="fine">{t('budget.nextRun')}</p>
          {current && state.activeResourceBudget && <p className="fine">{t('budget.active', { cpus: state.activeResourceBudget.cpus, memory: state.activeResourceBudget.memoryGiB })}</p>}
        </details>}
        <details className="update-settings"><summary>{t('update.title')}</summary>
          {update?.phase === 'unsupported' ? <p className="fine">{t('update.unsupported')}</p> : update && ['idle', 'checking', 'current'].includes(update.phase) ? <p className="fine" role="status">{t(`update.${update.phase}`)}</p> : null}
          <button disabled={update?.phase === 'checking' || update?.phase === 'downloading' || updatePending} onClick={() => open('updates')}>{t(update?.phase === 'unsupported' ? 'update.manual' : 'updates')}</button>
        </details>
      </>}
      <footer><span>{t('footer')}</span>{state?.connected ? <button disabled={pending} onClick={() => { if (window.confirm(t('stopConfirm'))) action({ action: 'disconnect' }); }}>{t('disconnect')}</button> : null}</footer>
    </main>
  </div>;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<ComputeApp />);
