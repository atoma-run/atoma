import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { computeProjectViewSchema, type ComputeProjectView } from '../../contracts/computeProject.js';
import type { ExecutionTarget } from '../../contracts/executionTarget.js';
export interface ComputeSettingsView {
  project: ComputeProjectView; selected: ExecutionTarget; busy: boolean;
  loadFailed?: boolean; notice: 'idle' | 'saved' | 'failed' | 'conflict';
}
export function computeTargetKey(target: ExecutionTarget): string { return target.kind === 'hosted' ? 'hosted' : target.deviceId; }
export function useProjectCompute(projectId: string | null, enabled: boolean) {
  const query = useQuery({ queryKey: ['compute', projectId], enabled: enabled && !!projectId, retry: false, refetchInterval: enabled ? 10_000 : false,
    queryFn: async () => {
      const response = await fetch(`/api/compute/projects/${encodeURIComponent(projectId!)}`);
      if (response.status === 404 || response.status === 503) return null;
      if (!response.ok) throw new Error('Compute settings unavailable');
      return computeProjectViewSchema.parse(await response.json());
    } });
  const [edit, setEdit] = useState<{ key: string; target: ExecutionTarget }>();
  const [notice, setNotice] = useState<{ projectId: string; value: ComputeSettingsView['notice'] }>();
  const [busy, setBusy] = useState(false), inFlight = useRef(false);
  const key = `${projectId}:${query.data ? computeTargetKey(query.data.target) : ''}`;
  const view = useMemo<ComputeSettingsView | null>(() => query.data ? { project: query.data,
    selected: edit?.key === key ? edit.target : query.data.target, busy, notice: notice?.projectId === projectId ? notice.value : 'idle', loadFailed: query.isError } : query.isError && projectId ? { project: { projectId, target: { kind: 'hosted' }, canEdit: false, hostedAllowed: false, devices: [] }, selected: { kind: 'hosted' }, busy, notice: 'failed', loadFailed: true } : null,
  [query.data, query.isError, edit, key, busy, notice, projectId]);
  const activate = useCallback((id: string) => {
    if (id === 'compute.setup') { window.location.assign(`/compute/setup?lang=${encodeURIComponent(document.documentElement.lang)}`); return; }
    if (id === 'compute.refresh') { void query.refetch(); return; }
    if (!view || !projectId || inFlight.current) return;
    const pending = id.startsWith('compute.finalize.') ? view.project.pendingRuns?.find(run => run.runId === id.slice('compute.finalize.'.length)) : undefined;
    if (pending) {
      inFlight.current = true; setBusy(true);
      void (async () => {
        try {
          const response = await fetch(`/api/compute/runs/${pending.runId}/finalize`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          });
          setNotice({ projectId, value: response.ok ? 'saved' : 'failed' });
          await query.refetch();
        } catch { setNotice({ projectId, value: 'failed' }); }
        finally { inFlight.current = false; setBusy(false); }
      })();
      return;
    }
    if (!view.project.canEdit || view.loadFailed) return;
    if (id.startsWith('compute.choose.')) {
      const deviceId = id.slice('compute.choose.'.length);
      if (deviceId === 'hosted' && view.project.hostedAllowed) setEdit({ key, target: { kind: 'hosted' } });
      else if (view.project.devices.some(device => device.deviceId === deviceId && device.allowed && !device.revoked)) setEdit({ key, target: { kind: 'customer-device', deviceId } });
      return;
    }
    const grant = id.startsWith('compute.grant.') ? view.project.devices.find(device => device.deviceId === id.slice('compute.grant.'.length)) : undefined;
    if (id !== 'compute.save' && !grant) return;
    if (grant?.revoked) return;
    inFlight.current = true; setBusy(true);
    void (async () => {
      try {
        const response = await fetch(grant ? `/api/compute/devices/${grant.deviceId}/projects` : `/api/compute/projects/${projectId}/target`, {
          method: grant ? 'POST' : 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(grant ? { projectId, allowed: !grant.allowed } : { target: view.selected, expected: view.project.target }),
        });
        if (!response.ok) { setNotice({ projectId, value: response.status === 409 ? 'conflict' : 'failed' }); }
        else { setNotice({ projectId, value: 'saved' }); setEdit(undefined); }
        await query.refetch();
      } catch { setNotice({ projectId, value: 'failed' }); }
      finally { inFlight.current = false; setBusy(false); }
    })();
  }, [view, projectId, key, query]);
  return { view, activate };
}
