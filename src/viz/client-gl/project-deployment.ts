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

/**
 * The destination card. Only the chosen option's description is shown, the
 * save control exists only while a draft differs from the saved choice, and
 * the notice never repeats what the hosted-application card already says.
 */
export function deploymentCopy(view: DeploymentSettingsView) {
  const dirty = view.destination !== view.saved;
  return {
    choices: deploymentDestinationSchema.options.map(destination => ({ destination,
      id: `deployment.choose.${destination}`, label: `deployment.${destination}`, description: `deployment.${destination}Description` })),
    description: `deployment.${view.destination}Description`,
    notice: view.destination === 'none' ? 'deployment.optional'
      : view.destination === 'external' || !view.hosting ? 'deployment.unavailable' : null,
    status: view.busy ? 'deployment.saving' : view.status !== 'idle' ? `deployment.${view.status}` : null,
    showSave: view.canEdit && (dirty || view.busy),
    saveDisabled: !view.canEdit || view.busy || !dirty,
  };
}

export type HostingTone = 'success' | 'warning' | 'error' | 'muted';

/**
 * The hosted-application card, top of the settings: what is online, where,
 * and only the actions that apply now. An update block appears only when an
 * accepted version differs from the online one, or nothing is online yet.
 */
export function hostingCopy(view: DeploymentSettingsView) {
  if (view.saved !== 'atoma' && !view.hosting?.deploymentId) return null;
  const hosting = view.hosting;
  const state = hosting?.state;
  const tone: HostingTone = view.hostingError || state === 'failed' ? 'error'
    : state === 'ready' ? 'success' : state === 'starting' || view.hostingBusy ? 'warning' : 'muted';
  const version = hosting?.commitSha?.slice(0, 8) ?? null;
  const candidateVersion = hosting?.candidate?.commitSha.slice(0, 8) ?? null;
  const online = state === 'ready' && !!hosting?.url;
  const busy = !!view.hostingBusy || state === 'starting';
  // The project's address; a deployment from before addresses existed is still served at its `p-<uuid>` host.
  const shownAddress = hosting?.address ?? hosting?.url ?? null;
  const update = !hosting?.candidate ? (online ? null : 'hosting.update.none')
    : online && candidateVersion === version ? null
    : online ? 'hosting.update.stopFirst' : 'hosting.update.ready';
  const actions = [
    ...(online ? [{ id: 'hosting.open', disabled: !!view.hostingBusy }] : []),
    ...(hosting?.address && view.canEdit ? [{ id: 'hosting.rename', disabled: !!view.hostingBusy || !!view.renameBusy }] : []),
  ];
  return {
    status: view.hostingError ? 'hosting.error' : view.hostingBusy ? 'hosting.busy' : hosting ? `hosting.${hosting.state}` : 'hosting.unconfigured',
    tone, version, candidateVersion, address: shownAddress,
    ...addressParts(hosting?.address ?? null),
    actions,
    update,
    deploy: update && hosting?.candidate && view.canEdit
      ? { id: 'hosting.deploy', disabled: busy || online } : null,
    stop: view.canEdit && hosting?.deploymentId && state !== 'stopped'
      ? { id: 'hosting.stop', disabled: busy } : null,
  };
}

/** `https://<label>.<domain>/` split for the rename field: the label is edited, the domain is fixed. */
function addressParts(address: string | null): { label: string | null; domain: string | null } {
  if (!address) return { label: null, domain: null };
  const host = new URL(address).hostname; const dot = host.indexOf('.');
  return dot > 0 ? { label: host.slice(0, dot), domain: host.slice(dot + 1) } : { label: null, domain: null };
}
