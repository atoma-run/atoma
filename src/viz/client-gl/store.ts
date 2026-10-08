import type { FilePreviewTarget } from './workspace-browser.js';
import { create } from 'zustand';
import { isLocale, type Locale } from '../../contracts/locales.js';
import { applyDocumentLocale } from '../client/i18n-catalog.js';
import type { EventFilters } from '../client/run-utils.js';
import type { SceneCameraMode } from './scene-camera.js';
import type { DocsThemeKey } from './docs-content.js';
import { isHandheldDevice } from './handheld.js';
import { isAppearanceTheme, type AppearanceTheme } from './theme.js';
import { prefersReducedMotion } from './renderer/motion.js';

export { DOC_THEMES, type DocsThemeKey } from './docs-content.js';

export type ViewName =
  | 'projects'
  | 'runs'
  | 'registry'
  | 'skills'
  | 'burnin'
  | 'docs'
  | 'admin'
  | 'journal'
  | 'ledger'
  | 'sentinel'
  | 'announce'
  | 'settings';

/**
 * The admin plane, one view per JOB rather than one tab holding four.
 *
 * `admin` keeps its key (organisations and invitations) because it is the
 * stored scroll key, the doc theme and the route every existing link uses;
 * its LABEL is what changed. The journal, the catalogue ledger and the
 * sentinel each answer a different question and each needs its own scroll
 * position and its own filters — which one stacked view could not give them.
 *
 * `announce` is the plane's only WRITE surface, and it is last for that
 * reason: the other four report what happened, this one reaches every
 * subscriber's pocket. It rode at the foot of the organisation list, which
 * put a broadcast composer under a screen nobody opens to broadcast, and cost
 * that list 260px of height on every visit.
 */
export const ADMIN_VIEWS: readonly ViewName[] = [
  'admin',
  'journal',
  'ledger',
  'sentinel',
  'announce',
];

/**
 * ONE definition of which nav tabs a viewer gets — the DOM tablist and the
 * GL rail both read it, or they drift.
 *
 * - Gate off (`auth` null): the classic operator developer path — every
 *   instance surface, no admin plane (there are no organisations to manage).
 * - Gated platform admin: everything, plus the admin plane.
 * - Gated member: org-scoped work plus the two platform commons — the Registry
 *   (the one platform registry every run reads and earns on) and the
 *   Skills catalog. Burn-in remains private operator state.
 *
 * There is no `launch` tab: the Projects view directs members to their
 * connected MCP agent, which drafts goals from the existing work context.
 * The member guide explains how to review those goals.
 */
export function visibleViews(auth: { viewer: { platformAdmin: boolean } } | null): ViewName[] {
  if (!auth) return ['projects', 'runs', 'registry', 'skills', 'burnin', 'docs'];
  if (auth.viewer.platformAdmin) {
    return ['projects', 'runs', 'registry', 'skills', 'burnin', 'docs', ...ADMIN_VIEWS];
  }
  return ['projects', 'runs', 'registry', 'skills', 'docs'];
}

/**
 * Which views may be ACTIVE, which is not the same question as which get a nav
 * tab. Settings is reached from the account menu and deliberately has no tab —
 * without this distinction the "viewer landed on a view they cannot see" guard
 * in GpuApp would bounce it back to Projects on the very next render.
 *
 * Settings exists only where an account does: the ungated developer path has
 * no principal to configure.
 */
/**
 * How the rail STACKS the views it shows, and therefore which boundary in it
 * means something.
 *
 * It lives beside `visibleViews` rather than in the rail's own module because
 * the order and the grouping are the same fact, and because everything that
 * moves for a route has to read them: the rail draws from here, and so do the
 * camera shot and the cube turn. Importing them from the rail module pulled
 * the whole renderer into the entry chunk, which the build refuses.
 */
export const SIDEBAR_GROUPS: readonly { key: string; views: readonly ViewName[] }[] = [
  { key: 'workspace', views: ['projects', 'runs', 'registry', 'skills', 'docs'] },
  { key: 'operate', views: ['burnin'] },
  { key: 'admin', views: ADMIN_VIEWS },
];

/**
 * How many rail rows separate two destinations, for the motion a route
 * deserves. A destination with no row (Settings, reached from the account
 * menu) is one row away, the shortest move there is.
 */
