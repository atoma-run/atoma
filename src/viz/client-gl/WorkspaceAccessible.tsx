import { ButtonIcon } from './ButtonIcon.js';
import { useGpuStore } from './store.js';
import { workspaceChildren, workspaceParent, type WorkspaceBrowserData } from './workspace-browser.js';

export function WorkspaceAccessible({ data, t, onActivate }: {
  data?: WorkspaceBrowserData; t: (key: string) => string; onActivate?: (id: string) => void;
}) {
  const run = useGpuStore(s => s.workspaceRunId), path = useGpuStore(s => s.workspacePath);
  const previewPath = useGpuStore(s => s.filePreview?.runId === s.workspaceRunId ? s.filePreview?.path : undefined);
  if (!run) return null;
  return <section aria-label={t('workspace.title')}>
    <button type="button" onClick={() => onActivate?.('workspace.close')}><ButtonIcon kind="back" />{t('workspace.back')}</button>
    <p>{t('workspace.snapshot')}</p><p>{data?.index?.createdAt}{path ? ` · ${path}` : ''}</p>
    {!path && data?.localDocker ? <section aria-label={t('localDocker.title')}>
      <h3>{t('localDocker.title')}</h3><p>{t('localDocker.steps')}</p>
      <p role="status">{t(`localDocker.status.${data.localDocker.status}`)}</p>
      {data.localDocker.config ? <>
        <button type="button" onClick={() => onActivate?.('localDocker.install')}>{t('localDocker.install')}</button>
        <button type="button" disabled={data.localDocker.status === 'downloading'} onClick={() => onActivate?.('localDocker.download')}>{t('localDocker.download')}</button>
        <button type="button" onClick={() => onActivate?.('localDocker.open')}>{t('localDocker.open')}</button>
        {data.localDocker.config.verificationUrl ? <button type="button" onClick={() => onActivate?.('localDocker.verify')}>{t('localDocker.verify')}</button> : null}
      </> : null}<p>{t('localDocker.localOnly')}</p>
    </section> : null}
    {path ? <button type="button" onClick={() => onActivate?.('workspace.path.' + workspaceParent(path))}><ButtonIcon kind="back" />{t('workspace.parent')}</button> : null}
    {data?.failed ? <p role="alert">{t('workspace.unavailable')}</p> : data?.loading ? <p>{t('workspace.loading')}</p>
      : <ul>{workspaceChildren(data?.index ?? null, path).map(entry => <li key={entry.path}>
          <button type="button" aria-current={!entry.directory && entry.path === previewPath ? 'true' : undefined}
            onClick={() => onActivate?.('workspace.path.' + entry.path)}><ButtonIcon kind={entry.directory ? 'folder' : 'file'} />{entry.name}{entry.directory ? '/' : ''}</button>
        </li>)}</ul>}
  </section>;
}
