import { DOC_THEMES, SIDEBAR_GROUPS, useGpuStore, type GpuUiState, type ViewName } from './store.js';

/**
 * The browser's Back and Forward buttons, and the address bar, over the
 * store's navigation.
 *
 * The app has no router: where the viewer is lives in the store. This module
 * mirrors that location into the tab's session history — one entry per
 * navigation — and puts it back on `popstate`. The same location is written
 * to the URL FRAGMENT (`#/settings`, `#/runs/<trace id>`), so a reload, a
 * bookmark or a pasted link lands where the viewer was (owner decision
 * 2026-10-15). The fragment, not a path or a query: a fragment never reaches
 * the server, so no route has to answer with the shell and no run or project
 * id enters the server log. The address bar and a shared screenshot do show
 * them; that is what a deep link is.
 *
 * What counts as WHERE YOU ARE is `NavigationLocation`, and nothing else:
 * scroll offsets, filters, menus, form fields and the selected event inside a
 * run are state you are in, not places you went to. A Back that undid a
 * filter click would be a second undo stack, not navigation.
 *
 * The history entry keeps the full location; the fragment keeps what the view
 * is ABOUT — its own subject, never the selections other views hold behind it,
 * and never the camera mode: a link is a destination, so it opens in focus.
 */

const MARKER = 'atoma.viz.navigation';

export interface NavigationLocation {
  readonly view: ViewName;
  readonly sceneCameraMode: GpuUiState['sceneCameraMode'];
  readonly selectedProjectId: string | null;
  readonly projectSection: GpuUiState['projectSection'];
  readonly selectedRunId: string | null;
  readonly selectedRegistryAtom: string | null;
  readonly selectedSkill: { readonly l1Name: string; readonly id: string } | null;
  readonly selectedDocsTheme: GpuUiState['selectedDocsTheme'];
}

export function navigationLocation(state: GpuUiState): NavigationLocation {
  return {
    view: state.view,
    sceneCameraMode: state.sceneCameraMode,
    selectedProjectId: state.selectedProjectId,
    projectSection: state.projectSection,
    selectedRunId: state.selectedRunId,
    selectedRegistryAtom: state.selectedRegistryAtom,
    selectedSkill: state.selectedSkill,
    selectedDocsTheme: state.selectedDocsTheme,
  };
}

const FIELDS = [
  'view',
  'sceneCameraMode',
  'selectedProjectId',
  'projectSection',
  'selectedRunId',
  'selectedRegistryAtom',
  'selectedSkill',
  'selectedDocsTheme',
] as const satisfies readonly (keyof NavigationLocation)[];

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * How a change enters history: `push` for a navigation, `replace` for the app
 * FILLING a default the viewer never chose, `none` for no move at all.
 *
 * GpuApp selects the first run, atom and skill once their lists load; those
 * only ever take a selection from nothing to something, on the view already
 * shown. Pushing them would make Back land on the same screen with nothing
 * selected, then be re-filled at once — a Back button that does nothing.
 */
export function navigationStep(
  from: NavigationLocation,
  to: NavigationLocation
): 'push' | 'replace' | 'none' {
  const changed = FIELDS.filter((field) => !sameValue(from[field], to[field]));
  if (changed.length === 0) return 'none';
  return changed.every((field) => from[field] === null) ? 'replace' : 'push';
}


const HOME: Pick<NavigationLocation, 'view' | 'sceneCameraMode' | 'selectedProjectId'> = {
  view: 'projects',
  sceneCameraMode: 'overview',
  selectedProjectId: null,
};

function segment(value: string | null): string[] {
  return value === null ? [] : [encodeURIComponent(value)];
}

/**
 * The fragment for a location: `#/<view>` followed by the view's own subject.
 * The arrival — Projects in overview with no project open — is the bare URL,
 * so a pasted link to the app and the app itself are the same address.
 */
export function navigationHash(location: NavigationLocation): string {
  if (
    location.view === HOME.view &&
    location.sceneCameraMode === HOME.sceneCameraMode &&
    location.selectedProjectId === HOME.selectedProjectId
  ) {
    return '';
  }
  const subject = ((): string[] => {
    switch (location.view) {
      case 'projects': return location.selectedProjectId
        ? [...segment(location.selectedProjectId), ...(location.projectSection === 'conversation' ? [] : [location.projectSection])]
        : [];
      case 'runs': return segment(location.selectedRunId);
      case 'registry': return segment(location.selectedRegistryAtom);
      case 'skills':
        return location.selectedSkill
          ? [...segment(location.selectedSkill.l1Name), ...segment(location.selectedSkill.id)]
          : [];
      case 'docs': return segment(location.selectedDocsTheme);
      default: return [];
    }
  })();
  return `#/${[location.view, ...subject].join('/')}`;
}