export function navRowDistance(
  auth: { viewer: { platformAdmin: boolean } } | null,
  from: ViewName,
  to: ViewName
): number {
  const rows = visibleViews(auth);
  const start = rows.indexOf(from);
  const end = rows.indexOf(to);
  return start < 0 || end < 0 ? 1 : Math.abs(end - start);
}

/** The rail group a destination belongs to; ungrouped falls in with workspace. */
export function navRowGroup(view: ViewName): string {
  return SIDEBAR_GROUPS.find((group) => group.views.includes(view))?.key ?? 'workspace';
}

export function isRoutableView(
  view: ViewName,
  auth: { viewer: { platformAdmin: boolean } } | null
): boolean {
  if (view === 'settings') return auth !== null;
  return visibleViews(auth).includes(view);
}

export type InputKind =
  | 'run'
  | 'registry'
  | 'skills'
  | 'displayName'
  | null;

export function nextRunFilters(
  current: EventFilters,
  dimension: 'kind' | 'role' | 'branchId',
  value: string
): EventFilters {
  if (dimension === 'kind') return { ...current, kind: value, role: 'all' };
  if (dimension === 'role') return { ...current, kind: 'llm', role: value };
  return { ...current, branchId: value };
}

/** Re-clicking the active project returns to the complete project list. */
export function projectSelectionAfterActivate(
  currentProjectId: string | null,
  activatedProjectId: string
): string | null {
  return currentProjectId === activatedProjectId ? null : activatedProjectId;
}

/**
 * The project run behind the run the Runs view has selected.
 *
 * TWO IDENTITIES, ONE ROW. The Runs view is keyed by TRACE id — that is what
 * a run row, a burn-in link and a deep link all carry — while a preview is
 * keyed by (project, PROJECT RUN). Only the project's own run list holds both,
 * so this is the join, and it accepts either id because the two surfaces that
 * navigate here disagree about which one they have: the Projects view emits
 * `project.run.<traceId ?? projectRunId>`, falling back for a run whose trace
 * does not exist yet.
 *
 * Null for a run reached from anywhere else. A run with no project run has no
 * preview, and guessing one would offer a control that 404s.
 */
export function previewTargetForRun(
  runs: readonly { readonly projectId: string; readonly projectRunId: string; readonly traceId: string | null }[],
  selectedRunId: string | null,
  index: readonly { readonly id: string; readonly projectId?: string; readonly projectRunId?: string }[] = []
): { readonly projectId: string; readonly projectRunId: string } | null {
  if (!selectedRunId) return null;
  // THE INDEX ENTRY FIRST. It names its own project, so the join needs no
  // selected project and no project-run list — both of which are empty after
  // a reload, or when the viewer arrived through the Runs tab. Measured on a
  // live run: summary card drawn, run `running`, and no Preview control,
  // because nothing in this view knew which project the run belonged to.
  const entry = index.find((candidate) => candidate.id === selectedRunId);
  if (entry?.projectId) {
    return { projectId: entry.projectId, projectRunId: entry.projectRunId ?? entry.id };
  }
  const match = runs.find(
    (run) => run.traceId === selectedRunId || run.projectRunId === selectedRunId
  );
  return match ? { projectId: match.projectId, projectRunId: match.projectRunId } : null;
}

/**
 * Repair a stale selection without turning the first project into an implicit
 * selection. An empty list may be a loading transition, so it preserves the
 * current id until a non-empty response can prove that the project is gone.
 */
export function projectSelectionAfterProjects(
  currentProjectId: string | null,
  projectIds: readonly string[]
): string | null {
  if (currentProjectId === null || projectIds.length === 0) return currentProjectId;
  return projectIds.includes(currentProjectId) ? currentProjectId : projectIds[0]!;
}

