import { z } from 'zod';
import { hostingHistoryEntrySchema, hostingSummarySchema, type HostingSummary, type HostingVersion } from '../../contracts/projectHosting.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deploymentDestinationSchema, hostingSubdomainSchema, RESERVED_HOSTING_SUBDOMAINS, type DeploymentDestination } from '../../contracts/projectDeployment.js';
import type { VizProject } from '../client/types.js';
import { dateTimeFormat } from '../client/date-format.js';
import { useGpuStore, type HostingConfirm } from './store.js';

/** A hosting operation the person started from this client. */
/**
 * The hosting status as this tab reads it: tolerant at the top and in each
 * deployment of its history, so a server newer than the open tab may add a
 * field, an outcome or more entries without the tab losing its whole hosting
 * view until it reloads (2026-10-26). An entry this tab cannot word is skipped.
 */
const tolerantHistoryEntrySchema = z.object(hostingHistoryEntrySchema.shape);
const tolerantHostingSummarySchema = z.object({
  ...hostingSummarySchema.shape,
  history: z.array(z.unknown()).optional().transform(entries => entries?.flatMap(entry => {
    const parsed = tolerantHistoryEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  })),
});
export function parseHostingSummary(raw: unknown): HostingSummary {
  return tolerantHostingSummarySchema.parse(raw);
}

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
  /**
   * An update or put-back waiting for its explicit Confirm (store signal, shared
   * by every surface), with the version and deployment it was asked against.
   */
  confirming?: Pick<HostingConfirm, 'action' | 'runId' | 'deploymentId'> | null;
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
      const response = await fetch(`/api/projects/${encodeURIComponent(project!.projectId)}/hosting?history=1`);
      if (response.status === 503) return null;
      if (!response.ok) throw new Error('Hosting unavailable');
      return parseHostingSummary(await response.json());
    } });
  // A change of project or a refreshed server preference discards the old draft.
  const key = `${project?.projectId}:${saved}`;
  const view = useMemo<DeploymentSettingsView>(() => ({ destination: edit?.key === key ? edit.destination : saved,
    ...(project ? { projectId: project.projectId } : {}),
    hosting: hosting.data, hostingBusy: hostingBusy !== null, hostingBusyAction: hostingBusy,
    hostingError: hostingError || hosting.isError, saved, canEdit, busy: saving === project?.projectId && saving !== undefined,
    hostingAction: lastAction?.projectId === project?.projectId ? lastAction?.action ?? null : null,
    confirming: confirm && confirm.projectId === project?.projectId && canEdit
      ? { action: confirm.action, runId: confirm.runId, deploymentId: confirm.deploymentId } : null,
    status: edit?.key === key ? edit.status : 'idle',
    renaming: rename?.projectId === project?.projectId && rename !== undefined, renameBusy: rename?.busy ?? false, renameError: rename?.error ?? null }),
  [edit, key, saved, canEdit, saving, project, hosting.data, hostingBusy, hostingError, hosting.isError, rename, lastAction, confirm]);
  // A refreshed status that no longer offers the confirmed version, or names
  // another deployment, drops the confirmation on every surface at once.
  useEffect(() => {
    if (confirm && project && confirm.projectId === project.projectId && hosting.data && !confirmationHolds(hosting.data, confirm)) setConfirm(null);
  }, [confirm, project, hosting.data, setConfirm]);
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
      const target = action === 'update' ? hosting.data?.candidate : hosting.data?.previous;
      if (canEdit && hosting.data && hostingBusy === null && target) {
        setHostingError(false);
        setConfirm({ projectId: project.projectId, action, runId: target.runId, deploymentId: hosting.data.deploymentId });
      }
      return;
    }
    if (id.startsWith('hosting.')) {
      const confirmed = id === 'hosting.confirm' && confirm?.projectId === project.projectId ? confirm.action : null;
      const action: HostingAction | null = confirmed ?? (['deploy', 'stop', 'open'].includes(id.slice('hosting.'.length))
        ? id.slice('hosting.'.length) as HostingAction : null);
      if (!action || !hosting.data || hostingBusy !== null || (action !== 'open' && !canEdit)) return;
      const summary = hosting.data;
      // A confirmation posts exactly what it named: if the status moved since
      // (another accepted version, another deployment), it is dropped instead.
      if (confirmed && confirm && !confirmationHolds(summary, confirm)) { setConfirm(null); return; }
      const target = action === 'restore' ? summary.previous : action === 'deploy' || action === 'update' ? summary.candidate : null;
      if ((action === 'deploy' || action === 'update' || action === 'restore') && !target) return;
      const expectedDeploymentId = confirmed && confirm ? confirm.deploymentId : summary.deploymentId;
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
            body: JSON.stringify(target ? { runId: target.runId, manifestHash: target.manifestHash, expectedDeploymentId }
              : { expectedDeploymentId }),
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
  const version = hosting?.commitSha?.slice(0, 8) ?? null;
  const candidateVersion = hosting?.candidate?.commitSha.slice(0, 8) ?? null;
  // Online is what serves, not the newest deployment's state: the server
  // names a ready deployment's address (and describes that version) even
  // while a newer one beside it starts or has failed.
  const online = !!hosting?.url;
  const busy = !!view.hostingBusy || state === 'starting';
  // The project's address; a deployment from before addresses existed is still served at its `p-<uuid>` host.
  const shownAddress = hosting?.address ?? hosting?.url ?? null;
  const candidate = hosting?.candidate ?? null;
  const newer = !!candidate && candidate.commitSha !== hosting?.commitSha;
  // The newest deployment failed and it was the accepted candidate, as the
  // status names it: beside a static version still online, a failed attempt
  // may be an older version than the candidate accepted since.
  const candidateFailed = !!candidate && hosting?.failed?.runId === candidate.runId;
  const tone: HostingTone = view.hostingError || (state === 'failed' && !online) ? 'error'
    : candidateFailed || state === 'starting' || (view.hostingBusy && !online) ? 'warning' : online ? 'success' : 'muted';
  // A confirmation holds only while the status still offers what it named.
  const confirming = view.confirming && view.canEdit && hosting && confirmationHolds(hosting, view.confirming)
    ? view.confirming.action : null;
  const previous = !online && state === 'failed' ? hosting?.previous ?? null : null;
  // Off line with a version to put online: a runtime that may still hold the
  // data (its state unknown) is stopped first, so it takes the update path.
  const startNew = !online && !!candidate && state !== 'starting' ? (hosting?.updateStops ? 'update' : 'deploy') : null;
  const next = online ? (newer ? 'update' : null) : previous ? 'restore' : startNew;
  const update = candidateFailed && online ? 'hosting.outcome.failedOnline'
    : next === 'update' && online ? 'hosting.update.available'
    : next === 'restore' || candidateFailed ? 'hosting.outcome.failed'
    : next ? 'hosting.update.startable'
    : !candidate && !online ? 'hosting.update.none' : null;
  const primary: HostingControl | null = !next || !view.canEdit || confirming ? null
    : { id: `hosting.${next}`, ...(candidateFailed && next !== 'restore' ? { label: 'hosting.retry' } : {}), disabled: busy };
  // A failed update keeps its own retry beside the put-back.
  const retry: HostingControl | null = next === 'restore' && startNew && view.canEdit && !confirming
    ? { id: `hosting.${startNew}`, label: 'hosting.retry', disabled: busy } : null;
  const confirm = confirming && hosting ? {
    message: confirming === 'restore' ? 'hosting.confirm.restore' : !online ? 'hosting.confirm.start'
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
    status: view.hostingError ? 'hosting.error' : view.hostingBusy ? (progress ?? 'hosting.busy')
      : hosting ? `hosting.${online && state === 'failed' ? 'ready' : hosting.state}` : 'hosting.unconfigured',
    tone, version, candidateVersion, address: shownAddress, candidateFailed,
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
    stop: view.canEdit && hosting?.deploymentId && state !== 'stopped' && !confirming
      ? { id: 'hosting.stop', disabled: busy } : null,
  };
}

