import { ButtonIcon } from './ButtonIcon.js';
import { deploymentCopy, hostingCopy, type DeploymentSettingsView } from './project-deployment.js';

export function ProjectSettingsAccessible({ view, t, onActivate }: {
  view: DeploymentSettingsView; t: (key: string) => string; onActivate: (id: string) => void;
}) {
  const copy = deploymentCopy(view);
  const hosted = hostingCopy(view);
  return <section aria-label={t('projects.settings')} aria-busy={view.busy}>
    <h2>{t('deployment.title')}</h2><p>{t('deployment.journey')}</p>
    <fieldset disabled={!view.canEdit || view.busy}>
      <legend>{t('deployment.title')}</legend>
      {copy.choices.map(choice => <div key={choice.destination}>
        <label><input type="radio" name="deployment-destination" checked={choice.destination === view.destination}
          aria-describedby={`deployment-description-${choice.destination}`}
          onChange={() => onActivate(choice.id)} />{t(choice.label)}</label>
        <p id={`deployment-description-${choice.destination}`}>{t(choice.description)}</p>
      </div>)}
    </fieldset>
    <p>{t(copy.notice)}</p><p>{t('deployment.noSideEffects')}</p>
    {!view.canEdit ? <p>{t('deployment.adminOnly')}</p> : null}
    <p role={view.status === 'failed' || view.status === 'conflict' ? 'alert' : 'status'}>{copy.status ? t(copy.status) : ''}</p>
    <button type="button" disabled={copy.saveDisabled} onClick={() => onActivate('deployment.save')}>
      <ButtonIcon kind="check" />{t('deployment.save')}
    </button>
    {hosted ? <section aria-label={t('hosting.title')}>
      <h3>{t('hosting.title')}</h3><p>{t('hosting.private')}</p>
      <p role="status">{t(hosted.status)}</p>
      {hosted.version ? <p>{t('hosting.version')}: {hosted.version}</p> : null}
      {hosted.address ? <p>{t('hosting.address')}: {hosted.address}</p> : null}
      {hosted.url ? <p>{hosted.url}</p> : null}
      {hosted.candidateVersion ? <p>{t('hosting.candidateVersion')}: {hosted.candidateVersion}</p> : null}
      <p>{t('hosting.updateNotice')}</p>
      {hosted.buttons.map(button => <button key={button.id} type="button" disabled={Boolean(button.disabled)}
        onClick={() => onActivate(button.id)}><ButtonIcon kind={button.id === 'hosting.deploy' ? 'globe' : button.id === 'hosting.open' ? 'link' : 'close'} />{t(button.id)}</button>)}
    </section> : null}
  </section>;
}