export interface GpuUiState {
  view: ViewName;
  /** Pulled-back whole scene, or the navigation focus on the content column. */
  sceneCameraMode: SceneCameraMode;
  locale: Locale;
  selectedRunId: string | null;
  resultRunId: string | null;
  resultActionStatus: 'copied' | 'failed' | null;
  resultDetailsOpen: boolean;
  selectedEventId: string | null;
  selectedAtomName: string | null;
  selectedRegistryId: string | null;
  selectedRegistryAtom: string | null;
  selectedSkill: { l1Name: string; id: string } | null;
  selectedProjectId: string | null;
  projectSection: 'runs' | 'preview' | 'files' | 'result';
  projectMcpCollapsed: boolean;
  assistantOpen: boolean;
  workspaceRunId: string | null;
  githubRecovery: import('./github-access.js').GitHubRecoveryProgress | null;
  workspacePath: string;
  filePreview: FilePreviewTarget | null;
  runFilters: EventFilters;
  branchHeadingExpanded: boolean;
  runSummaryExpanded: boolean;
  runActivityOpen: boolean;
  runActivityFile: string | null;
  runActivityPage: number;
  runActivityExpandedChanges: Record<string, boolean>;
  search: Record<Exclude<InputKind, null>, string>;
  focusedInput: InputKind;
  runPickerScrollY: number;
  runPickerActiveIndex: number;
  burninFamily: string;
  burninOutcome: string;
  burninPreset: string;
  burninPage: number;
  /** Journal filters. Server-side: filtering paged rows would thin the pages. */
  journalSeverity: string;
  journalFamily: string;
  selectedDocsTheme: DocsThemeKey;
  appearanceTheme: AppearanceTheme;
  appearanceTransitionTarget: AppearanceTheme | null;
  themeDropdownOpen: boolean;
  scrollY: Record<ViewName, number>;
  /**
   * Arrival gate. False until Continue (later: login). Not a nav view — the
   * chrome and data views stay behind it so SaaS auth can replace `enter()`.
   */
  entered: boolean;
  /**
   * The visitor's device has only coarse, hover-less pointers — a phone or a
   * tablet. ONE sample of `isHandheldDevice()`, refreshed when its media
   * query changes. Entry requires acknowledging the mobile notice once per
   * session before the ordinary login or product entry.
   */
  handheld: boolean;
  handheldAccepted: boolean;
  acceptHandheld: () => void;
  /** Continue was pressed on a handheld device: the control re-labels and disables. */
  handheldBlocked: boolean;
  /**
   * The account menu behind the header orb. Not a view: it is an overlay drawn
   * above every view, and it closes on navigation so it can never outlive the
   * screen it was opened from.
   */
  accountMenuOpen: boolean;
  /** Endonym picker opened from the compact locale code control. */
  localeMenuOpen: boolean;
  /**
   * The notification tray behind the header bell — the same overlay species as
   * the account menu: never a view, closed by navigation and by its siblings.
   */
  notificationsMenuOpen: boolean;
  /** Floating scene controls, opened from the foot of the admin rail. */
  tuningPanelOpen: boolean;
  /** Monotonic signal consumed by a sent announcement receipt only. */
  announcementResetSignal: number;
  enter: () => void;
  /** Reopen the arrival scene without forgetting that Continue was completed. */
  showWelcome: () => void;
  /** Crystal route: focused content restores overview; overview opens Welcome. */
  activateCrystal: () => void;
  /** Live media-query sample. Becoming handheld throws the visitor back behind the gate. */
  setHandheld: (handheld: boolean) => void;
  /** The handheld gate's only transition; `enter()` takes it on a handheld device. */
  blockHandheld: () => void;
  toggleAccountMenu: () => void;
  closeAccountMenu: () => void;
  toggleThemeDropdown: () => void;
  setAppearanceTheme: (theme: AppearanceTheme) => void;
  commitAppearanceTheme: (theme: AppearanceTheme) => void;
  finishAppearanceTransition: () => void;
  toggleLocaleMenu: () => void;
  closeLocaleMenu: () => void;
  toggleNotificationsMenu: () => void;
  closeNotificationsMenu: () => void;
  toggleTuningPanel: () => void;
  /** User activation of a rail/tab destination; re-activation toggles framing. */
  activateView: (view: ViewName) => void;
  /** Programmatic/cross-view navigation always lands on focused content. */
  setView: (view: ViewName) => void;
  setLocale: (locale: Locale) => void;
  selectRun: (id: string | null) => void;
  selectResult: (id: string | null) => void;
  setResultActionStatus: (status: 'copied' | 'failed' | null) => void;
  toggleResultDetails: () => void;
  selectEvent: (id: string | null) => void;
  selectAtom: (name: string | null) => void;
  selectRegistry: (id: string | null) => void;
  selectRegistryAtom: (name: string | null) => void;
  selectSkill: (selection: { l1Name: string; id: string } | null) => void;
  selectProject: (id: string | null) => void;
  selectProjectSection: (section: GpuUiState['projectSection'], runId?: string | null) => void;
  openWorkspace: (runId: string | null) => void;
  setGitHubRecovery: (value: import('./github-access.js').GitHubRecoveryProgress | null) => void;
  selectWorkspacePath: (path: string) => void;
  previewFile: (file: FilePreviewTarget | null) => void;
  setRunFilters: (filters: EventFilters) => void;
  toggleBranchHeading: () => void;
  toggleRunSummary: () => void;
  showRunActivity: (open: boolean) => void;
  selectActivityFile: (path: string | null) => void;
  pageActivity: (delta: number) => void;
  setActivityChangeExpanded: (id: string, expanded: boolean) => void;
  setSearch: (kind: Exclude<InputKind, null>, value: string) => void;
  setFocusedInput: (kind: InputKind) => void;
  setRunPickerScrollY: (value: number) => void;
  setRunPickerActiveIndex: (value: number) => void;
  setBurninFilter: (kind: 'family' | 'outcome' | 'preset', value: string) => void;
  setBurninPage: (page: number) => void;
  setJournalFilter: (kind: 'severity' | 'family', value: string) => void;
  selectDocsTheme: (theme: DocsThemeKey) => void;
  setScrollY: (view: ViewName, value: number) => void;
}