/** Every view that exists, so a fragment naming none of them is refused before `routable` sees it. */
const KNOWN_VIEWS: ReadonlySet<string> = new Set<ViewName>([
  ...SIDEBAR_GROUPS.flatMap((group) => group.views),
  'settings',
]);

function decodedId(value: string | undefined): string | null {
  if (value === undefined || value.length === 0 || value.length > 600) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 200 ? decoded : null;
  } catch {
    return null;
  }
}

const PROJECT_SECTIONS: readonly GpuUiState['projectSection'][] = [
  'conversation', 'runs', 'preview', 'files', 'result', 'settings',
];

function projectSection(value: unknown): GpuUiState['projectSection'] {
  return PROJECT_SECTIONS.find((section) => section === value) ?? 'conversation';
}

/**
 * The location a fragment names, or null when it names none the viewer can
 * open: an empty fragment, a view they do not hold, a half-named skill. A
 * fragment carries no camera mode, so a link opens its view in focus.
 */
export function parseNavigationHash(
  hash: string,
  routable: (view: ViewName) => boolean
): NavigationLocation | null {
  const match = /^#\/([A-Za-z]+)(?:\/(.*))?$/.exec(hash);
  if (!match) return null;
  if (!KNOWN_VIEWS.has(match[1]!)) return null;
  const view = match[1] as ViewName;
  if (!routable(view)) return null;
  const parts = (match[2] ?? '').split('/').filter((part) => part.length > 0);
  const first = decodedId(parts[0]);
  const location: NavigationLocation = {
    view,
    sceneCameraMode: 'focus',
    selectedProjectId: view === 'projects' ? first : null,
    projectSection: view === 'projects' && first ? projectSection(parts[1]) : 'conversation',
    selectedRunId: view === 'runs' ? first : null,
    selectedRegistryAtom: view === 'registry' ? first : null,
    selectedSkill: null,
    selectedDocsTheme: useGpuStore.getState().selectedDocsTheme,
  };
  if (view === 'skills') {
    const id = decodedId(parts[1]);
    return first && id ? { ...location, selectedSkill: { l1Name: first, id } } : location;
  }
  if (view === 'docs') {
    const theme = DOC_THEMES.find((item) => item.key === first)?.key;
    return theme ? { ...location, selectedDocsTheme: theme } : location;
  }
  return location;
}

/**
 * Puts the viewer at a location, through the store's own selectors where one
 * exists, so a restored run drops the previous run's selected event exactly as
 * a click would. Closes what a route closes in the store's viewChange: an
 * overlay anchored to the screen being left must not survive it.
 */
function applyLocation(location: NavigationLocation): void {
  const store = useGpuStore.getState();
  if (store.selectedRunId !== location.selectedRunId) store.selectRun(location.selectedRunId);
  if (store.selectedProjectId !== location.selectedProjectId) store.selectProject(location.selectedProjectId);
  if (useGpuStore.getState().projectSection !== location.projectSection) {
    useGpuStore.getState().selectProjectSection(location.projectSection);
  }
  if (store.selectedDocsTheme !== location.selectedDocsTheme) store.selectDocsTheme(location.selectedDocsTheme);
  useGpuStore.setState({
    view: location.view,
    sceneCameraMode: location.sceneCameraMode,
    selectedRegistryAtom: location.selectedRegistryAtom,
    selectedSkill: location.selectedSkill,
    resultRunId: null,
    resultActionStatus: null,
    filePreview: null,
    focusedInput: null,
    accountMenuOpen: false,
    localeMenuOpen: false,
    notificationsMenuOpen: false,
  });
}

/**
 * Opens the location the page was loaded on, if its fragment names one.
 * Called once, before the recorder starts, so the arrival is the first entry
 * and not a navigation. Returns whether a location was applied.
 */
export function restoreNavigationFromUrl(options: {
  routable: (view: ViewName) => boolean;
  win?: Window;
}): boolean {
  const win = options.win ?? window;
  const location = parseNavigationHash(win.location.hash, options.routable);
  if (!location) return false;
  applyLocation(location);
  return true;
}

