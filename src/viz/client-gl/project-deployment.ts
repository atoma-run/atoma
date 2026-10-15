import { hostingSummarySchema, type HostingSummary } from '../../contracts/projectHosting.js';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deploymentDestinationSchema, hostingSubdomainSchema, RESERVED_HOSTING_SUBDOMAINS, type DeploymentDestination } from '../../contracts/projectDeployment.js';
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
  /** The administrator is choosing a new hosting address. */
  renaming?: boolean;
  renameBusy?: boolean;
  renameError?: 'invalid' | 'conflict' | 'failed' | null;
}

export function useProjectDeployment(project: VizProject | null | undefined, canEdit: boolean) {
  const client = useQueryClient();
  const [edit, setEdit] = useState<{ key: string; destination: DeploymentDestination; status: DeploymentSettingsView['status'] }>();
  const [saving, setSaving] = useState<string>();
  const inFlight = useRef(false);
  const saved = project?.deploymentDestination ?? 'none';
  const [hostingBusy, setHostingBusy] = useState(false);
  const [hostingError, setHostingError] = useState(false);
  const [rename, setRename] = useState<{ projectId: string; busy: boolean; error: DeploymentSettingsView['renameError'] }>();
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
    status: edit?.key === key ? edit.status : 'idle',
    renaming: rename?.projectId === project?.projectId && rename !== undefined, renameBusy: rename?.busy ?? false, renameError: rename?.error ?? null }),
  [edit, key, saved, canEdit, saving, project?.projectId, hosting.data, hostingBusy, hostingError, hosting.isError, rename]);
  const activate = useCallback((id: string) => {
    if (!project || inFlight.current) return;
    if (id === 'hosting.rename') {
      if (canEdit && hosting.data?.address) setRename({ projectId: project.projectId, busy: false, error: null });
      return;
    }
    if (id === 'hosting.renameCancel') { setRename(undefined); return; }
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
  /** Save a new address; the previous one keeps redirecting to it. */
  const renameAddress = useCallback((value: string) => {
    if (!project || !canEdit || rename?.busy) return;
    const subdomain = value.trim().toLowerCase();
    const parsed = hostingSubdomainSchema.safeParse(subdomain);
    if (!parsed.success || RESERVED_HOSTING_SUBDOMAINS.has(subdomain)) {
      setRename({ projectId: project.projectId, busy: false, error: 'invalid' }); return;
    }
    const projectId = project.projectId;
    setRename({ projectId, busy: true, error: null });
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/hosting-address`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          // The address the administrator is looking at, so a rename elsewhere meanwhile is a conflict, not an overwrite.
          body: JSON.stringify({ subdomain, expectedSubdomain: addressParts(hosting.data?.address ?? null).label ?? project.hostingSubdomain ?? null }),
        });
        if (!response.ok) {
          setRename({ projectId, busy: false, error: response.status === 400 ? 'invalid' : response.status === 409 ? 'conflict' : 'failed' });
          return;
        }
        client.setQueryData<VizProject[]>(['viz', 'projects'], rows => rows?.map(row =>
          row.projectId === projectId ? { ...row, hostingSubdomain: subdomain } : row));
        setRename(undefined);
        await Promise.all([client.invalidateQueries({ queryKey: ['viz', 'projects'] }), hosting.refetch()]);
      } catch { setRename({ projectId, busy: false, error: 'failed' }); }
    })();
  }, [project, canEdit, rename?.busy, client, hosting]);
  return useMemo(() => ({ view, activate, renameAddress }), [view, activate, renameAddress]);
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
    version: hosting?.commitSha?.slice(0, 8), candidateVersion: hosting?.candidate?.commitSha.slice(0, 8),
    // The stored address; a deployment still served at its pre-address `p-<uuid>` host shows that host too.
    address: hosting?.address ?? null, url: hosting?.url && hosting.url !== hosting.address ? hosting.url : null,
    ...addressParts(hosting?.address ?? null),
    buttons: [
      { id: 'hosting.deploy', disabled: !view.canEdit || !hosting?.candidate || view.hostingBusy || hosting.state === 'starting' || !!hosting.url },
      { id: 'hosting.open', disabled: !hosting?.url || view.hostingBusy },
      { id: 'hosting.stop', disabled: !view.canEdit || !hosting?.deploymentId || view.hostingBusy || hosting.state === 'starting' || hosting.state === 'stopped' },
      ...(hosting?.address && view.canEdit ? [{ id: 'hosting.rename', disabled: view.hostingBusy || !!view.renameBusy }] : []),
    ] };
}

/** `https://<label>.<domain>/` split for the rename field: the label is edited, the domain is fixed. */
function addressParts(address: string | null): { label: string | null; domain: string | null } {
  if (!address) return { label: null, domain: null };
  const host = new URL(address).hostname; const dot = host.indexOf('.');
  return dot > 0 ? { label: host.slice(0, dot), domain: host.slice(dot + 1) } : { label: null, domain: null };
}
