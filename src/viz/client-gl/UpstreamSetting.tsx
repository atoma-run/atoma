import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export function UpstreamSetting({ projectId, enabled, t }: {
  projectId: string; enabled: boolean; t: (key: string) => string;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const change = async () => {
    setBusy(true); setFailed(false);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/upstream`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followUpstream: !enabled }),
      });
      if (!response.ok) throw new Error('Setting refused');
      await queryClient.invalidateQueries({ queryKey: ['viz', 'projects'] });
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <span>
    <label><input type="checkbox" checked={enabled} disabled={busy}
      onChange={() => { void change(); }} />{t('projects.followUpstream')}</label>
    {failed ? <span role="alert">{t('projects.followUpstreamFailed')}</span> : null}
  </span>;
}
