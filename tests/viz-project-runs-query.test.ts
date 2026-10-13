// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/viz/client/data-api.js';
import type { VizProjectRun } from '../src/viz/client/types.js';
import { useProjectRuns } from '../src/viz/client-gl/queries.js';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const completed: VizProjectRun = {
  projectRunId: 'old-run', projectId: 'project', goal: 'Existing delivery', status: 'delivered',
  traceId: 'old-trace', costUsd: 1, durationS: 60, error: null, publication: null,
  createdAt: '2026-10-13T10:00:00.000Z', endedAt: '2026-10-13T10:01:00.000Z',
};

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

it.each([false, true])('discovers external runs in an idle project (has history: %s)', async hasHistory => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const history = hasHistory ? [completed] : [];
  let rows = history;
  const read = vi.spyOn(api, 'projectRuns').mockImplementation(async () => rows);
  const hook = renderHook<ReturnType<typeof useProjectRuns>, { active: boolean; projectId: string | null }>(
    ({ active, projectId }) => useProjectRuns(projectId, active), {
    initialProps: { active: true, projectId: 'project' },
    wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children),
  });
  await tick(1);
  expect(hook.result.current.data).toEqual(history);

  // Only the server changes: no local mutation, invalidation, navigation or focus event.
  const external: VizProjectRun = { ...completed, projectRunId: 'external-run', status: 'queued', endedAt: null };
  rows = [external, ...history];
  await tick(5_000);
  expect(hook.result.current.data?.[0]).toEqual(external);
  rows = [{ ...external, status: 'running' }, ...history];
  await tick(2_000);
  expect(hook.result.current.data?.[0]?.status).toBe('running');
  rows = [{ ...external, status: 'delivered', endedAt: completed.endedAt }, ...history];
  await tick(2_000);
  expect(hook.result.current.data?.[0]?.status).toBe('delivered');
  const afterCompletion = read.mock.calls.length;
  await tick(2_000);
  expect(read).toHaveBeenCalledTimes(afterCompletion);
  await tick(3_000);
  expect(read).toHaveBeenCalledTimes(afterCompletion + 1);

  focusManager.setFocused(false);
  await tick(10_000);
  expect(read).toHaveBeenCalledTimes(afterCompletion + 1);
  hook.rerender({ active: false, projectId: 'project' });
  focusManager.setFocused(true);
  await tick(10_000);
  expect(read).toHaveBeenCalledTimes(afterCompletion + 1);
  hook.rerender({ active: true, projectId: null });
  await tick(10_000);
  expect(read).toHaveBeenCalledTimes(afterCompletion + 1);
});
