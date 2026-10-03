import { DOC_THEMES, useGpuStore, type GpuUiState, type ViewName } from './store.js';

/**
 * The browser's Back and Forward buttons, over the store's navigation.
 *
 * The app has no router: where the viewer is lives in the store. This module
 * mirrors that location into the tab's session history — one entry per
 * navigation, the URL left exactly as it is — and puts it back on `popstate`.
 *
 * What counts as WHERE YOU ARE is `NavigationLocation`, and nothing else:
 * scroll offsets, filters, menus, form fields and the selected event inside a
 * run are state you are in, not places you went to. A Back that undid a
 * filter click would be a second undo stack, not navigation.
 *
 * The URL is deliberately unchanged. A path per view would need the server to
 * answer every one of them with the shell, and would put run and project ids
 * in the address bar, the server log and every shared screenshot; a deep link
 * is a separate decision.
 */

const MARKER = 'atoma.viz.navigation';

export interface NavigationLocation {
  readonly view: ViewName;
  readonly sceneCameraMode: GpuUiState['sceneCameraMode'];
  readonly selectedProjectId: string | null;
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
    selectedRunId: id(raw['selectedRunId']),
    selectedRegistryAtom: id(raw['selectedRegistryAtom']),
    selectedSkill: skillName && skillId ? { l1Name: skillName, id: skillId } : null,
    // A theme a later build removed keeps the current one, never a dead key.
    selectedDocsTheme: theme ?? useGpuStore.getState().selectedDocsTheme,
  };
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

  history.replaceState(entryFor(recorded, options.scope, history.state), '');

  const flush = (): void => {
    scheduled = false;
    if (stopped) return;
    const next = navigationLocation(useGpuStore.getState());
    const step = navigationStep(recorded, next);
    if (step === 'none') return;
    recorded = next;
    if (step === 'push') history.pushState(entryFor(next, options.scope, null), '');
    else history.replaceState(entryFor(next, options.scope, history.state), '');
  };

  const unsubscribe = useGpuStore.subscribe(() => {
    if (applying || scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  });

  const onPop = (event: PopStateEvent): void => {
    const location = parseNavigationEntry(event.state, options.scope, options.routable);
    if (!location) {
      // Not ours to open: claim the entry for where the viewer still is, so
      // stepping across it later is coherent instead of a dead stop.
      history.replaceState(entryFor(recorded, options.scope, event.state), '');
      return;
    }
    recorded = location;
    applying = true;
    try {
      // Through the store's own selectors where one exists, so a restored run
      // drops the previous run's selected event exactly as a click would.
      const store = useGpuStore.getState();
      if (store.selectedRunId !== location.selectedRunId) store.selectRun(location.selectedRunId);
      if (store.selectedProjectId !== location.selectedProjectId) store.selectProject(location.selectedProjectId);
      if (store.selectedDocsTheme !== location.selectedDocsTheme) store.selectDocsTheme(location.selectedDocsTheme);
      // The same closing a route does in the store's viewChange: an overlay
      // anchored to the screen being left must not survive it.
      useGpuStore.setState({
        view: location.view,
        sceneCameraMode: location.sceneCameraMode,
        selectedRegistryAtom: location.selectedRegistryAtom,
        selectedSkill: location.selectedSkill,
        resultRunId: null,
        resultActionStatus: null,
        focusedInput: null,
        accountMenuOpen: false,
        localeMenuOpen: false,
        notificationsMenuOpen: false,
      });
    } finally {
      applying = false;
    }
  };

  win.addEventListener('popstate', onPop);
  return () => {
    stopped = true;
    unsubscribe();
    win.removeEventListener('popstate', onPop);
  };
}
