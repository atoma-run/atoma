import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ComputeDesktopApi, ComputeDesktopCommand, ComputeDesktopState } from '../../contracts/computeDesktop.js';
import { computeDesktopStateSchema } from '../../contracts/computeDesktop.js';
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
  const [locale, setLocale] = useState(initialLocale);
  const [view, setView] = useState('connection');
  const [name, setName] = useState<string>();
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
  async function command(input: ComputeDesktopCommand) {
    setPending(true); setFailed(false);
    try { await window.compute.command(input); } catch { setFailed(true); }
    finally { setPending(false); }
  }
  const action = (input: ComputeDesktopCommand) => { void command(input); };
  const open = (link: 'atoma' | 'docker' | 'updates') => { void window.compute.open(link).catch(() => setFailed(true)); };
  const busy = pending || Boolean(state && !['idle', 'error', 'connected'].includes(state.phase));
  const active = state?.allocations.filter(row => row.state !== 'stopped') ?? [];
  const checkpoints = state?.allocations.filter(row => row.checkpoint).sort((a, b) => (b.checkpoint?.confirmedAt ?? '').localeCompare(a.checkpoint?.confirmedAt ?? '')) ?? [];
  const bytes = (value: number) => `${(value / 1024 ** 3).toLocaleString(locale, { maximumFractionDigits: 1 })} GiB`;
  return <div className="shell">
    <aside><div className="brand"><img src="icon.png" alt="" /><span>Atoma <strong>Compute</strong></span></div>
      <nav aria-label={t('navigation')}>{['connection', 'diagnostic', 'activity', 'resources'].map(key => <button key={key} aria-current={view === key ? 'page' : undefined} onClick={() => setView(key)}>{t(`nav.${key}`)}</button>)}</nav>
      <p className="aside-note">{t('companion')}</p>
      <label className="language">{t('language')}<select value={locale} onChange={event => { if (isLocale(event.target.value)) setLocale(event.target.value); }}>{SUPPORTED_LOCALES.map(item => <option key={item} value={item}>{LOCALE_NAMES[item]}</option>)}</select></label>
    </aside>
    <main><header><span className="eyebrow">{t('eyebrow')}</span><span className={`status ${state?.connected ? 'ready' : ''}`} role="status">{t(`phase.${state?.phase ?? 'loading'}`)}</span></header>
      {failed ? <div className="notice" role="alert">{t('commandFailed')} <button onClick={() => action({ action: 'refresh' })}>{t('retry')}</button></div> : null}
      {state?.issue ? <div className="notice" role="alert">{t(`issue.${state.issue}`)}</div> : null}
      {view === 'connection' ? <>
        <h1>{t(state?.connected ? 'readyTitle' : 'welcome')}</h1><p className="lead">{t(state?.connected ? 'readyBody' : 'intro')}</p>
        <ol className="steps">{['account', 'prepare', 'run'].map((key, i) => <li key={key} className={(i === 0 && state?.paired) || (i === 1 && state?.connected) ? 'complete' : ''}><span>{i + 1}</span>{t(`step.${key}`)}</li>)}</ol>
        <section className="card">
          {!state ? <p>{t('phase.loading')}</p> : !state.paired ? <>
            <h2>{t('accountTitle')}</h2><p>{t('accountBody')}</p>
            <label>{t('computerName')}<input maxLength={120} value={name ?? state.deviceName} onChange={event => setName(event.target.value)} disabled={busy} /></label>
            <button className="primary" disabled={busy || !(name ?? state.deviceName).trim()} onClick={() => action({ action: 'pair', name: (name ?? state.deviceName).trim() })}>{t('pair')}</button>
          </> : state.connected ? <><h2>{t('connectedTitle')}</h2><p>{t('chooseProject')}</p><button className="primary" onClick={() => open('atoma')}>{t('openAtoma')}</button><p className="fine">{t('background')}</p></> : <>
            <h2>{t('prepareTitle')}</h2><p>{t('prepareBody')}</p>
            {state.download ? <><progress max={state.download.total} value={state.download.completed} aria-label={t('download')} /><p>{t('downloadProgress', { completed: state.download.completed, total: state.download.total })}</p></> : null}
            <button className="primary" disabled={busy} onClick={() => action({ action: 'prepare' })}>{t('prepare')}</button>
            <button disabled={busy} onClick={() => action({ action: 'connect' })}>{t('connect')}</button>
            <button className="text" onClick={() => open('docker')}>{t('getDocker')}</button>
          </>}
          {busy && state?.phase !== 'stopping' ? <button onClick={() => action({ action: 'cancel' })} disabled={pending}>{t('cancel')}</button> : null}
        </section><p className="fine">{t('privacy')}</p>
      </> : view === 'diagnostic' ? <>
        <h1>{t('nav.diagnostic')}</h1><p className="lead">{t('diagnosticBody')}</p>
        <section className="card"><h2>Docker Desktop</h2><p>{state?.diagnostic ? t('diagnosticOk', { version: state.diagnostic.version }) : t('diagnosticNeeded')}</p>
          <button className="primary" disabled={busy || state?.connected || !state?.paired} onClick={() => action({ action: 'diagnose' })}>{t('diagnose')}</button><button onClick={() => open('docker')}>{t('getDocker')}</button>
          <p className="fine">{t('requirements')}</p></section>
      </> : view === 'activity' ? <>
        <h1>{t('nav.activity')}</h1><p className="lead">{t(state?.accepting ? 'accepting' : 'draining')}</p>
        <section className="card"><h2>{active.length ? t('working') : t('idle')}</h2>{active.map(row => <p key={row.allocationId}>{t(`allocation.${row.state}`)} · <code>{row.execution.runId.slice(0, 8)}</code></p>)}
          <div className="actions"><button disabled={pending || !state?.connected} onClick={() => action({ action: state?.accepting ? 'drain' : 'accept' })}>{t(state?.accepting ? 'drain' : 'accept')}</button>
          <button disabled={pending || !state?.connected || !active.length} onClick={() => action({ action: 'pause' })}>{t('pause')}</button>
          <button className="danger" disabled={pending || !state?.connected || !active.length} onClick={() => { if (window.confirm(t('stopConfirm'))) action({ action: 'stop' }); }}>{t('stop')}</button></div>
          <p className="fine">{t('recovery')}</p>
        </section><section className="card"><h2>{t('checkpoint')}</h2><p>{checkpoints[0]?.checkpoint ? new Date(checkpoints[0].checkpoint.confirmedAt).toLocaleString(locale) : t('noCheckpoint')}</p></section>
        {state?.transfers.length ? <section className="card"><h2>{t('transfers')}</h2>{state.transfers.map(row => <p key={row.id}>{t(`transfer.${row.state}`)} · {bytes(row.bytes)}</p>)}</section> : null}
      </> : <>
        <h1>{t('nav.resources')}</h1><p className="lead">{t('resourcesBody')}</p>
        <div className="metrics">{[['cpu', state?.diagnostic?.cpus.toString()], ['ram', state?.diagnostic && bytes(state.diagnostic.memoryBytes)], ['disk', state?.diagnostic && bytes(state.diagnostic.hostDiskBytes)]].map(([key, value]) => <section className="card" key={key}><h2>{t(`resource.${key}`)}</h2><strong>{value ?? '—'}</strong></section>)}</div>
        <section className="card"><h2>{t('usage')}</h2>{state?.resources.length ? state.resources.map(row => <p key={row.workload}>{row.cpuPercent.toFixed(1)}% CPU · {row.memory}</p>) : <p>{t('idle')}</p>}<p className="fine">{t('resourceBudget')}</p></section>
        <button onClick={() => open('updates')}>{t('updates')}</button>
      </>}
      <footer><span>{t('footer')}</span>{state?.connected ? <button disabled={pending} onClick={() => { if (window.confirm(t('stopConfirm'))) action({ action: 'disconnect' }); }}>{t('disconnect')}</button> : null}</footer>
    </main>
  </div>;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<ComputeApp />);
