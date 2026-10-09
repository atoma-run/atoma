import { FilePreview } from './FilePreview.js';
import { CHEVRON_CSS_VARS } from './button-icons.js';
import { TIMELINE_JUMP_PREFIX } from './renderer/timeline-minimap.js';
import { AssistantPanel } from './AssistantPanel.js';
import { workspaceIndexSchema } from '../../contracts/workspaceBrowser.js';
import { latestWorkspaceRun } from './workspace-browser.js';
import { canControlCheckpoint, pendingGitHubAccess, canContinueGitHubAccess, canRetryPublication } from './github-access.js';
import { fetchJson } from '../client/data-api.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { isLocale } from '../../contracts/locales.js';
import { applyDocumentLocale, translate } from '../client/i18n-catalog.js';
import { loginBounceParams, providerLoginHref } from '../client/session-guard.js';
import { isIndexEntryLive } from '../client/run-utils.js';
import { PARTIAL_CONTINUE_PREFIX, partialRunGuidance } from './partial-run.js';
import {
  dismissPushPrompt,
  enableWebPush,
  pushPromptStorage,
  shouldEnsureAdminSubscription,
  shouldOfferPushPrompt,
} from '../client/push.js';
import {
  emptyRenderMetrics,
  type GpuRenderMetrics,
} from './renderer/metrics.js';
import { AtomaCursor } from './AtomaCursor.js';
import { AuthControls } from './AuthControls.js';
import { useAuthController } from './session-controller.js';
import { GpuDomBridge, SettingsProfileForm } from './DomBridge.js';
import { McpAccess } from './McpAccessPanel.js';
import { OrgModelsForm, type SettingsTab } from './OrgModelsForm.js';
import { EntryVeilLayer } from './EntryVeilLayer.js';
import { HandheldVeilLayer } from './HandheldVeilLayer.js';
import { AppearanceVeilLayer, useAppearanceTransition } from './appearance-transition.js';
import { PreviewPlane } from './PreviewPlane.js';
import { usePreviewSession } from './usePreviewSession.js';
import { useEntryFade } from './entry-fade.js';
import { handheldMediaQuery, isHandheldDevice } from './handheld.js';
import { useHandheldWhiteout } from './handheld-whiteout.js';
import { GpuSurface } from './GpuSurface.js';
import { SceneCameraPlane } from './SceneCameraPlane.js';
import { CubeTurnPlane } from './CubeTurnPlane.js';
import { SceneTuningPanel } from './SceneTuningPanel.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pendingApiMutations } from '../client/data-api.js';
import { startAutoUpdate, restoreUpdateNavigation, saveUpdateNavigation } from './auto-update.js';
import { startNavigationHistory } from './navigation-history.js';
import { listenForNotificationLinks, takeLaunchNotificationLink } from './notification-link.js';
import { notificationTarget } from './notification-target.js';
import type { NotificationLink } from '../../contracts/notificationLink.js';
import {
  useAccountModels,
  useAdminEventsPages,
  useNotificationsPages,
  useAdminLedger,
  useAdminSentinel,
  useAdminOrganisations,
  useBurnin,
  useOrganisation,
  useGithubInstallations,
  useMcpAccess,
  projectMcpAccessState,
  usePreviewStatus,
  useProjectRuns,
  useProjects,
  useRegistries,
  useRegistry,
  useRunTrace,
  useRunsIndex,
  useSkillDetail,
  useSkillLists,
  useSkillNamespaces,
} from './queries.js';
import {
  isRoutableView,
  nextRunFilters,
  previewTargetForRun,
  projectSelectionAfterActivate,
  projectSelectionAfterProjects,
  useGpuStore,
  visibleViews,
  navRowGroup,
  type DocsThemeKey,
} from './store.js';
import type { VizAdminInvitation } from '../client/types.js';
import { openGitHubRepository } from './repository-link.js';
import { latestDeliveredResult, resultText } from './run-result.js';
import { isAppearanceTheme } from './theme.js';

const RELEASE_VERSION = __ATOMA_RELEASE_VERSION__;

declare global {
  interface Window {
    __ATOMA_VIZ_TEST__?: {
      view: string;
      cameraMode: string;
      renderer: GpuRenderMetrics;
      selectedRunId: string | null;
      dispatch: (id: string) => void;
    };
  }
}

function errorMessage(errors: unknown[], t: (key: string) => string) {
  const found = errors.find(Boolean);
  if (found instanceof Error) return found.message;
  if (typeof found === 'string') return found;
  if (typeof found === 'number' || typeof found === 'boolean') return String(found);
  return found ? t('app.queryError') : null;
}

export function GpuApp() {
  const locale = useGpuStore((snapshot) => snapshot.locale);
  const entered = useGpuStore((snapshot) => snapshot.entered);
  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);
  const t = useCallback(
    (key: string, vars?: Record<string, unknown>) => translate(locale, key, vars),
    [locale]
  );
  return (
    <AuthControls active={entered} t={t}>
      <GpuAppContent t={t} />
    </AuthControls>
  );
}

