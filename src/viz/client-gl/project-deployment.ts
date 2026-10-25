import { hostingSummarySchema, type HostingSummary, type HostingVersion } from '../../contracts/projectHosting.js';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deploymentDestinationSchema, hostingSubdomainSchema, RESERVED_HOSTING_SUBDOMAINS, type DeploymentDestination } from '../../contracts/projectDeployment.js';
import type { VizProject } from '../client/types.js';
import { dateTimeFormat } from '../client/date-format.js';
import { useGpuStore } from './store.js';

/** A hosting operation the person started from this client. */
export type HostingAction = 'deploy' | 'update' | 'restore' | 'stop' | 'open';

export interface DeploymentSettingsView {
  /** The project this view describes; a run elsewhere is never offered its update. */
  projectId?: string;
  hosting?: HostingSummary | null;
  hostingBusy?: boolean;
  /** Which request is in flight while `hostingBusy`. */
  hostingBusyAction?: HostingAction | null;
  hostingError?: boolean;
  /** The last update, put-back or first deployment requested here, to word its outcome. */
  hostingAction?: 'deploy' | 'update' | 'restore' | null;
  /** An update or put-back waiting for its explicit Confirm (store signal, shared by every surface). */
  confirming?: 'update' | 'restore' | null;
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
  const [hostingBusy, setHostingBusy] = useState<HostingAction | null>(null);
  const [hostingError, setHostingError] = useState(false);
  const [lastAction, setLastAction] = useState<{ projectId: string; action: NonNullable<DeploymentSettingsView['hostingAction']> }>();
  const [rename, setRename] = useState<{ projectId: string; busy: boolean; error: DeploymentSettingsView['renameError'] }>();
  const confirm = useGpuStore(state => state.hostingConfirm);
  const setConfirm = useGpuStore(state => state.setHostingConfirm);
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
    ...(project ? { projectId: project.projectId } : {}),
    hosting: hosting.data, hostingBusy: hostingBusy !== null, hostingBusyAction: hostingBusy,
    hostingError: hostingError || hosting.isError, saved, canEdit, busy: saving === project?.projectId && saving !== undefined,
    hostingAction: lastAction?.projectId === project?.projectId ? lastAction?.action ?? null : null,
    confirming: confirm && confirm.projectId === project?.projectId && canEdit ? confirm.action : null,
    status: edit?.key === key ? edit.status : 'idle',
    renaming: rename?.projectId === project?.projectId && rename !== undefined, renameBusy: rename?.busy ?? false, renameError: rename?.error ?? null }),
  [edit, key, saved, canEdit, saving, project, hosting.data, hostingBusy, hostingError, hosting.isError, rename, lastAction, confirm]);
  const activate = useCallback((id: string) => {
    if (!project || inFlight.current) return;
    if (id === 'hosting.rename') {
      if (canEdit && hosting.data?.address) setRename({ projectId: project.projectId, busy: false, error: null });
      return;
    }
    if (id === 'hosting.renameCancel') { setRename(undefined); return; }
    if (id === 'hosting.cancel') { setConfirm(null); return; }
    // Updating or putting back stops the site: it waits for an explicit Confirm.
    if (id === 'hosting.update' || id === 'hosting.restore') {
      const action = id === 'hosting.update' ? 'update' : 'restore';
      if (canEdit && hosting.data && hostingBusy === null && (action === 'update' ? hosting.data.candidate : hosting.data.previous)) {
        setHostingError(false); setConfirm({ projectId: project.projectId, action });
      }
      return;
    }
    if (id.startsWith('hosting.')) {
      const confirmed = id === 'hosting.confirm' && confirm?.projectId === project.projectId ? confirm.action : null;
      const action: HostingAction | null = confirmed ?? (['deploy', 'stop', 'open'].includes(id.slice('hosting.'.length))
        ? id.slice('hosting.'.length) as HostingAction : null);
      if (!action || !hosting.data || hostingBusy !== null || (action !== 'open' && !canEdit)) return;
      const summary = hosting.data;
      const target = action === 'restore' ? summary.previous : action === 'deploy' || action === 'update' ? summary.candidate : null;
      if ((action === 'deploy' || action === 'update' || action === 'restore') && !target) return;
      if (confirmed) setConfirm(null);
      const popup = action === 'open' ? window.open('about:blank', '_blank') : null;
      if (action === 'open' && !popup) { setHostingError(true); return; }
      if (popup) popup.opener = null;
      setHostingBusy(action); setHostingError(false); inFlight.current = true;
      if (action === 'deploy' || action === 'update' || action === 'restore') setLastAction(undefined);
      void (async () => {
        try {
          const response = await fetch(`/api/projects/${encodeURIComponent(project.projectId)}/hosting/${action}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(target ? { runId: target.runId, manifestHash: target.manifestHash,
              expectedDeploymentId: summary.deploymentId } : { expectedDeploymentId: summary.deploymentId }),
          });
          if (!response.ok) throw new Error('Hosting request failed');
          if (action === 'open') {
            const result = await response.json() as { url: string };
            if (new URL(result.url).origin !== new URL(summary.url!).origin) throw new Error('Unexpected application address');
            if (popup) popup.location.replace(result.url);
          }
          if (action === 'deploy' || action === 'update' || action === 'restore') setLastAction({ projectId: project.projectId, action });
          await hosting.refetch();
        } catch { popup?.close(); setHostingError(true); }
        finally { inFlight.current = false; setHostingBusy(null); }
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
  }, [project, canEdit, key, saved, view.destination, client, hosting, hostingBusy, confirm, setConfirm]);
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
export interface HostingControl { id: string; label?: string; disabled?: boolean }
/** A version line: a catalogue key whose `{{version}}` is `words`, the short hash as secondary detail. */
export interface HostingVersionLine { key: string; words: Pick<HostingVersion, 'title' | 'acceptedAt'>; hash: string }

/**
 * The hosted-application card, top of the settings: what is online, where,
 * and the one next step that applies now. Versions are described in words;
 * a hash is only ever secondary detail. Updating or putting back a version
 * stops the site, so it shows a plain confirmation before anything happens.
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
  const candidate = hosting?.candidate ?? null;
  const newer = !!candidate && candidate.commitSha !== hosting?.commitSha;
  const previous = !online && state === 'failed' ? hosting?.previous ?? null : null;
  // Off line with a version to put online: a runtime that may still hold the
  // data (its state unknown) is stopped first, so it takes the update path.
  const startNew = !online && !!candidate && state !== 'starting' ? (hosting?.updateStops ? 'update' : 'deploy') : null;
  const next = online ? (newer ? 'update' : null) : previous ? 'restore' : startNew;
  const update = next === 'update' && online ? 'hosting.update.available'
    : next === 'restore' ? 'hosting.outcome.failed'
    : next ? 'hosting.update.startable'
    : !candidate && !online ? 'hosting.update.none' : null;
  const primary: HostingControl | null = !next || !view.canEdit || view.confirming ? null
    : { id: `hosting.${next}`, disabled: busy };
  // A failed update keeps its own retry beside the put-back.
  const retry: HostingControl | null = next === 'restore' && startNew && view.canEdit && !view.confirming
    ? { id: `hosting.${startNew}`, label: 'hosting.retry', disabled: busy } : null;
  const confirm = view.confirming && view.canEdit && hosting ? {
    message: view.confirming === 'restore' ? 'hosting.confirm.restore' : !online ? 'hosting.confirm.start'
      : hosting.updateStops ? 'hosting.confirm.update' : 'hosting.confirm.updateLive',
    actions: [{ id: 'hosting.confirm', disabled: busy }, { id: 'hosting.cancel' }] as HostingControl[],
  } : null;
  const line = (key: string, value: HostingVersion | null | undefined): HostingVersionLine | null =>
    value ? { key, words: { title: value.title, acceptedAt: value.acceptedAt }, hash: value.commitSha.slice(0, 8) } : null;
  const progress = view.hostingBusyAction === 'update' || view.hostingBusyAction === 'restore'
    ? (hosting?.updateStops ? 'hosting.progress.stopping' : 'hosting.progress.starting')
    : state === 'starting' && view.hostingAction ? 'hosting.progress.starting'
    : view.hostingAction === 'update' && online && !newer ? 'hosting.outcome.updated'
    : view.hostingAction === 'restore' && online ? 'hosting.outcome.restored' : null;
  const actions = [
    ...(online ? [{ id: 'hosting.open', disabled: !!view.hostingBusy }] : []),
    ...(hosting?.address && view.canEdit ? [{ id: 'hosting.rename', disabled: !!view.hostingBusy || !!view.renameBusy }] : []),
  ];
  return {
    status: view.hostingError ? 'hosting.error' : view.hostingBusy ? (progress ?? 'hosting.busy') : hosting ? `hosting.${hosting.state}` : 'hosting.unconfigured',
    tone, version, candidateVersion, address: shownAddress,
    ...addressParts(hosting?.address ?? null),
    actions,
    /** What runs now, or what was stopped, in words; a version starting or failed is not "online". */
    current: online ? line('hosting.version.online', hosting?.version)
      : state === 'stopped' ? line('hosting.version.last', hosting?.version) : null,
    update,
    /** The version the next step puts online, in words. */
    target: next === 'restore' ? line('hosting.version.previous', previous)
      : next ? line(online ? 'hosting.version.candidate' : 'hosting.version.ready', candidate) : null,
    primary, retry, confirm, progress,
    askAdmin: next && !view.canEdit ? (next === 'deploy' ? 'hosting.offer.askAdminDeploy' : 'hosting.offer.askAdmin') : null,
    stop: view.canEdit && hosting?.deploymentId && state !== 'stopped' && !view.confirming
      ? { id: 'hosting.stop', disabled: busy } : null,
  };
}
export type HostingCopy = NonNullable<ReturnType<typeof hostingCopy>>;

/**
 * Where a person reads a run (the conversation's run card, the run's result
 * page): the same next step as Settings, offered only for this run's accepted
 * version, when the project is hosted on Atoma and the application is online
 * with an older version or was never put online — and, once started here,
 * its progress and outcome.
 */
export function hostedUpdateOffer(view: DeploymentSettingsView | null | undefined,
  run: { projectId: string; projectRunId: string } | null | undefined) {
  if (!view || !run || view.projectId !== run.projectId || view.saved !== 'atoma') return null;
  const hosting = view.hosting;
  if (!hosting?.candidate || hosting.candidate.runId !== run.projectRunId) return null;
  const copy = hostingCopy(view);
  if (!copy) return null;
  const online = hosting.state === 'ready' && !!hosting.url;
  const lead = online && hosting.candidate.commitSha !== hosting.commitSha ? 'hosting.offer.outdated'
    : hosting.state === 'not-deployed' ? 'hosting.offer.notOnline' : null;
  const followed = !!view.hostingAction && (!!copy.progress || copy.update === 'hosting.outcome.failed');
  if (!lead && !followed && !view.confirming) return null;
  return {
    lead: lead ?? (copy.update === 'hosting.outcome.failed' ? copy.update : null),
    progress: copy.progress,
    error: view.hostingError ? 'hosting.error' : null,
    askAdmin: copy.askAdmin,
    confirm: copy.confirm,
    actions: [copy.primary, copy.retry].filter((control): control is HostingControl => !!control),
  };
}
export type HostedUpdateOffer = NonNullable<ReturnType<typeof hostedUpdateOffer>>;

/**
 * A version in words for both renderers: its title and when the client
 * accepted it ("today", "yesterday", or the date in the reader's locale).
 */
export function versionWords(words: HostingVersionLine['words'], t: (key: string, vars?: Record<string, unknown>) => string,
  locale: string, now = new Date()): string {
  const at = words.acceptedAt ? new Date(words.acceptedAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? acceptedWhen(at, t, locale, now) : null;
  if (words.title && when) return t('hosting.version.named', { title: words.title, when });
  if (words.title) return t('hosting.version.titleOnly', { title: words.title });
  if (when) return t('hosting.version.dateOnly', { when });
  return t('hosting.version.unnamed');
}
function acceptedWhen(at: Date, t: (key: string, vars?: Record<string, unknown>) => string, locale: string, now: Date): string {
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return t('hosting.when.today');
  if (days === 1) return t('hosting.when.yesterday');
  return t('hosting.when.date', { date: dateTimeFormat(locale, { dateStyle: 'long' }).format(at) });
}
/** A version line as one string: `Online: <title>, accepted today`. */
export function versionLineText(line: HostingVersionLine, t: (key: string, vars?: Record<string, unknown>) => string, locale: string, now = new Date()): string {
  return t(line.key, { version: versionWords(line.words, t, locale, now) });
}

/** `https://<label>.<domain>/` split for the rename field: the label is edited, the domain is fixed. */
function addressParts(address: string | null): { label: string | null; domain: string | null } {
  if (!address) return { label: null, domain: null };
  const host = new URL(address).hostname; const dot = host.indexOf('.');
  return dot > 0 ? { label: host.slice(0, dot), domain: host.slice(dot + 1) } : { label: null, domain: null };
}
