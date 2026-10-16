import { useState } from 'react';
import { ButtonIcon } from './ButtonIcon.js';
import { buttonIconKind } from './button-icons.js';
import { HOSTING_SUBDOMAIN_MAX } from '../../contracts/projectDeployment.js';
import { deploymentCopy, hostingCopy, type DeploymentSettingsView } from './project-deployment.js';
import { connectorsCopy, type ConnectorSettingsView } from './project-connectors.js';

export function ProjectSettingsAccessible({ view, t, onActivate, onRenameAddress, connectors }: {
  view: DeploymentSettingsView; t: (key: string, vars?: Record<string, unknown>) => string; onActivate: (id: string) => void;
  onRenameAddress?: (subdomain: string) => void;
  connectors?: ConnectorSettingsView | null;
}) {
  const copy = deploymentCopy(view);
  const hosted = hostingCopy(view);
  const control = (button: { id: string; disabled?: boolean }) => <button key={button.id} type="button" disabled={Boolean(button.disabled)}
    onClick={() => onActivate(button.id)}><ButtonIcon kind={buttonIconKind(button.id)} />{t(button.id)}</button>;
  return <section aria-label={t('projects.settings')} aria-busy={view.busy}>
    {hosted ? <section aria-label={t('hosting.title')}>
      <h3>{t('hosting.title')}</h3>
      <p role="status">{t(hosted.status)}{hosted.version && hosted.tone === 'success' ? ` · ${t('hosting.versionShort', { version: hosted.version })}` : ''}</p>
      {hosted.address ? <p>{t('hosting.address')}: {hosted.actions.some(action => action.id === 'hosting.open')
        ? <button type="button" onClick={() => onActivate('hosting.open')}>{hosted.address}</button> : hosted.address}</p> : null}
      {hosted.actions.map(control)}
      {view.renaming && hosted.label && hosted.domain && onRenameAddress ?
        <AddressForm key={hosted.label} label={hosted.label} domain={hosted.domain} view={view} t={t}
          onSave={onRenameAddress} onCancel={() => onActivate('hosting.renameCancel')} /> : null}
      {hosted.update ? <>
        <h4>{t('hosting.updateTitle')}</h4>
        <p>{t(hosted.update, { version: hosted.candidateVersion })}</p>
        {hosted.deploy ? control(hosted.deploy) : null}
      </> : null}
      {hosted.stop ? control(hosted.stop) : null}
      <p>{t('hosting.private')}</p>
    </section> : null}
    <h2>{t('deployment.title')}</h2><p>{t('deployment.intro')}</p>
    <fieldset disabled={!view.canEdit || view.busy}>
      <legend>{t('deployment.title')}</legend>
      {copy.choices.map(choice => <div key={choice.destination}>
        <label><input type="radio" name="deployment-destination" checked={choice.destination === view.destination}
          aria-describedby={`deployment-description-${choice.destination}`}
          onChange={() => onActivate(choice.id)} />{t(choice.label)}</label>
        <p id={`deployment-description-${choice.destination}`} hidden={choice.destination !== view.destination}>{t(choice.description)}</p>
      </div>)}
    </fieldset>
    {copy.notice ? <p>{t(copy.notice)}</p> : null}
    {!view.canEdit ? <p>{t('deployment.adminOnly')}</p> : null}
    <p role={view.status === 'failed' || view.status === 'conflict' ? 'alert' : 'status'}>{copy.status ? t(copy.status) : ''}</p>
    {copy.showSave ? <button type="button" disabled={copy.saveDisabled} onClick={() => onActivate('deployment.save')}>
      <ButtonIcon kind="check" />{t('deployment.save')}
    </button> : null}
    {connectors ? <ConnectorsSection view={connectors} t={t} onActivate={onActivate} /> : null}
  </section>;
}

/** The organisation's MCP servers this project's runs may use: the GPU card's twin. */
function ConnectorsSection({ view, t, onActivate }: {
  view: ConnectorSettingsView; t: (key: string, vars?: Record<string, unknown>) => string; onActivate: (id: string) => void;
}) {
  const model = connectorsCopy(view);
  return <section aria-label={t('connectors.title')} aria-busy={view.busy}>
    <h2>{t('connectors.title')}</h2><p>{t('connectors.intro')}</p>
    {model.empty ? <p>{t(model.empty)}</p> : null}
    {model.rows.length > 0 ? <fieldset disabled={!view.canEdit || view.busy}>
      <legend>{t('connectors.title')}</legend>
      {model.rows.map(row => <div key={row.id}>
        <label><input type="checkbox" checked={row.checked} aria-describedby={`${row.id}-detail`}
          onChange={() => onActivate(row.id)} />{row.name}</label>
        <p id={`${row.id}-detail`}>{t(row.detail, { ...row.detailVars, status: t(String(row.detailVars['status'])) })}</p>
      </div>)}
    </fieldset> : null}
    {!view.canEdit && !view.loading ? <p>{t('connectors.adminOnly')}</p> : null}
    <p role={view.status === 'failed' || view.status === 'conflict' ? 'alert' : 'status'}>{model.status ? t(model.status) : ''}</p>
    {model.showSave ? <button type="button" disabled={model.saveDisabled} onClick={() => onActivate('connectors.save')}>
      <ButtonIcon kind="check" />{t('connectors.save')}
    </button> : null}
    {model.showOpenSettings ? <button type="button" onClick={() => onActivate('connectors.openSettings')}>
      <ButtonIcon kind="settings" />{t('connectors.openSettings')}
    </button> : null}
  </section>;
}

/**
 * The address field. It lives in the accessibility bridge, which becomes the
 * visible keyboard palette while it holds focus: the canvas draws no text
 * input, and a second framed overlay is what the overlay stack forbids.
 */
function AddressForm({ label, domain, view, t, onSave, onCancel }: {
  label: string; domain: string; view: DeploymentSettingsView; t: (key: string, vars?: Record<string, unknown>) => string;
  onSave: (subdomain: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(label);
  return <form className="gpu-address-form" aria-label={t('hosting.renameTitle')} onSubmit={event => { event.preventDefault(); onSave(value); }}
    onKeyDown={event => { if (event.key === 'Escape') onCancel(); }}>
    <label>{t('hosting.renameLabel')}
      <input autoFocus type="text" value={value} maxLength={HOSTING_SUBDOMAIN_MAX} spellCheck={false} autoCapitalize="none" autoComplete="off"
        aria-describedby="hosting-rename-rule" aria-invalid={view.renameError === 'invalid'} disabled={view.renameBusy}
        onChange={event => setValue(event.target.value)} />
      <span>.{domain}</span>
    </label>
    <p id="hosting-rename-rule">{t('hosting.renameRule')}</p>
    <p>{t('hosting.renameRedirect')}</p>
    {view.renameError ? <p role="alert">{t(`hosting.rename.${view.renameError}`)}</p> : null}
    <button type="submit" disabled={view.renameBusy || value.trim().toLowerCase() === label}><ButtonIcon kind="save" />{t('hosting.renameSave')}</button>
    <button type="button" onClick={onCancel}><ButtonIcon kind="close" />{t('hosting.renameCancel')}</button>
  </form>;
}
