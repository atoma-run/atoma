// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  navigationLocation,
  navigationStep,
  parseNavigationEntry,
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
  history.replaceState(null, '');
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
  it('pushes one entry per navigation and leaves the URL alone', async () => {
    const href = location.href;
    const pushed = start();
    useGpuStore.getState().activateView('runs');
    await settle();
    useGpuStore.getState().activateView('skills');
    await settle();
    expect(pushed()).toBe(2);
    expect(location.href).toBe(href);
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
    await settle();
    const lengthBeforePop = history.length;
    pop(before);
    await settle();
    const state = useGpuStore.getState();
    expect(state.view).toBe('projects');
    expect(state.selectedRunId).toBe('run-a');
    expect(state.selectedEventId).toBeNull();
    expect(state.accountMenuOpen).toBe(false);
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
