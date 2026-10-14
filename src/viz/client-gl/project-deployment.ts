import { hostingSummarySchema, type HostingSummary } from '../../contracts/projectHosting.js';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deploymentDestinationSchema, type DeploymentDestination } from '../../contracts/projectDeployment.js';
import type { VizProject } from '../client/types.js';

export interface DeploymentSettingsView {
  hosting?: HostingSummary | null;
  hostingBusy?: boolean;
  hostingError?: boolean;
  destination: DeploymentDestination;
  saved: DeploymentDestination;
  canEdit: boolean;
  busy: boolean;
  status: 'idle' | 'saved' | 'failed' | 'conflict';
}

export function useProjectDeployment(project: VizProject | null | undefined, canEdit: boolean) {
  const client = useQueryClient();
  const [edit, setEdit] = useState<{ key: string; destination: DeploymentDestination; status: DeploymentSettingsView['status'] }>();
  const [saving, setSaving] = useState<string>();
  const inFlight = useRef(false);
  const saved = project?.deploymentDestination ?? 'none';
  const [hostingBusy, setHostingBusy] = useState(false);
  const [hostingError, setHostingError] = useState(false);
  const hosting = useQuery({ queryKey: ['hosting', project?.projectId], enabled: !!project,
    retry: false, refetchInterval: project ? 5000 : false,
    queryFn: async () => {
      const response = await fetch(`/api/projects/${encodeURIComponent(project!.projectId)}/hosting`);
      if (response.status === 503) return null;
      if (!response.ok) throw new Error('Hosting unavailable');
      return hostingSummarySchema.parse(await response.json());
    } });
  // A change of project or a refreshed server preference discards the old draft.
  const key = `${project?.projectId}:${saved}`;
  const view = useMemo<DeploymentSettingsView>(() => ({ destination: edit?.key === key ? edit.destination : saved,
    hosting: hosting.data, hostingBusy, hostingError: hostingError || hosting.isError, saved, canEdit, busy: saving === project?.projectId && saving !== undefined,
    status: edit?.key === key ? edit.status : 'idle' }), [edit, key, saved, canEdit, saving, project?.projectId, hosting.data, hostingBusy, hostingError, hosting.isError]);
  const activate = useCallback((id: string) => {
    if (!project || inFlight.current) return;
    if (id.startsWith('hosting.')) {
      const action = id.slice('hosting.'.length);
      if (!['deploy', 'stop', 'open'].includes(action) || !hosting.data || hostingBusy || (action !== 'open' && !canEdit)) return;
      const candidate = hosting.data.candidate;
      if (action === 'deploy' && !candidate) return;
      const popup = action === 'open' ? window.open('about:blank', '_blank') : null;
      if (action === 'open' && !popup) { setHostingError(true); return; }
      if (popup) popup.opener = null;
      setHostingBusy(true); setHostingError(false); inFlight.current = true;
      void (async () => {
        try {
          const response = await fetch(`/api/projects/${encodeURIComponent(project.projectId)}/hosting/${action}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(action === 'deploy' ? { runId: candidate!.runId, manifestHash: candidate!.manifestHash,
              expectedDeploymentId: hosting.data!.deploymentId } : { expectedDeploymentId: hosting.data!.deploymentId }),
          });
          if (!response.ok) throw new Error('Hosting request failed');
          if (action === 'open') {
            const result = await response.json() as { url: string };
            if (new URL(result.url).origin !== new URL(hosting.data!.url!).origin) throw new Error('Unexpected application address');
            if (popup) popup.location.replace(result.url);
          }
          await hosting.refetch();
        } catch { popup?.close(); setHostingError(true); }
        finally { inFlight.current = false; setHostingBusy(false); }
      })();
      return;
    }
    if (!canEdit) return;
    if (id.startsWith('deployment.choose.')) {
      const destination = deploymentDestinationSchema.safeParse(id.slice('deployment.choose.'.length));
      if (destination.success) setEdit({ key, destination: destination.data, status: 'idle' });
    } else if (id === 'deployment.save' && view.destination !== saved) {
      const projectId = project.projectId;
      const destination = view.destination;
      inFlight.current = true; setSaving(projectId);
      void (async () => {
        try {
          const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/deployment`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ destination, expectedDestination: saved }),
          });
          if (!response.ok) {
            setEdit({ key, destination, status: response.status === 409 ? 'conflict' : 'failed' });
            return;
          }
          client.setQueryData<VizProject[]>(['viz', 'projects'], rows => rows?.map(row =>
            row.projectId === projectId ? { ...row, deploymentDestination: destination } : row));
          setEdit({ key: `${projectId}:${destination}`, destination, status: 'saved' });
          await client.invalidateQueries({ queryKey: ['viz', 'projects'] });
        } catch { setEdit({ key, destination, status: 'failed' }); }
        finally { inFlight.current = false; setSaving(undefined); }
      })();
    }
  }, [project, canEdit, key, saved, view.destination, client, hosting, hostingBusy]);
  return useMemo(() => ({ view, activate }), [view, activate]);
}

export function deploymentCopy(view: DeploymentSettingsView) {
  return {
    choices: deploymentDestinationSchema.options.map(destination => ({ destination,
      id: `deployment.choose.${destination}`, label: `deployment.${destination}`, description: `deployment.${destination}Description` })),
    notice: view.destination === 'none' ? 'deployment.optional' : view.destination === 'atoma' && view.hosting ? 'hosting.private' : 'deployment.unavailable',
    status: view.busy ? 'deployment.saving' : view.status !== 'idle' ? `deployment.${view.status}` : null,
    saveDisabled: !view.canEdit || view.busy || view.destination === view.saved,
  };
}

export function hostingCopy(view: DeploymentSettingsView) {
  if (view.saved !== 'atoma' && !view.hosting?.deploymentId) return null;
  const hosting = view.hosting;
  return { status: view.hostingError ? 'hosting.error' : view.hostingBusy ? 'hosting.busy' : hosting ? `hosting.${hosting.state}` : 'hosting.unconfigured',
    version: hosting?.commitSha?.slice(0, 8), candidateVersion: hosting?.candidate?.commitSha.slice(0, 8), url: hosting?.url,
    buttons: [
      { id: 'hosting.deploy', disabled: !view.canEdit || !hosting?.candidate || view.hostingBusy || hosting.state === 'starting' || !!hosting.url },
      { id: 'hosting.open', disabled: !hosting?.url || view.hostingBusy },
      { id: 'hosting.stop', disabled: !view.canEdit || !hosting?.deploymentId || view.hostingBusy || hosting.state === 'starting' || hosting.state === 'stopped' },
    ] };
}
