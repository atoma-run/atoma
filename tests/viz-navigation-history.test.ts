// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  navigationHash,
  navigationLocation,
  navigationStep,
  parseNavigationEntry,
  parseNavigationHash,
  restoreNavigationFromUrl,
  startNavigationHistory,
} from '../src/viz/client-gl/navigation-history.js';
import { useGpuStore, type ViewName } from '../src/viz/client-gl/store.js';

const initial = useGpuStore.getState();
const stops: (() => void)[] = [];
const routable = (view: ViewName) => view !== 'admin';
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const pop = (state: unknown) => window.dispatchEvent(new PopStateEvent('popstate', { state }));

beforeEach(() => {
  useGpuStore.setState(initial, true);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function start(scope = 'p:o') {
  const lengthAtStart = history.length;
  stops.push(startNavigationHistory({ scope, routable }));
  return () => history.length - lengthAtStart;
}

describe('browser history over the store navigation', () => {
  it('pushes one entry per navigation and writes the place into the fragment', async () => {
    const pushed = start();
    expect(location.hash).toBe('');
    useGpuStore.getState().activateView('runs');
    await settle();
    expect(location.hash).toBe('#/runs');
    useGpuStore.getState().activateView('settings');
    await settle();
    expect(pushed()).toBe(2);
    expect(location.hash).toBe('#/settings');
    useGpuStore.getState().selectRun('trace 1');
    useGpuStore.getState().setView('runs');
    await settle();
    expect(location.hash).toBe('#/runs/trace%201');
  });

  it('names each view by its own subject, and the arrival by the bare URL', () => {
    const base = navigationLocation(useGpuStore.getState());
    expect(navigationHash(base)).toBe('');
    expect(navigationHash({ ...base, selectedRunId: 'r' })).toBe('');
    expect(navigationHash({ ...base, sceneCameraMode: 'focus' })).toBe('#/projects');
    expect(navigationHash({ ...base, selectedProjectId: 'p/1', sceneCameraMode: 'focus' })).toBe('#/projects/p%2F1');
    expect(navigationHash({ ...base, view: 'settings', selectedRunId: 'r', selectedProjectId: 'p' })).toBe('#/settings');
    expect(navigationHash({ ...base, view: 'registry', selectedRegistryAtom: 'Hydrogen' })).toBe('#/registry/Hydrogen');
    expect(navigationHash({ ...base, view: 'skills', selectedSkill: { l1Name: 'a', id: '1' } })).toBe('#/skills/a/1');
    expect(navigationHash({ ...base, view: 'docs' })).toBe(`#/docs/${base.selectedDocsTheme}`);
  });

  it.each(['conversation', 'runs', 'preview', 'files', 'result', 'settings'] as const)(
    'pushes, reloads and restores the project %s tab', async (section) => {
      useGpuStore.getState().selectProject('project/one');
      const pushed = start();
      const conversationEntry = history.state as unknown;
      useGpuStore.getState().selectProjectSection(section);
      await settle();
      const hash = `#/projects/project%2Fone${section === 'conversation' ? '' : `/${section}`}`;
      expect(location.hash).toBe(hash);
      expect(pushed()).toBe(section === 'conversation' ? 0 : 1);
      const tabEntry = history.state as unknown;
      pop(conversationEntry);
      await settle();
      expect(useGpuStore.getState().projectSection).toBe('conversation');
      pop(tabEntry);
      await settle();
      expect(useGpuStore.getState().projectSection).toBe(section);
      expect(pushed()).toBe(section === 'conversation' ? 0 : 1);
      stops.pop()!();
      useGpuStore.getState().selectProject('another-project');
      history.replaceState(null, '', hash);
      expect(restoreNavigationFromUrl({ routable })).toBe(true);
      expect(useGpuStore.getState()).toMatchObject({
        view: 'projects', selectedProjectId: 'project/one', projectSection: section,
      });
    }
  );

  it('defaults old project links and history entries, and unknown tabs, to the conversation', () => {
    expect(parseNavigationHash('#/projects/p', routable)?.projectSection).toBe('conversation');
    expect(parseNavigationHash('#/projects/p/unknown', routable)?.projectSection).toBe('conversation');
    expect(parseNavigationHash('#/projects/p/%E0%A4%A', routable)?.projectSection).toBe('conversation');
    expect(parseNavigationHash('#/projects', routable)?.projectSection).toBe('conversation');
    expect(parseNavigationEntry({ 'atoma.viz.navigation': {
      view: 'projects', selectedProjectId: 'p', scope: 'p:o',
    } }, 'p:o', routable)?.projectSection).toBe('conversation');
  });

  it('parses a fragment back to a focused location, or to nothing', () => {
    const theme = useGpuStore.getState().selectedDocsTheme;
    expect(parseNavigationHash('', routable)).toBeNull();
    expect(parseNavigationHash('#/', routable)).toBeNull();
    expect(parseNavigationHash('#/nowhere', routable)).toBeNull();
    expect(parseNavigationHash('#/admin', routable)).toBeNull();
    expect(parseNavigationHash('#/settings', routable)).toMatchObject({ view: 'settings', sceneCameraMode: 'focus', selectedRunId: null });
    expect(parseNavigationHash('#/runs/trace%201', routable)).toMatchObject({ view: 'runs', selectedRunId: 'trace 1' });
    expect(parseNavigationHash('#/projects/p%2F1', routable)).toMatchObject({ view: 'projects', selectedProjectId: 'p/1' });
    expect(parseNavigationHash('#/skills/a/1', routable)).toMatchObject({ selectedSkill: { l1Name: 'a', id: '1' } });
    expect(parseNavigationHash('#/skills/a', routable)).toMatchObject({ view: 'skills', selectedSkill: null });
    expect(parseNavigationHash('#/docs/unknown-theme', routable)).toMatchObject({ view: 'docs', selectedDocsTheme: theme });
    expect(parseNavigationHash('#/runs/%E0%A4%A', routable)).toMatchObject({ view: 'runs', selectedRunId: null });
    expect(parseNavigationHash(`#/runs/${'x'.repeat(201)}`, routable)).toMatchObject({ selectedRunId: null });
  });

  it('opens the page where its fragment says, then records that as the first entry', async () => {
    history.replaceState(null, '', '#/settings');
    expect(restoreNavigationFromUrl({ routable })).toBe(true);
    expect(useGpuStore.getState().view).toBe('settings');
    const pushed = start();
    await settle();
    expect(pushed()).toBe(0);
    expect(location.hash).toBe('#/settings');
    expect(parseNavigationEntry(history.state, 'p:o', routable)?.view).toBe('settings');
  });

  it('keeps the arrival when the fragment names a view the viewer cannot open', () => {
    history.replaceState(null, '', '#/admin');
    expect(restoreNavigationFromUrl({ routable })).toBe(false);
    expect(useGpuStore.getState().view).toBe('projects');
  });

  it('follows a fragment typed into the address bar and claims it as an entry', async () => {
    const pushed = start();
    history.pushState(null, '', '#/runs/trace-9');
    pop(null);
    await settle();
    expect(useGpuStore.getState().view).toBe('runs');
    expect(useGpuStore.getState().selectedRunId).toBe('trace-9');
    expect(parseNavigationEntry(history.state, 'p:o', routable)?.selectedRunId).toBe('trace-9');
    expect(pushed()).toBe(1);
  });

  it('coalesces a cross-link that writes selection then view into one entry', async () => {
    const pushed = start();
    useGpuStore.getState().selectRun('run-a');
    useGpuStore.getState().selectRun('run-b');
    useGpuStore.getState().setView('runs');
    await settle();
    expect(pushed()).toBe(1);
  });

  it('records a default the app fills in by replacing, not pushing', async () => {
    const pushed = start();
    useGpuStore.getState().selectRun('first-run');
    await settle();
    expect(pushed()).toBe(0);
    expect(parseNavigationEntry(history.state, 'p:o', routable)?.selectedRunId).toBe('first-run');
  });

  it('ignores state that is not a place: scroll, filters, menus', async () => {
    const pushed = start();
    const store = useGpuStore.getState();
    store.setScrollY('runs', 120);
    store.setRunFilters({ kind: 'llm', role: 'all', branchId: 'all' });
    store.toggleAccountMenu();
    await settle();
    expect(pushed()).toBe(0);
  });

  it('restores the popped location and closes overlays without recording it', async () => {
    start();
    useGpuStore.setState({ selectedRunId: 'run-a' });
    await settle();
    const before = history.state as unknown;
    useGpuStore.getState().selectRun('run-b');
    useGpuStore.getState().setView('runs');
    useGpuStore.getState().selectEvent('event-1');
    useGpuStore.getState().toggleAccountMenu();
    useGpuStore.getState().previewFile({ projectId: 'project-a', runId: 'run-a', path: 'README.md' });
    await settle();
    const lengthBeforePop = history.length;
    pop(before);
    await settle();
    const state = useGpuStore.getState();
    expect(state.view).toBe('projects');
    expect(state.selectedRunId).toBe('run-a');
    expect(state.selectedEventId).toBeNull();
    expect(state.accountMenuOpen).toBe(false);
    expect(state.filePreview).toBeNull();
    expect(history.length).toBe(lengthBeforePop);
  });

  it('refuses entries from another principal or organisation, and unroutable views', async () => {
    start('p:o');
    const foreign = { 'atoma.viz.navigation': { ...navigationLocation(useGpuStore.getState()), view: 'runs', scope: 'p:other' } };
    pop(foreign);
    expect(useGpuStore.getState().view).toBe('projects');
    const lost = { 'atoma.viz.navigation': { ...navigationLocation(useGpuStore.getState()), view: 'admin', scope: 'p:o' } };
    pop(lost);
    expect(useGpuStore.getState().view).toBe('projects');
    expect(parseNavigationEntry({ unrelated: true }, 'p:o', routable)).toBeNull();
  });

  it('classifies steps', () => {
    const base = navigationLocation(useGpuStore.getState());
    expect(navigationStep(base, { ...base })).toBe('none');
    expect(navigationStep(base, { ...base, selectedRunId: 'x' })).toBe('replace');
    expect(navigationStep({ ...base, selectedRunId: 'x' }, { ...base, selectedRunId: 'y' })).toBe('push');
    expect(navigationStep(base, { ...base, view: 'runs', selectedRunId: 'x' })).toBe('push');
    expect(navigationStep(base, { ...base, selectedSkill: { l1Name: 'a', id: '1' } })).toBe('replace');
  });

  it('stops listening when stopped', async () => {
    const pushed = start();
    stops.pop()!();
    useGpuStore.getState().activateView('runs');
    await settle();
    expect(pushed()).toBe(0);
  });
});