/** Whether a pending confirmation still names what the status offers: the same version, against the same deployment. */
export function confirmationHolds(summary: HostingSummary, confirm: Pick<HostingConfirm, 'action' | 'runId' | 'deploymentId'>): boolean {
  const target = confirm.action === 'restore' ? summary.previous : summary.candidate;
  return !!target && target.runId === confirm.runId && summary.deploymentId === confirm.deploymentId;
}
export type HostingCopy = NonNullable<ReturnType<typeof hostingCopy>>;

/**
 * Where a person reads a run (the conversation's run card, the run's result
 * page): the same next step as Settings, offered only for this run's accepted
 * version, when the project is hosted on Atoma and the application is online
 * with an older version or was never put online — and, once started here,
 * its progress and outcome. A failed attempt to put this run's version online
 * stays explained after a reload, not only in the tab that asked for it.
 */
export function hostedUpdateOffer(view: DeploymentSettingsView | null | undefined,
  run: { projectId: string; projectRunId: string } | null | undefined) {
  if (!view || !run || view.projectId !== run.projectId || view.saved !== 'atoma') return null;
  const hosting = view.hosting;
  if (!hosting?.candidate || hosting.candidate.runId !== run.projectRunId) return null;
  const copy = hostingCopy(view);
  if (!copy) return null;
  const online = !!hosting.url;
  const lead = copy.candidateFailed ? copy.update
    : online && hosting.candidate.commitSha !== hosting.commitSha ? 'hosting.offer.outdated'
    : hosting.state === 'not-deployed' ? 'hosting.offer.notOnline' : null;
  const followed = !!view.hostingAction && (!!copy.progress || copy.update === 'hosting.outcome.failed');
  if (!lead && !followed && !copy.confirm) return null;
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
