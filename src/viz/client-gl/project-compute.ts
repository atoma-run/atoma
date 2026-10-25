import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { computeProjectViewSchema, type ComputeProjectView } from '../../contracts/computeProject.js';
import type { ExecutionTarget } from '../../contracts/executionTarget.js';
import { formatDateTime } from '../client/date-format.js';
import { computeResultsAttempt } from './compute-results.js';
export interface ComputeSettingsView {
  project: ComputeProjectView; selected: ExecutionTarget; busy: boolean;
  loadFailed?: boolean;
  notice: 'idle' | 'saved' | 'failed' | 'conflict' | 'resultsArrived' | 'resultsPending' | 'resultsGetting' | 'runClosed' | 'closePending';
}
/** Notices that report progress or success, read as a status rather than an alert. */
export function computeNoticeIsStatus(notice: ComputeSettingsView['notice']): boolean {
  return notice === 'saved' || notice === 'resultsArrived' || notice === 'resultsGetting' || notice === 'runClosed';
}
type PendingRun = NonNullable<ComputeProjectView['pendingRuns']>[number];
/** The journal phases whose runner ended: only the files are left to fetch. */
export function pendingRunHasResults(run: PendingRun): boolean { return run.phase === 'finalizing' || run.phase === 'transferred'; }
/**
 * ONE row model for a pending Compute run, GPU and accessible alike: named by
 * its title (else its goal) and start, never by an id, with plain copy and an
 * action that match what it is. Finished work gets "Get the results"; a run
 * that stopped before it finished gets "Close this run" (an older server sends
 * no phase and keeps the results wording it always had).
 */
export function pendingComputeRunRow(run: PendingRun, t: (key: string, vars?: Record<string, unknown>) => string, locale: string) {
  const results = run.phase === undefined || pendingRunHasResults(run);
  const vars = { label: run.label ?? t('compute.pendingUnnamed'), date: run.startedAt ? formatDateTime(run.startedAt, locale) : '—' };
  return { text: t(results ? 'compute.pending' : 'compute.pendingInterrupted', vars),
    action: { id: `${results ? 'compute.finalize.' : 'compute.close.'}${run.runId}`, label: results ? 'compute.finalize' : 'compute.close' } };
}
export const COMPUTE_CONTACT_HREF = 'mailto:mgf@iotanet.net?subject=Atoma%20Compute';
export function showComputeSetup(project: ComputeProjectView): boolean { return project.devices.length === 0; }
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
    if (id === 'compute.contact') { window.location.assign(COMPUTE_CONTACT_HREF); return; }
    if (id === 'compute.refresh') { void query.refetch(); return; }
    if (!view || !projectId || inFlight.current) return;
    const closing = id.startsWith('compute.close.');
    const pendingId = id.startsWith('compute.finalize.') ? id.slice('compute.finalize.'.length) : closing ? id.slice('compute.close.'.length) : null;
    const pending = pendingId ? view.project.pendingRuns?.find(run => run.runId === pendingId) : undefined;
    if (pending) {
      // One route for both: it fetches finished files, or closes a run whose
      // computer confirmed it stopped. A transfer already running (often the
      // automatic one) or a timed-out request is still working, never "try again".
      inFlight.current = true; setBusy(true);
      void (async () => {
        let value: ComputeSettingsView['notice'];
        try {
          const response = await fetch(`/api/compute/runs/${pending.runId}/finalize`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          });
          let reason: unknown;
          if (!response.ok) { try { reason = ((await response.json()) as { reason?: unknown }).reason; } catch { /* no body */ } }
          value = response.ok ? closing ? 'runClosed' : 'resultsArrived'
            : !closing && computeResultsAttempt({ status: response.status, reason }) === 'working' ? 'resultsGetting'
            : closing ? 'closePending' : 'resultsPending';
        } catch { value = closing ? 'closePending' : 'resultsGetting'; }
        setNotice({ projectId, value });
        try { await query.refetch(); } finally { inFlight.current = false; setBusy(false); }
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
