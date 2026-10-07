import { useGpuStore } from './store.js';
import { workspaceChildren, workspaceParent, type WorkspaceBrowserData } from './workspace-browser.js';

export function WorkspaceAccessible({ data, t, onActivate }: {
  data?: WorkspaceBrowserData; t: (key: string) => string; onActivate?: (id: string) => void;
}) {
  const run = useGpuStore(s => s.workspaceRunId), path = useGpuStore(s => s.workspacePath);
  if (!run) return <button type="button" onClick={() => onActivate?.('workspace.project')}>{t('workspace.title')}</button>;
  const file = data?.index?.files.some(f => f.path === path);
  return <section aria-label={t('workspace.title')}>
    <button type="button" onClick={() => onActivate?.('workspace.close')}>{t('workspace.back')}</button>
    <p>{t('workspace.snapshot')}</p><p>{data?.index?.createdAt} · {path || '/'}</p>
    {path ? <button type="button" onClick={() => onActivate?.('workspace.path.' + workspaceParent(path))}>{t('workspace.parent')}</button> : null}
    {data?.failed ? <p role="alert">{t('workspace.unavailable')}</p> : data?.loading ? <p>{t('workspace.loading')}</p>
      : file ? data?.file?.kind === 'text' ? <pre>{data.file.text}</pre>
        : <p>{t(data?.file?.kind === 'too_large' ? 'workspace.tooLarge' : 'workspace.binary')}</p>
        : <ul>{workspaceChildren(data?.index ?? null, path).map(entry => <li key={entry.path}>
          <button type="button" onClick={() => onActivate?.('workspace.path.' + entry.path)}>{entry.name}{entry.directory ? '/' : ''}</button>
        </li>)}</ul>}
  </section>;
}