function initialLocale(): Locale {
  if (typeof location === 'undefined') return 'en';
  const query = new URLSearchParams(location.search).get('lang');
  if (isLocale(query)) return query;
  try {
    if (typeof localStorage === 'undefined') return 'en';
    const saved = localStorage.getItem('atoma.viz.lang');
    return isLocale(saved) ? saved : 'en';
  } catch {
    return 'en';
  }
}

// A visitor who already hit Continue once should not see the arrival gate
// again on the same browser. The gated login screen is unaffected: it
// re-blocks itself the moment whoami resolves to unauthenticated (see the
// gateBlocked effect in GpuApp.tsx), so this flag never bypasses a real login.
function initialEntered(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('atoma.viz.entered') === '1';
  } catch {
    return false;
  }
}

/** Explicit opt-in kept for diagnostics and the real-browser tuning smoke. */
function initialTuningPanelOpen(): boolean {
  if (typeof location === 'undefined') return false;
  const value = new URLSearchParams(location.search).get('atomaTune');
  return value === '1' || value?.trim().toLowerCase() === 'true';
}

function viewChange(
  state: GpuUiState,
  view: ViewName,
  sceneCameraMode: SceneCameraMode
): Pick<
  GpuUiState,
  | 'view'
  | 'resultRunId'
  | 'resultActionStatus'
  | 'resultDetailsOpen'
  | 'sceneCameraMode'
  | 'focusedInput'
  | 'accountMenuOpen'
  | 'localeMenuOpen'
  | 'notificationsMenuOpen'
  | 'announcementResetSignal'
> {
  return {
    view,
    resultRunId: null,
    resultActionStatus: null,
    resultDetailsOpen: false,
    sceneCameraMode,
    focusedInput: null,
    accountMenuOpen: false,
    localeMenuOpen: false,
    notificationsMenuOpen: false,
    announcementResetSignal:
      state.view === 'announce' && view === 'announce'
        ? state.announcementResetSignal + 1
        : state.announcementResetSignal,
  };
}

/** Sampled once at load; GpuApp refreshes the store when the media query flips. */
const HANDHELD_AT_LOAD = isHandheldDevice();
function initialHandheldAccepted(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem('atoma.viz.handheldAccepted') === '1';
  } catch {
    return false;
  }
}

function initialAppearanceTheme(): AppearanceTheme {
  try {
    const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem('atoma.viz.theme');
    return isAppearanceTheme(saved) ? saved : 'nocturne';
  } catch {
    return 'nocturne';
  }
}