function GpuAppContent({
  t,
}: {
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  const state = useGpuStore();
  const queryClient = useQueryClient();
  const {
    snapshot: authSnapshot,
    gate: authGate,
    providers: authProviders,
    activate: activateAuth,
  } = useAuthController();
  // The arrival gate doubles as the login when the server says the gate is
  // on and this browser holds no session. Every data query stays dark until
  // the gate is KNOWN ('off' or 'authenticated'): firing /api/* while whoami
  // is still in flight earned a 401 whose handler reloads '/', which re-ran
  // the race — an infinite reload loop the first gated screenshot caught.
  const gateBlocked = authGate === 'unauthenticated';
  const apiReady = authGate === 'off' || authGate === 'authenticated';
  // Bounce parameters from the server's auth flow, read once per page load:
  // ?authNotice=<code> names a login failure to display, ?invite=<token>
  // must ride every provider link so the invitation admits the account the
  // visitor signs in with. Parsing and href building are the unit-tested
  // helpers in session-guard.ts.
  const loginParams = useMemo(() => loginBounceParams(window.location.search), []);
  const loginHref = useCallback(
    (providerId: string) => providerLoginHref(providerId, loginParams.invite),
    [loginParams.invite]
  );
  const [pendingLoginProvider, setPendingLoginProvider] = useState<string | null>(null);
  const githubRecovery = useGpuStore(state => state.githubRecovery);
  const setGitHubRecovery = useGpuStore(state => state.setGitHubRecovery);
  const githubRecoveryLock = useRef(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('general');
  const [cameraRevision, setCameraRevision] = useState(0);
  const cameraSettled = useCallback(
    () => setCameraRevision((revision) => revision + 1),
    []
  );
  /**
   * What the box is asked to turn for: the destination, the rail row it
   * occupies and the group that row belongs to. Rail rows set how long the
   * turn lasts, and the group boundary sets the axis it turns about. A
   * destination with no row of its own (Settings, from the account menu)
   * reports -1 and gets the shortest turn.
   */
  const sceneNavigation = useMemo(
    () => ({
      key: state.view,
      rank: visibleViews(authSnapshot).indexOf(state.view),
      group: navRowGroup(state.view),
    }),
    [authSnapshot, state.view]
  );
  const metrics = useRef<GpuRenderMetrics>(emptyRenderMetrics());
  const { phase: entryPhase, begin: beginEnter } = useEntryFade();
  const appearanceTransition = useAppearanceTransition();
  const {
    phase: handheldPhase,
    begin: beginHandheldWhiteout,
    dismiss: dismissHandheldWhiteout,
    floodRef: handheldFloodRef,
  } = useHandheldWhiteout();
  // Canvas and accessible entry share the mobile acknowledgement journey.
  const arrive = useCallback(() => {
    if (!beginHandheldWhiteout()) beginEnter();
  }, [beginEnter, beginHandheldWhiteout]);

  // Operator surfaces are admin-only behind the gate: the server 403s them
  // for ordinary members, and a 403'd query would poison the global data
  // error exactly the way the ungated /api/projects 404 once did. Ungated
  // (auth null) keeps the classic developer path.
  const operatorSurfaces =
    apiReady && (authSnapshot === null || authSnapshot.viewer.platformAdmin);
  const isPlatformAdmin = authSnapshot?.viewer.platformAdmin === true;
  const runsQuery = useRunsIndex(state.view === 'runs' && apiReady);
  const runQuery = useRunTrace(
    state.selectedRunId,
    state.view === 'runs' && apiReady,
    runsQuery.data?.find((entry) => entry.id === state.selectedRunId)
  );
  const resultQuery = useRunTrace(state.resultRunId,
    apiReady && (state.view === 'runs' || state.view === 'projects'));
  const registriesQuery = useRegistries(state.view === 'registry' && apiReady);
  const registryQuery = useRegistry(
    state.selectedRegistryId,
    state.view === 'registry' && apiReady
  );
  const namespacesQuery = useSkillNamespaces(state.view === 'skills' && apiReady);
  const namespaceNames = useMemo(
    () => (namespacesQuery.data ?? []).map((item) => item.l1Name),
    [namespacesQuery.data]
  );
  const skillLists = useSkillLists(namespaceNames, state.view === 'skills' && apiReady);
  const selectedRunEvent = useMemo(
    () => runQuery.data?.events.find((event) => event.id === state.selectedEventId) ?? null,
    [runQuery.data, state.selectedEventId]
  );
  const runSkillNs = selectedRunEvent?.l1AtomId ?? selectedRunEvent?.l1Name;
  const runSkillSelection =
    state.view === 'runs' &&
    selectedRunEvent?.kind === 'skill' &&
    runSkillNs &&
    selectedRunEvent.skillId
      ? { l1Name: runSkillNs, id: selectedRunEvent.skillId }
      : null;
  const skillSelection = state.view === 'skills' ? state.selectedSkill : runSkillSelection;
  const skillDetailQuery = useSkillDetail(skillSelection, Boolean(skillSelection) && apiReady);
  const burninQuery = useBurnin(state.view === 'burnin' && operatorSurfaces);
  // Project routes exist only behind the auth gate; an ungated server 404s
  // them. Left enabled, those 404s poisoned the GLOBAL `data.error` below and
  // the runs view then rendered an error banner instead of its list — the
  // wheel handler fails closed on scrollMax, so scrolling died with it.
  const authed = authSnapshot !== null;
  const mcpAccessQuery = useMcpAccess(state.view === 'projects' && authed, authSnapshot?.viewer.principalId ?? null);
  const activeOrgId = authSnapshot?.viewer.activeOrganisation?.id ?? null;
  const mcpAccessState = projectMcpAccessState(mcpAccessQuery.data, activeOrgId);
  // Enabled on Runs too, and not for the Runs list: it is the ONLY way to
  // resolve the project a selected run belongs to, and the preview is keyed by
  // (project, project run) while this view is keyed by trace id. Gated on the
  // Projects view alone, a member who RELOADED the page while watching their
  // run had no project list in cache and therefore no preview control — the
  // one moment the control matters most.
  const projectsQuery = useProjects(
    (state.view === 'projects' || state.view === 'runs') && authed
  );
  const githubInstallationsQuery = useGithubInstallations(state.view === 'projects' && authed);
  // Resolved on EVERY view, not only Projects. A member reaches a run's detail
  // by clicking it in its project, and the preview below is keyed by (project,
  // project run) while the Runs view is keyed by trace id — so the project run
  // list has to survive that navigation. Gating this on the view emptied the
  // query key the moment the viewer left, taking the only link between the two
  // identities with it.
  const selectedProject =
    projectsQuery.data?.find((project) => project.projectId === state.selectedProjectId) ?? null;
  const projectRunsQuery = useProjectRuns(
    selectedProject?.projectId ?? null,
    (state.view === 'projects' || state.view === 'runs') && !!selectedProject
  );
  useEffect(() => {
    if (state.view !== 'projects' || !selectedProject) return;
    const rows = projectRunsQuery.data ?? [];
    if (state.projectSection === 'files') {
      const latestId = latestWorkspaceRun(rows)?.projectRunId ?? null;
      if (state.workspaceRunId !== latestId) state.selectProjectSection('files', latestId);
    } else if (state.projectSection === 'result') {
      const latestId = latestDeliveredResult(rows)?.traceId ?? null;
      if (state.resultRunId !== latestId) state.selectProjectSection('result', latestId);
    }
  }, [projectRunsQuery.data, selectedProject, state.view, state.projectSection,
    state.workspaceRunId, state.resultRunId, state.selectProjectSection]);
  const workspaceUrl = `/api/projects/${encodeURIComponent(selectedProject?.projectId ?? '')}/runs/${encodeURIComponent(state.workspaceRunId ?? '')}/workspace`;
  const workspaceEnabled = authed && state.view === 'projects' && !!selectedProject && !!state.workspaceRunId;
  const workspaceIndex = useQuery({ queryKey: ['workspace', workspaceUrl],
    queryFn: async () => workspaceIndexSchema.parse(await fetchJson(workspaceUrl)), enabled: workspaceEnabled, retry: false });
  const workspace = useMemo(() => ({ index: workspaceIndex.data ?? null,
    file: null, loading: workspaceIndex.isLoading, failed: workspaceIndex.isError }),
  [workspaceIndex.data, workspaceIndex.isLoading, workspaceIndex.isError]);
  const projectRuns = useMemo<Record<string, import('../client/types.js').VizProjectRun[]>>(
    () =>
      selectedProject && projectRunsQuery.data
        ? { [selectedProject.projectId]: projectRunsQuery.data }
        : {},
    [projectRunsQuery.data, selectedProject]
  );
  const resultProjectId = state.view === 'projects' ? selectedProject?.projectId
    : runsQuery.data?.find(run => run.id === state.resultRunId)?.projectId ?? selectedProject?.projectId;
  const resultProjectRunsQuery = useProjectRuns(resultProjectId ?? null,
    authed && !!state.resultRunId && (state.view === 'runs' || state.view === 'projects'));

  // The project run behind the selected trace. A run reached from anywhere
  // else — the runs index, a burn-in row, a deep link — has no project run to
  // preview, and the control below stays absent rather than guessing one.
  const previewTarget = useMemo(
    () => {
      if (state.view === 'projects' && !state.resultRunId) {
        const latest = latestDeliveredResult(projectRunsQuery.data ?? []);
        return latest && !latest.bytesExpiredAt
          ? { projectId: latest.projectId, projectRunId: latest.projectRunId } : null;
      }
      return previewTargetForRun(
      state.resultRunId ? resultProjectRunsQuery.data ?? [] : projectRunsQuery.data ?? [],
      state.resultRunId ?? state.selectedRunId, runsQuery.data ?? []);
    },
    [projectRunsQuery.data, resultProjectRunsQuery.data, runsQuery.data, state.view, state.resultRunId, state.selectedRunId]
  );
  // READS ONLY. A GET allocates nothing server-side, which is what makes it
  // safe to poll from a tab a viewer left open on a run.
  const previewQuery = usePreviewStatus(
    previewTarget?.projectId ?? null,
    previewTarget?.projectRunId ?? null,
    (state.view === 'runs' || state.view === 'projects') && authed && !!previewTarget
  );
  // THE RUN'S STATUS IS WHAT MAKES A PREVIEW POSSIBLE, so a change to it must
  // re-ask. Nothing else will: `usePreviewStatus` stops polling once the state
  // is `stopped`, which is exactly what a run nobody has previewed reads as,
  // and `refetchOnWindowFocus` is off. So a run watched from `queued` never
  // learned it had gone `running`, and the control the member is waiting for
  // never appeared — the in-flight case, silently unreachable.
  //
  // It matters at the other end too. The run row flips to `delivered` BEFORE
  // the coordinator writes the descriptor, so a summary read in that window
  // says `available` from the in-flight branch and then sticks: the surface
  // would keep offering a snapshot of a run that has finished.
  const previewRunStatus =
    (projectRunsQuery.data ?? []).find(
      (run) => run.projectRunId === previewTarget?.projectRunId
    )?.status ?? null;
  useEffect(() => {
    if (!previewTarget || !previewRunStatus) return;
    void queryClient.invalidateQueries({
      queryKey: ['viz', 'preview', previewTarget.projectId, previewTarget.projectRunId],
    });
  }, [previewRunStatus, previewTarget, queryClient]);

  const login = useMemo(
    () =>
      gateBlocked
        ? {
            providers: authProviders,
            notice: loginParams.notice,
            pendingProvider: pendingLoginProvider,
          }
        : null,
    [authProviders, gateBlocked, loginParams.notice, pendingLoginProvider]
  );

  useEffect(() => {
    if (!pendingLoginProvider) return;
    const href = loginHref(pendingLoginProvider);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        window.location.assign(href);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [loginHref, pendingLoginProvider]);

  // For MEMBERS the permission ask lives in the FIRST RUN, not at login: the
  // moment a viewer's run is actually alive is when "hear about it even
  // offline" has visible value, and it is one-shot per browser. PLATFORM
  // ADMINS must end up subscribed — push routes target them for a curated set
  // of instance-wide platform events with or without a run — so they are
  // asked at login, and their "not now" only holds for the session
  // (`pushPromptStorage` picks the store).
  // Enabling or denying ends the offer for everyone: `shouldOfferPushPrompt`
  // re-checks the browser permission and the stored dismissal every time.
  const [pushPrompt, setPushPrompt] = useState<'hidden' | 'offer' | 'busy' | 'error'>('hidden');
  const hasLiveRun = useMemo(() => {
    const projectRunLive = Object.values(projectRuns).some((runs) =>
      runs.some((run) => run.status === 'queued' || run.status === 'running')
    );
    return projectRunLive || (runsQuery.data ?? []).some((entry) => isIndexEntryLive(entry));
  }, [projectRuns, runsQuery.data]);
  useEffect(() => {
    if (pushPrompt !== 'hidden') return;
    if (
      shouldOfferPushPrompt({
        authenticated: authed,
        hasLiveRun,
        platformAdmin: isPlatformAdmin,
      })
    ) {
      setPushPrompt('offer');
    }
  }, [authed, hasLiveRun, isPlatformAdmin, pushPrompt]);
  const enablePush = useCallback(async () => {
    setPushPrompt('busy');
    const outcome = await enableWebPush();
    if (outcome === 'error') {
      setPushPrompt('error');
      return;
    }
    // enabled, denied and unsupported all end the conversation for good.
    dismissPushPrompt(pushPromptStorage(isPlatformAdmin));
    setPushPrompt('hidden');
  }, [isPlatformAdmin]);
  const dismissPush = useCallback(() => {
    dismissPushPrompt(pushPromptStorage(isPlatformAdmin));
    setPushPrompt('hidden');
  }, [isPlatformAdmin]);
  // A permission already granted shows NO prompt (`permission !== 'default'`
  // ends the offer), so an admin who said yes once is silently re-subscribed
  // instead: enableWebPush reuses the browser subscription and re-saves it,
  // repairing a pruned server row without any UI or gesture. Once per mount —
  // the outcome cannot change within a page load.
  const ensuredAdminPush = useRef(false);
  useEffect(() => {
    if (ensuredAdminPush.current) return;
    if (!shouldEnsureAdminSubscription({ authenticated: authed, platformAdmin: isPlatformAdmin })) {
      return;
    }
    ensuredAdminPush.current = true;
    void enableWebPush();
  }, [authed, isPlatformAdmin]);

  // Settings is account-scoped: it exists exactly where a principal does.
  const organisationQuery = useOrganisation(state.view === 'settings' && authed);
  const accountModelsQuery = useAccountModels(state.view === 'settings' && authed);
  const [accountError, setAccountError] = useState<string | null>(null);
  const renameAccount = useCallback(
    async (displayName: string) => {
      setAccountError(null);
      try {
        await api.renameAccount(displayName);
        // whoami owns the display name and the source flag, and AuthControls
        // reads it once per page load — a reload is the honest refresh here.
        window.location.reload();
      } catch (error) {
        setAccountError(error instanceof Error ? error.message : t('settings.actionFailed'));
      }
    },
    [t]
  );

  // Seed the rename field with the name it is about to replace, once: an empty
  // box beside "Save" reads as "your name is blank".
  useEffect(() => {
    if (state.view !== 'settings' || !authSnapshot) return;
    if (state.search.displayName.length > 0) return;
    state.setSearch('displayName', authSnapshot.viewer.displayName);
  }, [authSnapshot, state]);

  const adminOrganisationsQuery = useAdminOrganisations(
    state.view === 'admin' && isPlatformAdmin
  );
  // The journal, the ledger tail and the sentinel read ride the same
  // admin-only gate as the organisation list: the server 403s them for anyone
  // else, and a poisoned query would take the whole view's error banner with
  // it. Each is enabled on ITS OWN view now — the three used to load together
  // because they shared one tab, which meant opening Admin fetched three
  // things to show one.
  const adminEventsQuery = useAdminEventsPages(state.view === 'journal' && isPlatformAdmin, {
    severity: state.journalSeverity,
    family: state.journalFamily,
  });
  const adminLedgerQuery = useAdminLedger(state.view === 'ledger' && isPlatformAdmin);
  const adminSentinelQuery = useAdminSentinel(state.view === 'sentinel' && isPlatformAdmin);
  // ONE way to ask for the next page, so the wheel gesture and the button
  // cannot diverge. React Query makes a second call while one is in flight a
  // no-op, and `hasNextPage` false makes it a no-op too — which is what lets
  // the wheel announce the bottom on every tick without consequence.
  const loadOlderEvents = useCallback(() => {
    if (!adminEventsQuery.hasNextPage || adminEventsQuery.isFetchingNextPage) return;
    void adminEventsQuery.fetchNextPage();
  }, [adminEventsQuery]);
  // The tray fetches only while it is open — the bell carries no unread badge,
  // so a closed menu has nothing to keep warm. Same one-loader rule as the
  // journal: the wheel gesture and the foot button share this callback.
  const notificationsQuery = useNotificationsPages(
    state.notificationsMenuOpen && authed,
    state.locale
  );
  const loadOlderNotifications = useCallback(() => {
    if (!notificationsQuery.hasNextPage || notificationsQuery.isFetchingNextPage) return;
    void notificationsQuery.fetchNextPage();
  }, [notificationsQuery]);
  const [adminInvitation, setAdminInvitation] = useState<VizAdminInvitation | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const updateState = useRef({ apiReady, pendingLoginProvider, authSnapshot, adminInvitation });
  updateState.current = { apiReady, pendingLoginProvider, authSnapshot, adminInvitation };
  const restoredNavigation = useRef(false);
  useEffect(() => {
    if (!apiReady || restoredNavigation.current) return;
    restoredNavigation.current = true;
    const scope = authSnapshot
      ? `${authSnapshot.viewer.principalId}:${authSnapshot.viewer.activeOrganisation?.id ?? 'none'}` : 'ungated';
    restoreUpdateNavigation(scope, visibleViews(authSnapshot));
  }, [apiReady, authSnapshot]);
  // Back/Forward start recording only after that restore, so putting the tab
  // back where an update found it is the first entry, not a navigation.
  const navigationScope = authSnapshot
    ? `${authSnapshot.viewer.principalId}:${authSnapshot.viewer.activeOrganisation?.id ?? 'none'}` : 'ungated';
  useEffect(() => { useGpuStore.getState().previewFile(null); }, [navigationScope]);
  useEffect(() => {
    if (!apiReady) return undefined;
    return startNavigationHistory({
      scope: navigationScope,
      routable: (view) => isRoutableView(view, updateState.current.authSnapshot),
    });
  }, [apiReady, navigationScope]);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const updater = startAutoUpdate({
      canReload: () => {
        const latest = updateState.current;
        const ui = useGpuStore.getState();
        return latest.apiReady && !latest.authSnapshot?.signingOut && !latest.authSnapshot?.switchingOrganisationId &&
          !ui.accountMenuOpen && !ui.localeMenuOpen && !ui.notificationsMenuOpen && !latest.pendingLoginProvider && !latest.adminInvitation &&
          pendingApiMutations() === 0 && queryClient.isMutating() === 0 &&
          !['settings', 'announce', 'admin'].includes(ui.view) && !ui.tuningPanelOpen &&
          // Opening Settings fills this field with the current name. Only a
          // changed name is an unsaved draft that must hold an update.
          (!ui.search.displayName || ui.search.displayName === latest.authSnapshot?.viewer.displayName);
      },
      beforeReload: () => {
        const auth = updateState.current.authSnapshot;
        saveUpdateNavigation(auth ? `${auth.viewer.principalId}:${auth.viewer.activeOrganisation?.id ?? 'none'}` : 'ungated');
      },
    });
    return () => updater.stop();
  }, [queryClient]);

  const mintInvitation = useCallback(async (orgId: string, role: string) => {
    setAdminError(null);
    try {
      const invitation = await api.createAdminInvitation({ orgId, role });
      setAdminInvitation(invitation);
      try {
        // Best effort: the URL also stays visible in the admin view for
        // manual transcription when the clipboard is unavailable.
        await navigator.clipboard.writeText(invitation.url);
      } catch {
        // Display fallback covers it.
      }
      await queryClient.invalidateQueries({ queryKey: ['viz', 'admin', 'organisations'] });
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : t('admin.actionFailed'));
    }
  }, [queryClient, t]);

  // A viewer whose nav does not include the current view (role changed,
  // admin revoked, stale state) lands back on projects instead of a dead tab.
  // ROUTABLE, not visible: Settings has no tab by design and would otherwise
  // be bounced away on the render right after it opened.
  useEffect(() => {
    if (!isRoutableView(state.view, authSnapshot)) state.setView('projects');
  }, [authSnapshot, state]);

  // A very fast Continue click while whoami was still in flight could enter
  // the app before the gate resolved to 'unauthenticated'. Send that visitor
  // back to the arrival gate — it is the login.
  useEffect(() => {
    if (gateBlocked && state.entered) useGpuStore.setState({ entered: false });
  }, [gateBlocked, state.entered]);

  // The handheld predicate is a live media query (a DevTools device toggle
  // flips it without a reload); the store holds one sample of it.
  useEffect(() => {
    const query = handheldMediaQuery();
    if (!query) return undefined;
    const refresh = () => useGpuStore.getState().setHandheld(isHandheldDevice());
    query.addEventListener('change', refresh);
    return () => query.removeEventListener('change', refresh);
  }, []);

  useEffect(() => {
    if (state.handheld && !state.handheldAccepted && state.entered) {
      useGpuStore.setState({ entered: false });
    }
  }, [state.entered, state.handheld, state.handheldAccepted]);

  useEffect(() => {
    const runs = runsQuery.data ?? [];
    if (!state.selectedRunId && runs[0]) state.selectRun(runs[0].id);
  }, [runsQuery.data, state]);

  useEffect(() => {
    const registries = registriesQuery.data ?? [];
    if (!state.selectedRegistryId && registries[0]) {
      state.selectRegistry(registries.find((item) => item.exists)?.id ?? registries[0].id);
    }
  }, [registriesQuery.data, state]);

  useEffect(() => {
    const types = registryQuery.data?.types ?? [];
    if (!state.selectedRegistryAtom && types[0]) state.selectRegistryAtom(types[0].name);
  }, [registryQuery.data, state]);

  useEffect(() => {
    if (state.selectedSkill) return;
    const firstNamespace = namespaceNames[0];
    const firstSkill = firstNamespace ? skillLists.byNamespace[firstNamespace]?.[0] : undefined;
    if (firstNamespace && firstSkill) {
      state.selectSkill({ l1Name: firstNamespace, id: firstSkill.id });
    }
  }, [namespaceNames, skillLists.byNamespace, state]);

  // NO auto-select of the first project. The form the Projects view carries is
  // the create form until a project is selected, so auto-selecting one made
  // creating a project unreachable for anyone who already had one — and it
  // would have re-selected on the render right after a deselect, so the toggle
  // in `activate` could never land either. Only the REPAIR remains: a
  // selection whose project is gone falls back to the first that exists.
  useEffect(() => {
    const projects = projectsQuery.data ?? [];
    if (state.view !== 'projects' || !projectsQuery.data) return;
    const nextSelection = projectSelectionAfterProjects(
      state.selectedProjectId,
      projects.map((project) => project.projectId)
    );
    if (nextSelection !== state.selectedProjectId) state.selectProject(nextSelection);
  }, [projectsQuery.data, state]);

  // THE PREVIEW SESSION stays in a local hook rather than in the store on
  // purpose: `previewUrl` carries a one-time claim in its fragment, so it is a
  // credential — never the store (which a devtools reader can dump), never a
  // query cache, never a log line. Nothing on the canvas reads any of it, so
  // there is no shared transition for the store to own either.
  const previewSummary = previewQuery.data ?? null;
  const previewProject = previewTarget
    ? projectsQuery.data?.find((project) => project.projectId === previewTarget.projectId) ?? null
    : null;
  const previewGoal =
    (projectRunsQuery.data ?? []).find(
      (run) => run.projectRunId === previewTarget?.projectRunId
    )?.goal ?? '';

  const { previewOpen, previewUrl, previewStatus, previewError, previewReloadNonce,
    requestPreview, closePreview, stopPreview, reloadPreview } = usePreviewSession({ previewTarget, previewSummary, t });

  const projectPreviewSelected = state.view === 'projects' && !!selectedProject && state.projectSection === 'preview';
  const requestedProjectPreview = useRef<string | null>(null);
  useEffect(() => {
    if (!projectPreviewSelected) {
      if (requestedProjectPreview.current !== null) closePreview();
      requestedProjectPreview.current = null;
      return;
    }
    if (!previewTarget || !previewSummary || (previewSummary.availability !== 'available' && !previewSummary.terminalAvailable)) return;
    const key = `${previewTarget.projectId}/${previewTarget.projectRunId}`;
    if (requestedProjectPreview.current === key) return;
    requestedProjectPreview.current = key;
    void requestPreview('open');
  }, [projectPreviewSelected, previewTarget, previewSummary, requestPreview, closePreview]);

  const activate = useCallback((id: string) => {
    if (id === 'result.details') {
      useGpuStore.getState().toggleResultDetails();
      return;
    }
    if (id === 'result.close') {
      const current = useGpuStore.getState();
      if (current.view === 'projects' && current.projectSection === 'result') current.selectProjectSection('runs');
      else current.selectResult(null);
      return;
    }
    if (id.startsWith('result.open.')) {
      useGpuStore.getState().selectResult(id.slice('result.open.'.length));
      return;
    }
    if (id === 'result.copy' || id === 'result.download' || id.startsWith('result.file.')) {
      const resultId = useGpuStore.getState().resultRunId;
      if (!resultId) return;
      if (id.startsWith('result.file.')) {
        const rows = queryClient.getQueryData<import('../client/types.js').VizProjectRun[]>(['viz', 'project', resultProjectId, 'runs']) ?? [];
        const row = rows.find(row => row.traceId === resultId || row.projectRunId === resultId);
        const path = decodeURIComponent(id.slice('result.file.'.length));
        if (row && !row.bytesExpiredAt && row.artifactManifest?.files.some(file => file.path === path)) {
          useGpuStore.getState().previewFile({ projectId: row.projectId, runId: row.projectRunId, path });
        }
        return;
      }
      const run = queryClient.getQueryData<import('../client/types.js').VizRun>(['viz', 'run', resultId]);
      if (!run || run.id !== resultId) return;
      const text = resultText(run);
      if (text === null) return;
      if (id === 'result.copy') {
        void (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('Clipboard unavailable'))).then(
          () => { if (useGpuStore.getState().resultRunId === resultId) useGpuStore.getState().setResultActionStatus('copied'); },
          () => { if (useGpuStore.getState().resultRunId === resultId) useGpuStore.getState().setResultActionStatus('failed'); });
      } else {
        const url = URL.createObjectURL(new Blob([JSON.stringify(run.result, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = `result-${run.id}.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      return;
    }
    const store = useGpuStore.getState();
    // The menu's own open/closed state is UI, not identity, so it is handled
    // here rather than delegated to the auth controller.
    if (id === 'account.menu.toggle') {
      store.toggleAccountMenu();
      return;
    }
    if (id === 'account.menu.close') {
      store.closeAccountMenu();
      return;
    }
    if (id === 'appearance.dropdown.toggle') {
      store.toggleThemeDropdown();
      return;
    }
    if (id.startsWith('appearance.select.')) {
      const theme = id.slice('appearance.select.'.length);
      if (isAppearanceTheme(theme)) store.setAppearanceTheme(theme);
      return;
    }
    if (id === 'notifications.menu.toggle') {
      store.toggleNotificationsMenu();
      return;
    }
    if (id === 'notifications.menu.close') {
      store.closeNotificationsMenu();
      return;
    }
    if (id === 'notifications.more') {
      loadOlderNotifications();
      return;
    }
    // A tray row's destination — `setView` is a navigation, so it also closes
    // the menu the click came from (viewChange owns that rule).
    if (id.startsWith('notifications.go.run.')) {
      store.selectRun(id.slice('notifications.go.run.'.length));
      store.setView('runs');
      return;
    }
    if (id.startsWith('notifications.go.project.')) {
      store.selectProject(id.slice('notifications.go.project.'.length));
      store.setView('projects');
      return;
    }
    if (id.startsWith('notifications.go.view.')) {
      const view = id.slice('notifications.go.view.'.length) as typeof store.view;
      // The resolver already scoped targets to the viewer, but a stale row or
      // a revoked role must land nowhere rather than on a bounced tab.
      if (isRoutableView(view, authSnapshot)) store.setView(view);
      return;
    }
    if (id === 'account.settings') {
      setSettingsInitialTab('general');
      store.setView('settings');
      return;
    }
    if (id.startsWith('auth.')) {
      activateAuth(id);
      return;
    }
    if (id === 'welcome.continue') {
      arrive();
      return;
    }
    if (id === 'brand.crystal') {
      store.activateCrystal();
      return;
    }
    if (id.startsWith('nav.')) {
      const nextView = id.slice(4) as typeof store.view;
      // Re-clicking Projects returns to the organisation list and MCP guide.
      if (nextView === 'projects' && store.view === 'projects' && store.selectedProjectId) {
        store.selectProject(null);
      }
      store.activateView(nextView);
      return;
    }
    if (id === 'tuning.toggle') {
      store.toggleTuningPanel();
      return;
    }
    if (id === 'locale.menu.toggle') {
      store.toggleLocaleMenu();
      return;
    }
    if (id === 'locale.menu.close') {
      store.closeLocaleMenu();
      return;
    }
    if (id.startsWith('locale.select.')) {
      const locale = id.slice('locale.select.'.length);
      if (isLocale(locale)) store.setLocale(locale);
      return;
    }
    if (id.startsWith('run.select.')) {
      store.selectRun(id.slice('run.select.'.length));
      store.setFocusedInput(null);
      return;
    }
    if (id.startsWith(TIMELINE_JUMP_PREFIX)) {
      const row = Number(id.slice(TIMELINE_JUMP_PREFIX.length));
      const viewport = metrics.current.timelineViewport;
      if (store.view === 'runs' && viewport && Number.isInteger(row) && row >= 0) {
        const maximum = Math.max(0, viewport.totalHeight - viewport.height);
        store.setScrollY('runs', Math.max(0, Math.min(maximum,
          viewport.contentTopPadding + (row + 0.5) * viewport.rowHeight - viewport.height / 2)));
        // Resolve against the displayed rows: a live refresh may already have
        // newer events in the query cache while this reader's view is retained.
        store.selectEvent(viewport.eventIds[row - viewport.rowOffset] ?? null);
      }
      return;
    }
    if (id.startsWith('event.')) {
      store.selectEvent(id.slice('event.'.length));
      return;
    }
    if (id === 'run.event.close') {
      store.selectEvent(null);
      return;
    }
    if (id === 'activity.open' || id === 'activity.close') {
      store.showRunActivity(id === 'activity.open');
      return;
    }
    if (id === 'activity.files' || id.startsWith('activity.file.')) {
      store.selectActivityFile(id === 'activity.files' ? null : decodeURIComponent(id.slice('activity.file.'.length)));
      return;
    }
    if (id.startsWith('activity.expand.') || id.startsWith('activity.collapse.')) {
      const expanded = id.startsWith('activity.expand.');
      store.setActivityChangeExpanded(decodeURIComponent(id.slice(expanded ? 'activity.expand.'.length : 'activity.collapse.'.length)), expanded);
      return;
    }
    if (id === 'activity.newer' || id === 'activity.older') {
      store.pageActivity(id === 'activity.older' ? 1 : -1);
      return;
    }
    if (id.startsWith('atom.')) {
      store.selectAtom(id.slice('atom.'.length));
      return;
    }
    if (id.startsWith('run.filter.kind.')) {
      store.setRunFilters(
        nextRunFilters(store.runFilters, 'kind', id.slice('run.filter.kind.'.length))
      );
      return;
    }
    if (id.startsWith('run.filter.role.')) {
      store.setRunFilters(
        nextRunFilters(store.runFilters, 'role', id.slice('run.filter.role.'.length))
      );
      return;
    }
    if (id.startsWith('run.filter.branch.')) {
      store.setRunFilters(
        nextRunFilters(store.runFilters, 'branchId', id.slice('run.filter.branch.'.length))
      );
      return;
    }
    if (id === 'branch.heading.toggle') {
      store.toggleBranchHeading();
      return;
    }
    if (id === 'run.summary.toggle') {
      store.toggleRunSummary();
      return;
    }
    // The preview controls, drawn as siblings of the summary card so the
    // full-card toggle above cannot swallow them.
    if (id === 'run.preview.open') {
      // `failed` reopens as a RESTART, not an open: a generation that could
      // not start is not one to retry into, and the state machine already
      // says a new attempt is a new generation.
      void requestPreview(previewQuery.data?.state === 'failed' ? 'restart' : 'open');
      return;
    }
    if (id === 'run.preview.stop') {
      void stopPreview();
      return;
    }
    if (id === 'runs.projects.all') {
      store.selectProject(null);
      store.setView('projects');
      return;
    }
    if (id.startsWith('runs.project.open.')) {
      store.selectProject(id.slice('runs.project.open.'.length));
      store.setView('projects');
      return;
    }
    if (id.startsWith('project.section.')) {
      if (!store.selectedProjectId) return;
      const section = id.slice('project.section.'.length);
      const rows = projectRunsQuery.data ?? [];
      if (section === 'conversation') store.selectProjectSection('conversation');
      else if (section === 'runs') store.selectProjectSection('runs');
      else if (section === 'preview') store.selectProjectSection('preview');
      else if (section === 'files') store.selectProjectSection('files', latestWorkspaceRun(rows)?.projectRunId);
      else if (section === 'result') store.selectProjectSection('result', latestDeliveredResult(rows)?.traceId);
      return;
    }
    if (id.startsWith('workspace.open.')) { store.openWorkspace(id.slice('workspace.open.'.length)); return; }
    if (id === 'workspace.close') { store.openWorkspace(null); return; }
    if (id.startsWith('workspace.path.')) {
      const path = id.slice('workspace.path.'.length);
      if (state.selectedProjectId && state.workspaceRunId && workspace.index?.files.some(file => file.path === path)) {
        store.previewFile({ projectId: state.selectedProjectId, runId: state.workspaceRunId, path });
      } else store.selectWorkspacePath(path);
      return;
    }
    if (id === 'project.all') {
      store.selectProject(null);
      return;
    }
    if (id.startsWith('project.select.')) {
      // Toggle: re-clicking the selected project returns to the full list.
      const projectId = id.slice('project.select.'.length);
      store.selectProject(projectSelectionAfterActivate(store.selectedProjectId, projectId));
      return;
    }
    if (id.startsWith('project.repository.')) {
      const projectId = id.slice('project.repository.'.length);
      const project = projectsQuery.data?.find((candidate) => candidate.projectId === projectId);
      openGitHubRepository(project?.repositoryUrl);
      return;
    }
    if (id.startsWith('project.checkpoint.')) {
      const run = projectRunsQuery.data?.find(candidate => candidate.projectRunId === id.split('.').at(-1));
      if (!run || !canControlCheckpoint(run, authSnapshot) || githubRecoveryLock.current) return;
      githubRecoveryLock.current = true;
      setGitHubRecovery({ runId: run.projectRunId, busy: true });
      void api.controlCheckpoint(run.projectId, run.projectRunId, ['paused', 'recoverable'].includes(run.checkpoint?.state ?? '') ? 'resume' : 'pause')
        .then(() => { setGitHubRecovery(null); })
        .catch((error: unknown) => { setGitHubRecovery({ runId: run.projectRunId, busy: false,
          message: error instanceof Error ? error.message : t('projects.checkpoint.failed') }); })
        .finally(() => {
          githubRecoveryLock.current = false;
          void queryClient.invalidateQueries({ queryKey: ['viz', 'projects'] });
          void queryClient.invalidateQueries({ queryKey: ['viz', 'project', run.projectId, 'runs'] });
        });
      return;
    }
    if (id.startsWith('project.githubAuthorize.') || id.startsWith('project.githubContinue.') || id.startsWith('project.githubRetry.')) {
      const run = projectRunsQuery.data?.find(candidate => candidate.projectRunId === id.split('.').at(-1));
      const access = run && pendingGitHubAccess(run);
      if (!run) return;
      const retryPublication = id.startsWith('project.githubRetry.') && canRetryPublication(run, authSnapshot);
      if (!access && !retryPublication) return;
      if (id.startsWith('project.githubAuthorize.')) {
        if (access) window.open(access.settingsUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      if (githubRecoveryLock.current || (!retryPublication && !canContinueGitHubAccess(run, authSnapshot))) return;
      githubRecoveryLock.current = true;
      setGitHubRecovery({ runId: run.projectRunId, busy: true });
      void (retryPublication ? api.retryPublication(run.projectId, run.projectRunId) : api.continueGitHubAccess(run.projectId, run.projectRunId)).then(async () => {
        setGitHubRecovery(null);
        await queryClient.invalidateQueries({ queryKey: ['viz', 'projects'] });
      }).catch(() => {
        setGitHubRecovery({ runId: run.projectRunId, busy: false, message: t('projects.githubAccess.retryFailed') });
      }).finally(() => {
        githubRecoveryLock.current = false;
        void queryClient.invalidateQueries({ queryKey: ['viz', 'project', run.projectId, 'runs'] });
      });
      return;
    }
    if (id.startsWith('project.pullRequest.')) {
      const run = projectRunsQuery.data?.find(candidate => candidate.projectRunId === id.slice('project.pullRequest.'.length));
      openGitHubRepository(run?.publication?.pullRequestUrl);
      return;
    }
    if (id.startsWith(PARTIAL_CONTINUE_PREFIX)) {
      // Open the project. Its MCP guide tells the person to ask their agent
      // to inspect the latest run and propose the next goal.
      const projectId = id.slice(PARTIAL_CONTINUE_PREFIX.length);
      const run = runQuery.data;
      const guidance = run
        ? partialRunGuidance(run, runsQuery.data ?? [], projectsQuery.data ?? [])
        : null;
      if (guidance?.project?.projectId !== projectId) return;
      store.selectProject(projectId);
      store.setView('projects');
      return;
    }
    if (id.startsWith('project.run.')) {
      store.selectRun(id.slice('project.run.'.length));
      store.setView('runs');
      return;
    }
    if (id.startsWith('registry.select.')) {
      store.selectRegistry(id.slice('registry.select.'.length));
      return;
    }
    if (id.startsWith('registry.atom.')) {
      store.selectRegistryAtom(id.slice('registry.atom.'.length));
      return;
    }
    if (id.startsWith('skill.open.') || id.startsWith('skill.select.')) {
      const marker = id.startsWith('skill.open.') ? 'skill.open.' : 'skill.select.';
      const [l1Name, skillId] = id.slice(marker.length).split('::');
      if (l1Name && skillId) {
        store.selectSkill({ l1Name, id: skillId });
        store.setView('skills');
      }
      return;
    }
    if (id.startsWith('burnin.family.')) {
      store.setBurninFilter('family', id.slice('burnin.family.'.length));
      return;
    }
    if (id.startsWith('burnin.outcome.')) {
      store.setBurninFilter('outcome', id.slice('burnin.outcome.'.length));
      return;
    }
    if (id.startsWith('burnin.preset.')) {
      store.setBurninFilter('preset', id.slice('burnin.preset.'.length));
      return;
    }
    if (id === 'burnin.page.prev') {
      store.setBurninPage(Math.max(1, store.burninPage - 1));
      return;
    }
    if (id === 'burnin.page.next') {
      store.setBurninPage(store.burninPage + 1);
      return;
    }
    if (id.startsWith('burnin.trace.')) {
      store.selectRun(id.slice('burnin.trace.'.length));
      store.setView('runs');
      return;
    }
    if (id.startsWith('docs.theme.')) {
      store.selectDocsTheme(id.slice('docs.theme.'.length) as DocsThemeKey);
      return;
    }
    if (id.startsWith('login.provider.')) {
      if (pendingLoginProvider) return;
      setPendingLoginProvider(id.slice('login.provider.'.length));
      return;
    }
    if (id.startsWith('journal.severity.')) {
      store.setJournalFilter('severity', id.slice('journal.severity.'.length));
      return;
    }
    if (id.startsWith('journal.family.')) {
      store.setJournalFilter('family', id.slice('journal.family.'.length));
      return;
    }
    // The gesture and the button, one handler. `scroll.end.<view>` is the
    // renderer saying a downward wheel had nowhere left to go.
    if (id === 'journal.more' || id === 'scroll.end.journal') {
      loadOlderEvents();
      return;
    }
    if (id.startsWith('scroll.end.')) return;
    if (id.startsWith('sentinel.run.')) {
      store.selectRun(id.slice('sentinel.run.'.length));
      store.setView('runs');
      return;
    }
    if (id.startsWith('admin.invite.')) {
      const rest = id.slice('admin.invite.'.length);
      const separator = rest.indexOf('.');
      const role = rest.slice(0, separator);
      const orgId = rest.slice(separator + 1);
      if (role && orgId) void mintInvitation(orgId, role);
      return;
    }
  }, [
    activateAuth,
    queryClient,
    resultProjectId,
    workspace.index,
    state.selectedProjectId,
    state.workspaceRunId,
    authSnapshot,
    arrive,
    loadOlderEvents,
    loadOlderNotifications,
    mintInvitation,
    pendingLoginProvider,
    previewQuery.data?.state,
    projectRunsQuery.data,
    setGitHubRecovery,
    projectsQuery.data,
    requestPreview,
    runQuery.data,
    runsQuery.data,
    stopPreview,
  ]);

  // A push click opens its subject the way the tray row for the same event
  // would: one rule, `notificationTarget`, against the viewer as it is NOW.
  // Declared after the history recorder, so the arrival is its own entry and
  // Back returns to where the viewer was.
  const activateRef = useRef(activate);
  activateRef.current = activate;
  useEffect(() => {
    if (!apiReady) return undefined;
    const open = (link: NotificationLink): void => {
      const auth = updateState.current.authSnapshot;
      const target = notificationTarget(link, {
        platformAdmin: auth?.viewer.platformAdmin === true,
        activeOrgId: auth?.viewer.activeOrganisation?.id ?? null,
      });
      if (target) activateRef.current(target);
    };
    const launch = takeLaunchNotificationLink();
    if (launch) open(launch);
    return listenForNotificationLinks(open);
  }, [apiReady]);

  const loading =
    (state.view === 'projects' && (projectsQuery.isLoading || githubInstallationsQuery.isLoading)) ||
    (state.view === 'runs' && (runsQuery.isLoading || runQuery.isLoading)) ||
    (state.view === 'registry' && (registriesQuery.isLoading || registryQuery.isLoading)) ||
    (state.view === 'skills' && namespacesQuery.isLoading) ||
    (state.view === 'burnin' && burninQuery.isLoading) ||
    (state.view === 'admin' && adminOrganisationsQuery.isLoading) ||
    // The FIRST page only. A later page loads under a foot-of-list notice
    // inside the view; swapping the whole screen for "loading" while the
    // viewer reads row 300 would throw their place away.
    (state.view === 'journal' && adminEventsQuery.isLoading) ||
    (state.view === 'ledger' && adminLedgerQuery.isLoading) ||
    (state.view === 'sentinel' && adminSentinelQuery.isLoading) ||
    (state.view === 'settings' && (organisationQuery.isLoading || accountModelsQuery.isLoading));
  const error = errorMessage([
    runsQuery.error,
    runQuery.error,
    registriesQuery.error,
    registryQuery.error,
    namespacesQuery.error,
    ...skillLists.results.map((result) => result.error),
    // skillDetailQuery.error is DELIBERATELY absent, for the reason the
    // project routes below are: one recipe body that will not load is the
    // business of the pane that shows it, not of the view. A run's skill
    // events cite the identities they saw, and a recipe dropped, merged or
    // learned under an identity the fold has since moved answers 404 — which
    // as a global error painted a banner over the whole run graph. It
    // surfaces as `skillDetailFailed` in the pane instead.
    burninQuery.error,
    projectsQuery.error,
    githubInstallationsQuery.error,
    projectRunsQuery.error,
    adminOrganisationsQuery.error,
    organisationQuery.error,
    accountModelsQuery.error,
    adminEventsQuery.error,
    adminLedgerQuery.error,
    adminSentinelQuery.error,
  ], t);
  const data = useMemo(() => ({
    auth: authSnapshot,
    runs: runsQuery.data ?? [],
    run: runQuery.data ?? null,
    resultRun: resultQuery.data?.id === state.resultRunId ? resultQuery.data : null,
    resultFailed: resultQuery.isError,
    registries: registriesQuery.data ?? [],
    registry: registryQuery.data ?? null,
    skillNamespaces: namespacesQuery.data ?? [],
    skillsByNamespace: skillLists.byNamespace,
    skillDetail: skillDetailQuery.data ?? null,
    skillDetailFailed: skillDetailQuery.isError,
    burnin: burninQuery.data ?? null,
    guidance: null,
    workspace,
    projects: projectsQuery.data ?? [],
    githubRecovery,
    projectRuns: resultProjectId && resultProjectRunsQuery.data
      ? { ...projectRuns, [resultProjectId]: resultProjectRunsQuery.data } : projectRuns,
    githubInstallations: githubInstallationsQuery.data ?? [],
    adminOrganisations: adminOrganisationsQuery.data ?? [],
    adminEvents: adminEventsQuery.data?.pages.flatMap((page) => page.events) ?? [],
    adminEventsHasMore: adminEventsQuery.hasNextPage === true,
    adminEventsLoading: adminEventsQuery.isFetchingNextPage === true,
    notifications:
      notificationsQuery.data?.pages.flatMap((page) => page.notifications) ?? [],
    notificationsHasMore: notificationsQuery.hasNextPage === true,
    notificationsLoading:
      notificationsQuery.isLoading || notificationsQuery.isFetchingNextPage,
    // Kept OUT of the global `error` above: a failed tray read renders inside
    // the open menu instead of replacing the view behind it with a banner.
    notificationsError: notificationsQuery.isError,
    adminLedger: adminLedgerQuery.data?.events ?? [],
    adminSentinel: adminSentinelQuery.data ?? null,
    adminInvitation,
    adminError,
    organisation: organisationQuery.data ?? null,
    accountModels: accountModelsQuery.data ?? null,
    accountError,
    preview: previewQuery.data ?? null,
    login,
    loading,
    error,
  }), [
    githubRecovery,
    workspace,
    accountError,
    accountModelsQuery.data,
    previewQuery.data,
    adminError,
    adminInvitation,
    adminOrganisationsQuery.data,
    adminEventsQuery.data,
    adminEventsQuery.hasNextPage,
    adminEventsQuery.isFetchingNextPage,
    notificationsQuery.data,
    notificationsQuery.hasNextPage,
    notificationsQuery.isFetchingNextPage,
    notificationsQuery.isLoading,
    notificationsQuery.isError,
    adminLedgerQuery.data,
    adminSentinelQuery.data,
    authSnapshot,
    organisationQuery.data,
    login,
    burninQuery.data,
    error,
    githubInstallationsQuery.data,
    loading,
    namespacesQuery.data,
    projectRuns,
    projectsQuery.data,
    registriesQuery.data,
    registryQuery.data,
    runQuery.data,
    resultQuery.data,
    resultQuery.isError,
    resultProjectId,
    resultProjectRunsQuery.data,
    state.resultRunId,
    runsQuery.data,
    skillDetailQuery.data,
    skillDetailQuery.isError,
    skillLists.byNamespace,
  ]);

  const updateMetrics = useCallback((next: GpuRenderMetrics) => {
    metrics.current = next;
    if (import.meta.env.DEV && window.__ATOMA_VIZ_TEST__) {
      window.__ATOMA_VIZ_TEST__.renderer = next;
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__ATOMA_VIZ_TEST__ = {
      view: state.view,
      cameraMode: state.sceneCameraMode,
      renderer: metrics.current,
      selectedRunId: state.selectedRunId,
      dispatch: activate,
    };
    return () => {
      delete window.__ATOMA_VIZ_TEST__;
    };
  }, [activate, state.sceneCameraMode, state.selectedRunId, state.view]);

  const previewPlane = (
    <PreviewPlane
        embedded={projectPreviewSelected}
        veiled={state.accountMenuOpen || state.localeMenuOpen || state.notificationsMenuOpen}
        open={previewOpen}
        summary={previewSummary}
        url={previewUrl}
        projectName={previewProject?.name ?? ''}
        goal={previewGoal}
        reloadNonce={previewReloadNonce}
        status={previewStatus}
        errorMessage={previewError}
        t={t}
        locale={state.locale}
        onClose={() => { closePreview(); if (projectPreviewSelected) useGpuStore.getState().selectProjectSection('runs'); }}
        onReload={reloadPreview}
        onRestart={() => { void requestPreview('restart'); }}
        onStop={() => { void stopPreview(); }}
      />
  );

  return (
    <main className="gpu-app" style={CHEVRON_CSS_VARS as CSSProperties} data-entered={state.entered ? 'true' : 'false'} data-theme={state.appearanceTheme} data-theme-transition={appearanceTransition.phase}>
      {/* The product tree goes INERT behind an open preview, not merely
          hidden: `inert` takes the whole subtree out of focus order, hit
          testing and the accessibility tree in one attribute, so a tab press
          cannot land on a GL control the member cannot see, and a screen
          reader is not read two surfaces at once. `aria-hidden` alone would
          have done only the last of the three. */}
      {/* Stop rendering the crystal once the mobile notice covers the scene. */}
      {handheldPhase === 'white' ? null : (
      <div className="gpu-scene-host" inert={!!state.filePreview || (previewOpen && !projectPreviewSelected && requestedProjectPreview.current === null) || handheldPhase !== 'idle' || appearanceTransition.phase !== 'idle'}>
      <CubeTurnPlane mode={state.sceneCameraMode} navigation={sceneNavigation}>
      <SceneCameraPlane mode={state.sceneCameraMode} onSettled={cameraSettled}>
        <GpuSurface
          data={data}
          releaseVersion={RELEASE_VERSION}
          t={t}
          onActivate={activate}
          onMetrics={updateMetrics}
          cameraRevision={cameraRevision}
        />
        <GpuDomBridge
          authSnapshot={authSnapshot}
          runs={runsQuery.data ?? []}
          run={runQuery.data ?? null}
          releaseVersion={RELEASE_VERSION}
          views={visibleViews(authSnapshot)}
          loginLinks={
            login
              ? login.providers.map((provider) => ({
                  id: provider.id,
                  label: provider.label,
                  href: loginHref(provider.id),
                }))
              : null
          }
          pendingLoginProvider={pendingLoginProvider}
          onLoginStart={setPendingLoginProvider}
          t={t}
          onSelectRun={state.selectRun}
          onEnter={arrive}
          githubInstallations={githubInstallationsQuery.data ?? []}
          projects={projectsQuery.data ?? []}
          projectRuns={projectRunsQuery.data ?? []}
          githubRecovery={githubRecovery}
          auth={authSnapshot}
          // ONE card on Projects (owner, 2026-10-09): the guide hosts the
          // conversation for a member of an organisation; a viewer gets the
          // guide alone. Keyed on the scope so a created project remounts it.
          assistant={state.view === 'projects' && authSnapshot && activeOrgId && authSnapshot.viewer.role !== 'org:viewer' ? (externalAgentGuide, heading) => <AssistantPanel
            key={`${authSnapshot.viewer.principalId}:${activeOrgId}:${state.selectedProjectId ?? 'new'}`}
            scopeKey={`${authSnapshot.viewer.principalId}:${activeOrgId}`}
            projectId={state.selectedProjectId} locale={state.locale} t={t} externalAgentGuide={externalAgentGuide}
            heading={heading} collapsed={!state.selectedProjectId && state.projectMcpCollapsed}
            onSettings={tab => { setSettingsInitialTab(tab); state.setView('settings'); }}
            onScopeChange={id => { state.selectProject(id); useGpuStore.setState({ projectMcpCollapsed: false }); }}
            onProject={id => { state.selectProject(id); state.selectProjectSection('runs'); }}
            onRun={(run, traceId) => {
              state.selectProject(run.projectId);
              state.selectProjectSection('runs');
              if (traceId) { state.selectRun(traceId); state.setView('runs'); }
            }}
          /> : null}
          workspace={workspace}
          mcpAccessState={mcpAccessState}
          onOpenMcp={() => {
            setSettingsInitialTab('mcp');
            useGpuStore.getState().setView('settings');
          }}
          pushPrompt={pushPrompt}
          onEnablePush={() => { void enablePush(); }}
          onDismissPush={dismissPush}
          preview={previewSummary}
          onActivate={activate}
          orgModelsForm={
            state.view === 'settings' &&
            authSnapshot !== null &&
            authSnapshot.viewer.activeOrganisation !== null ? (
              <OrgModelsForm
                t={t}
                locale={state.locale}
                initialTab={settingsInitialTab}
                enabled={true}
                canManageOrg={
                  authSnapshot.viewer.platformAdmin ||
                  authSnapshot.viewer.role === 'org:owner' ||
                  authSnapshot.viewer.role === 'org:admin'
                }
                platformAdmin={authSnapshot.viewer.platformAdmin}
                organisation={organisationQuery.data ?? null}
                overlaysInert={
                  state.accountMenuOpen || state.localeMenuOpen || state.notificationsMenuOpen
                }
                onError={setAccountError}
                profile={
                  <SettingsProfileForm
                    t={t}
                    onRenameAccount={(displayName) => { void renameAccount(displayName); }}
                    accountError={accountError}
                  />
                }
              >
                <McpAccess
                  key={`${authSnapshot.viewer.principalId}:${authSnapshot.viewer.activeOrganisation?.id ?? 'none'}`}
                  t={t}
                  locale={state.locale}
                  onError={setAccountError}
                />
              </OrgModelsForm>
            ) : null
          }
        />
        {projectPreviewSelected && previewPlane}
        <SceneTuningPanel />
      </SceneCameraPlane>
      </CubeTurnPlane>
      </div>
      )}
      {state.filePreview && <FilePreview key={`${state.filePreview.projectId}:${state.filePreview.runId}:${state.filePreview.path}`}
        target={state.filePreview} t={t} locale={state.locale} onClose={() => useGpuStore.getState().previewFile(null)} />}
      {!projectPreviewSelected && requestedProjectPreview.current === null && previewPlane}
      <AtomaCursor />
      <EntryVeilLayer phase={entryPhase} />
      <HandheldVeilLayer
        phase={handheldPhase}
        floodRef={handheldFloodRef}
        notice={t('welcome.handheld.hint')}
        continueLabel={t('welcome.handheld.continue')}
        onContinue={dismissHandheldWhiteout}
      />
      <AppearanceVeilLayer {...appearanceTransition} />
    </main>
  );
}