/** Reads one of OUR entries back; anything else in history.state is foreign. */
export function parseNavigationEntry(
  value: unknown,
  scope: string,
  routable: (view: ViewName) => boolean
): NavigationLocation | null {
  if (!value || typeof value !== 'object') return null;
  const entry = (value as Record<string, unknown>)[MARKER];
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry as Record<string, unknown>;
  if (raw['scope'] !== scope) return null;
  const id = (item: unknown): string | null =>
    typeof item === 'string' && item.length > 0 && item.length <= 200 ? item : null;
  if (typeof raw['view'] !== 'string' || !routable(raw['view'] as ViewName)) return null;
  const skill = raw['selectedSkill'] as Record<string, unknown> | null | undefined;
  const skillName = skill && typeof skill === 'object' ? id(skill['l1Name']) : null;
  const skillId = skill && typeof skill === 'object' ? id(skill['id']) : null;
  const theme = DOC_THEMES.find((item) => item.key === raw['selectedDocsTheme'])?.key;
  return {
    view: raw['view'] as ViewName,
    sceneCameraMode: raw['sceneCameraMode'] === 'focus' ? 'focus' : 'overview',
    selectedProjectId: id(raw['selectedProjectId']),
    projectSection: projectSection(raw['projectSection']),
    selectedRunId: id(raw['selectedRunId']),
    selectedRegistryAtom: id(raw['selectedRegistryAtom']),
    selectedSkill: skillName && skillId ? { l1Name: skillName, id: skillId } : null,
    // A theme a later build removed keeps the current one, never a dead key.
    selectedDocsTheme: theme ?? useGpuStore.getState().selectedDocsTheme,
  };
}

function urlFor(location: NavigationLocation, win: Window): string {
  return `${win.location.pathname}${win.location.search}${navigationHash(location)}`;
}

function entryFor(location: NavigationLocation, scope: string, previous: unknown): Record<string, unknown> {
  // Keep whatever else lives in history.state; this module owns one key.
  const base = previous && typeof previous === 'object' ? (previous as Record<string, unknown>) : {};
  return { ...base, [MARKER]: { ...location, scope } };
}

/**
 * Starts mirroring. Returns the stop function.
 *
 * Changes are coalesced to one microtask: a cross-link sets the selection and
 * then the view in two store writes, and that is ONE place, not two entries.
 * `routable` is read at pop time, so an entry for a view the viewer has since
 * lost (admin revoked) is ignored rather than opened. `scope` is the same
 * principal:organisation key the update restore uses: the history of a tab
 * outlives a sign-out or an organisation switch, and an entry recorded under
 * another one names projects and runs this viewer may not hold.
 */
export function startNavigationHistory(options: {
  scope: string;
  routable: (view: ViewName) => boolean;
  win?: Window;
}): () => void {
  const win = options.win ?? window;
  const history = win.history;
  let recorded = navigationLocation(useGpuStore.getState());
  let applying = false;
  let scheduled = false;
  let stopped = false;

  history.replaceState(entryFor(recorded, options.scope, history.state), '', urlFor(recorded, win));

  const flush = (): void => {
    scheduled = false;
    if (stopped) return;
    const next = navigationLocation(useGpuStore.getState());
    const step = navigationStep(recorded, next);
    if (step === 'none') return;
    recorded = next;
    if (step === 'push') history.pushState(entryFor(next, options.scope, null), '', urlFor(next, win));
    else history.replaceState(entryFor(next, options.scope, history.state), '', urlFor(next, win));
  };

  const unsubscribe = useGpuStore.subscribe(() => {
    if (applying || scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  });

  const onPop = (event: PopStateEvent): void => {
    // Ours first: an entry holds the whole location. A fragment the viewer
    // typed or pasted into the address bar arrives as a pop with no entry of
    // ours, and names a place just as well.
    const location =
      parseNavigationEntry(event.state, options.scope, options.routable) ??
      parseNavigationHash(win.location.hash, options.routable);
    if (!location) {
      // Not ours to open: claim the entry for where the viewer still is, so
      // stepping across it later is coherent instead of a dead stop.
      history.replaceState(entryFor(recorded, options.scope, event.state), '', urlFor(recorded, win));
      return;
    }
    recorded = location;
    applying = true;
    try {
      applyLocation(location);
    } finally {
      applying = false;
    }
    if (!parseNavigationEntry(event.state, options.scope, options.routable)) {
      // A hand-typed fragment becomes a full entry of ours, like any other.
      history.replaceState(entryFor(location, options.scope, event.state), '', urlFor(location, win));
    }
  };

  win.addEventListener('popstate', onPop);
  return () => {
    stopped = true;
    unsubscribe();
    win.removeEventListener('popstate', onPop);
  };
}