export const useGpuStore = create<GpuUiState>()((set, get) => ({
  // The app opens on PROJECTS: it is the authenticated launch surface. Runs
  // is where you go to watch what you started, a second step rather than the
  // arrival. Ungated developer mode gets its no-project-routes empty state.
  view: 'projects',
  sceneCameraMode: 'overview',
  locale: initialLocale(),
  selectedRunId: null,
  selectedEventId: null,
  runActivityOpen: false,
  runActivityFile: null,
  runActivityPage: 0, runActivityExpandedChanges: {},
  resultRunId: null,
  resultActionStatus: null,
  resultDetailsOpen: false,
  selectedAtomName: null,
  selectedRegistryId: null,
  selectedRegistryAtom: null,
  selectedSkill: null,
  selectedProjectId: null,
  projectMcpCollapsed: false,
  assistantOpen: false,
  projectSection: 'runs',
  workspaceRunId: null,
  githubRecovery: null,
  setGitHubRecovery: (githubRecovery) => set({ githubRecovery }),
  workspacePath: '',
  filePreview: null,
  runFilters: { kind: 'all', role: 'all', branchId: 'all' },
  branchHeadingExpanded: true,
  runSummaryExpanded: true,
  search: {
    run: '',
    registry: '',
    skills: '',
    displayName: '',
  },
  focusedInput: null,
  runPickerScrollY: 0,
  runPickerActiveIndex: 0,
  burninFamily: 'all',
  burninOutcome: 'all',
  burninPreset: 'all',
  burninPage: 1,
  journalSeverity: 'all',
  journalFamily: 'all',
  selectedDocsTheme: 'quick',
  appearanceTheme: initialAppearanceTheme(),
  appearanceTransitionTarget: null,
  themeDropdownOpen: false,
  scrollY: {
    projects: 0,
    runs: 0,
    registry: 0,
    skills: 0,
    burnin: 0,
    docs: 0,
    admin: 0,
    journal: 0,
    ledger: 0,
    sentinel: 0,
    announce: 0,
    settings: 0,
  },
  // A handheld browser that once entered on the desktop path — or before
  // this gate existed — must not walk past it on the persisted bit alone.
  entered: HANDHELD_AT_LOAD && !initialHandheldAccepted() ? false : initialEntered(),
  handheld: HANDHELD_AT_LOAD,
  handheldAccepted: initialHandheldAccepted(),
  acceptHandheld: () => {
    try {
      sessionStorage.setItem('atoma.viz.handheldAccepted', '1');
    } catch {
      // Acceptance still works when storage is unavailable.
    }
    set({ handheldAccepted: true, handheldBlocked: false });
  },
  handheldBlocked: false,
  accountMenuOpen: false,
  localeMenuOpen: false,
  notificationsMenuOpen: false,
  tuningPanelOpen: initialTuningPanelOpen(),
  announcementResetSignal: 0,
  enter: () => {
    // Show the mobile disclaimer until the visitor explicitly accepts it.
    if (get().handheld && !get().handheldAccepted) {
      set({ handheldBlocked: true });
      return;
    }
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('atoma.viz.entered', '1');
      }
    } catch {
      // Local storage is optional.
    }
    set({ entered: true });
  },
  // This is an explicit in-app route, not a first-visit reset. Keep the
  // persisted admission bit at `1`, so a later reload still opens the product
  // directly instead of trapping a returning viewer on Welcome again.
  showWelcome: () => set({
    entered: false,
    accountMenuOpen: false,
    localeMenuOpen: false,
    notificationsMenuOpen: false,
  }),
  activateCrystal: () => set((state) => state.sceneCameraMode === 'focus'
    ? viewChange(state, state.view, 'overview')
    : {
        entered: false,
        accountMenuOpen: false,
        localeMenuOpen: false,
        notificationsMenuOpen: false,
      }),
  setHandheld: (handheld) => set(handheld && !get().handheldAccepted ? { handheld: true, entered: false } : { handheld }),
  blockHandheld: () => set({ handheldBlocked: true }),
  // The three chrome menus are exclusive: opening one closes the others, so
  // two overlays can never contest the same corner of the header.
  toggleAccountMenu: () => set((state) => ({
    accountMenuOpen: !state.accountMenuOpen,
    themeDropdownOpen: false,
    localeMenuOpen: false,
    notificationsMenuOpen: false,
  })),
  closeAccountMenu: () => set({ accountMenuOpen: false, themeDropdownOpen: false }),
  toggleThemeDropdown: () => set((state) => ({
    accountMenuOpen: true,
    themeDropdownOpen: !state.themeDropdownOpen,
    localeMenuOpen: false,
    notificationsMenuOpen: false,
  })),
  setAppearanceTheme: (appearanceTheme) => {
    const state = get();
    if (state.appearanceTransitionTarget !== null) {
      set({ accountMenuOpen: false, themeDropdownOpen: false });
      return;
    }
    if (appearanceTheme === state.appearanceTheme && state.appearanceTransitionTarget === null) {
      set({ accountMenuOpen: false, themeDropdownOpen: false });
      return;
    }
    if (!state.entered || prefersReducedMotion()) {
      get().commitAppearanceTheme(appearanceTheme);
      set({ appearanceTransitionTarget: null });
      return;
    }
    set({ appearanceTransitionTarget: appearanceTheme, accountMenuOpen: false, themeDropdownOpen: false });
  },
  commitAppearanceTheme: (appearanceTheme) => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('atoma.viz.theme', appearanceTheme);
    } catch {
      // Theme selection remains available when storage is blocked.
    }
    set({ appearanceTheme, accountMenuOpen: false, themeDropdownOpen: false });
  },
  finishAppearanceTransition: () => set({ appearanceTransitionTarget: null }),
  toggleLocaleMenu: () => set((state) => ({
    localeMenuOpen: !state.localeMenuOpen,
    accountMenuOpen: false,
    notificationsMenuOpen: false,
  })),
  closeLocaleMenu: () => set({ localeMenuOpen: false }),
  toggleNotificationsMenu: () => set((state) => ({
    notificationsMenuOpen: !state.notificationsMenuOpen,
    accountMenuOpen: false,
    localeMenuOpen: false,
  })),
  closeNotificationsMenu: () => set({ notificationsMenuOpen: false }),
  toggleTuningPanel: () => set((state) => ({ tuningPanelOpen: !state.tuningPanelOpen })),
  // Navigation closes the menu: an overlay anchored to the account control must not
  // survive the screen it was opened from. Re-activating Announcements also
  // acknowledges its sent receipt; the form decides whether it is currently
  // safe to consume that signal, so an in-progress draft remains untouched.
  activateView: (view) =>
    set((state) => viewChange(
      state,
      view,
      // Arrival is the establishing overview. Any destination advances the
      // camera to its content column; re-activating that same destination is
      // the reversible route back to the whole-scene composition.
      state.view === view && state.sceneCameraMode === 'focus'
        ? 'overview'
        : 'focus'
    )),
  setView: (view) =>
    set((state) => viewChange(
      state,
      view,
      // Cross-links and account routes are navigation, not menu toggles.
      // Even an idempotent route setter keeps its destination in focus.
      'focus'
    )),
  setLocale: (locale) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('atoma.viz.lang', locale);
      }
    } catch {
      // Local storage is optional.
    }
    // ONE writer for lang, dir and the tab title — it guards `document` itself,
    // because this store is imported where there is none.
    applyDocumentLocale(locale);
    set({ locale, localeMenuOpen: false });
  },
  selectRun: (selectedRunId) =>
    set({
      selectedRunId,
      runActivityOpen: false,
      runActivityFile: null,
      runActivityPage: 0, runActivityExpandedChanges: {},
      resultRunId: null,
      resultActionStatus: null,
      resultDetailsOpen: false,
      selectedEventId: null,
      selectedAtomName: null,
      runPickerScrollY: 0,
      runPickerActiveIndex: 0,
      runSummaryExpanded: true,
    }),
  selectEvent: (selectedEventId) =>
    set({
      selectedEventId,
      runActivityOpen: false,
      resultRunId: null,
      selectedAtomName: null,
      runSummaryExpanded: selectedEventId === null,
    }),
  selectAtom: (selectedAtomName) =>
    set({
      selectedAtomName,
      selectedEventId: null,
      runSummaryExpanded: selectedAtomName === null,
    }),
  selectRegistry: (selectedRegistryId) =>
    set({ selectedRegistryId, selectedRegistryAtom: null }),
  selectRegistryAtom: (selectedRegistryAtom) => set({ selectedRegistryAtom }),
  selectSkill: (selectedSkill) => set({ selectedSkill }),
  selectProject: (selectedProjectId) => set((state) => ({
    selectedProjectId,
    assistantOpen: false,
    projectSection: 'runs',
    workspaceRunId: null, workspacePath: '',
    resultRunId: null,
    resultActionStatus: null,
    resultDetailsOpen: false,
    // A selected project can expand with run history. Changing selection
    // while retaining that scroll can place the shorter list
    // entirely above its pane until another wheel event clamps it.
    scrollY: { ...state.scrollY, projects: 0 },
  })),
  selectProjectSection: (projectSection, runId = null) => set(state => ({
    projectSection,
    workspaceRunId: projectSection === 'files' ? runId : null,
    workspacePath: '',
    resultRunId: projectSection === 'result' ? runId : null,
    resultActionStatus: null,
    resultDetailsOpen: false,
    scrollY: { ...state.scrollY, projects: 0 },
  })),
  openWorkspace: (workspaceRunId) => set(state => ({
    projectSection: workspaceRunId ? 'files' : 'runs',
    workspaceRunId, workspacePath: '', scrollY: { ...state.scrollY, projects: 0 },
  })),
  previewFile: (filePreview) => set({ filePreview }),
  selectWorkspacePath: (workspacePath) => set(state => ({ workspacePath, scrollY: { ...state.scrollY, projects: 0 } })),
  showRunActivity: (open) => set({ runActivityOpen: open, runActivityFile: null, runActivityPage: 0, runActivityExpandedChanges: {}, resultRunId: null }),
  selectActivityFile: (path) => set({ runActivityFile: path, runActivityPage: 0 }),
  pageActivity: (delta) => set(state => ({ runActivityPage: Math.max(0, state.runActivityPage + delta), runActivityExpandedChanges: {} })),
  setActivityChangeExpanded: (id, expanded) => set(state => ({
    runActivityExpandedChanges: { ...state.runActivityExpandedChanges, [id]: expanded },
  })),
  selectResult: (resultRunId) => set({ resultRunId, resultActionStatus: null, resultDetailsOpen: false, runActivityOpen: false }),
  setResultActionStatus: (resultActionStatus) => set({ resultActionStatus }),
  toggleResultDetails: () => set(state => ({ resultDetailsOpen: !state.resultDetailsOpen })),
  setRunFilters: (runFilters) =>
    set((state) => ({
      runFilters,
      branchHeadingExpanded:
        runFilters.branchId !== state.runFilters.branchId
          ? true
          : state.branchHeadingExpanded,
      // One notification: Pixi pointertap is not a React event, so a follow-up
      // setScrollY would remount the GPU scene and kill the role-row dissolve.
      scrollY: state.scrollY.runs === 0 ? state.scrollY : { ...state.scrollY, runs: 0 },
    })),
  toggleBranchHeading: () =>
    set((state) => ({ branchHeadingExpanded: !state.branchHeadingExpanded })),
  toggleRunSummary: () =>
    set((state) => ({ runSummaryExpanded: !state.runSummaryExpanded })),
  setSearch: (kind, value) =>
    set((state) => ({ search: { ...state.search, [kind]: value } })),
  setFocusedInput: (focusedInput) => set({ focusedInput }),
  setRunPickerScrollY: (runPickerScrollY) =>
    set({ runPickerScrollY: Math.max(0, runPickerScrollY) }),
  setRunPickerActiveIndex: (runPickerActiveIndex) =>
    set({ runPickerActiveIndex: Math.max(0, runPickerActiveIndex) }),
  setBurninFilter: (kind, value) =>
    set({
      [kind === 'family'
        ? 'burninFamily'
        : kind === 'outcome'
          ? 'burninOutcome'
          : 'burninPreset']: value,
      burninPage: 1,
    } as Partial<GpuUiState>),
  setBurninPage: (burninPage) => set({ burninPage }),
  // A changed filter is a different query, so the old scroll position points
  // into rows that are no longer there: back to the top with it.
  setJournalFilter: (kind, value) =>
    set((state) => ({
      ...(kind === 'severity' ? { journalSeverity: value } : { journalFamily: value }),
      scrollY: { ...state.scrollY, journal: 0 },
    })),
  // A topic is a different document. Keeping the previous topic's scroll
  // offset can open the next one halfway down — or below its entire body.
  selectDocsTheme: (selectedDocsTheme) =>
    set((state) => ({
      selectedDocsTheme,
      scrollY: { ...state.scrollY, docs: 0 },
    })),
  setScrollY: (view, value) =>
    set((state) => {
      const next = Math.max(0, value);
      if (state.scrollY[view] === next) return state;
      return { scrollY: { ...state.scrollY, [view]: next } };
    }),
}));
