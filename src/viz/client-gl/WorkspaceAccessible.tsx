import { ButtonIcon } from './ButtonIcon.js';
import { useGpuStore } from './store.js';
import { workspaceChildren, workspaceParent, type WorkspaceBrowserData } from './workspace-browser.js';

export function WorkspaceAccessible({ data, t, onActivate }: {
  data?: WorkspaceBrowserData; t: (key: string) => string; onActivate?: (id: string) => void;
}) {
  const run = useGpuStore(s => s.workspaceRunId), path = useGpuStore(s => s.workspacePath);
  if (!run) return null;
  return <section aria-label={t('workspace.title')}>
    <button type="button" onClick={() => onActivate?.('workspace.close')}><ButtonIcon kind="back" />{t('workspace.back')}</button>
    <p>{t('workspace.snapshot')}</p><p>{data?.index?.createdAt} · {path || '/'}</p>
    {path ? <button type="button" onClick={() => onActivate?.('workspace.path.' + workspaceParent(path))}><ButtonIcon kind="back" />{t('workspace.parent')}</button> : null}
    {data?.failed ? <p role="alert">{t('workspace.unavailable')}</p> : data?.loading ? <p>{t('workspace.loading')}</p>
      : <ul>{workspaceChildren(data?.index ?? null, path).map(entry => <li key={entry.path}>
          <button type="button" onClick={() => onActivate?.('workspace.path.' + entry.path)}><ButtonIcon kind={entry.directory ? 'folder' : 'file'} />{entry.name}{entry.directory ? '/' : ''}</button>
        </li>)}</ul>}
  </section>;
}
