// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpError, api, fetchRevalidatedJson } from '../src/viz/client/data-api.js';
import type { RunIndexEntry, RunIndexPage } from '../src/viz/client/types.js';
import { mergeRunIndex, useRunsIndex } from '../src/viz/client-gl/queries.js';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const page = (runs: RunIndexEntry[], nextBefore: string | null = null): RunIndexPage =>
  ({ runs, total: runs.length, nextBefore });

function renderRunsIndex(client: QueryClient, initial: { selectedRunId: string | null } = { selectedRunId: null }) {
  return renderHook(({ selectedRunId }: { selectedRunId: string | null }) => useRunsIndex(true, selectedRunId, null), {
    initialProps: initial,
    wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children),
  });
}

function queryClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return client;
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const finished = (id: string, minutesAgo: number, projectId?: string): RunIndexEntry => ({
  id, label: id, startedAt: at(minutesAgo), endedAt: at(minutesAgo - 1), ...(projectId ? { projectId } : {}),
});

describe('the runs index poll', () => {
  it('follows live work every 2s and only discovers new runs every 5s otherwise', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    let rows: RunIndexEntry[] = [finished('done', 2)];
    const read = vi.spyOn(api, 'runsPage').mockImplementation(async () => page(rows));
    renderRunsIndex(queryClient());
    await tick(1);
    expect(read).toHaveBeenCalledTimes(1);

    // A quiet platform: nothing in two seconds, one discovery at five.
    await tick(2_000);
    expect(read).toHaveBeenCalledTimes(1);
    rows = [{ id: 'live', label: 'live', startedAt: new Date().toISOString(), inFlight: true }, ...rows];
    await tick(3_000);
    expect(read).toHaveBeenCalledTimes(2);

    // Live work is followed at the former cadence.
    await tick(2_000);
    expect(read).toHaveBeenCalledTimes(3);
    await tick(2_000);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('pages the platform list and re-polls every loaded page from its cursor', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const calls: (string | null | undefined)[] = [];
    vi.spyOn(api, 'runsPage').mockImplementation(async ({ before }) => {
      calls.push(before);
      return before === 'c1' ? page([finished('older', 30)]) : page([finished('newest', 2)], 'c1');
    });
    const hook = renderRunsIndex(queryClient());
    await tick(1);
    expect(hook.result.current.data?.map((entry) => entry.id)).toEqual(['newest']);
    expect(hook.result.current.hasNextPage).toBe(true);
    await act(async () => { await hook.result.current.fetchNextPage(); });
    await tick(1);
    expect(hook.result.current.data?.map((entry) => entry.id)).toEqual(['newest', 'older']);
    expect(hook.result.current.hasNextPage).toBe(false);
    calls.length = 0;
    await tick(5_000);
    // From the first page, each cursor re-derived from the page before it.
    expect(calls).toEqual([null, 'c1']);
  });

  it('reads the selected run\'s project whole, beside the platform pages', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const projectOnly = finished('project-old', 90, 'p1');
    const read = vi.spyOn(api, 'runsPage').mockImplementation(async ({ projectId }) =>
      projectId === 'p1'
        ? page([finished('p1-new', 3, 'p1'), projectOnly])
        : page([finished('other', 1, 'p2'), finished('p1-new', 3, 'p1')], 'more'));
    const hook = renderRunsIndex(queryClient(), { selectedRunId: 'p1-new' });
    await tick(1);
    await tick(1);
    expect(read).toHaveBeenCalledWith({ limit: 200, projectId: 'p1' });
    expect(hook.result.current.data?.map((entry) => entry.id)).toEqual(['other', 'p1-new', 'project-old']);
  });
});

describe('merging the project list with the pages', () => {
  it('keeps one row per id in the server order, the project copy winning', () => {
    const stale = { ...finished('shared', 5, 'p1'), label: 'stale' };
    const fresh = { ...finished('shared', 5, 'p1'), label: 'fresh' };
    const merged = mergeRunIndex([fresh, finished('p-old', 60, 'p1')], [page([finished('top', 1), stale])]);
    expect(merged?.map((entry) => [entry.id, entry.label])).toEqual([
      ['top', 'top'], ['shared', 'fresh'], ['p-old', 'p-old'],
    ]);
    expect(mergeRunIndex(undefined, undefined)).toBeUndefined();
  });
});

describe('revalidated list reads', () => {
  it('sends the held validator and hands back the same object on 304', async () => {
    const body = [{ id: 'a' }];
    const notModified = new Response(null, { status: 304, headers: { etag: 'W/"one"' } });
    const drained = vi.spyOn(notModified, 'arrayBuffer');
    const calls: (string | null)[] = [];
    const responses = [
      new Response(JSON.stringify(body), { status: 200, headers: { etag: 'W/"one"' } }),
      notModified,
      new Response(JSON.stringify([{ id: 'b' }]), { status: 200 }),
      new Response(JSON.stringify([{ id: 'c' }]), { status: 200 }),
      new Response('{}', { status: 500 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      calls.push(new Headers(init?.headers).get('if-none-match'));
      return responses.shift()!;
    }));

    const first = await fetchRevalidatedJson<{ id: string }[]>('/api/test-list');
    expect(first).toEqual(body);
    const second = await fetchRevalidatedJson<{ id: string }[]>('/api/test-list');
    // Read, not left dangling: an unread 304 is cancelled and logged as aborted.
    expect(drained).toHaveBeenCalledOnce();
    // Identity, not equality: React Query must see unchanged data.
    expect(second).toBe(first);
    // A body without a validator drops the held one; the next read is unconditional.
    expect(await fetchRevalidatedJson('/api/test-list')).toEqual([{ id: 'b' }]);
    expect(await fetchRevalidatedJson('/api/test-list')).toEqual([{ id: 'c' }]);
    await expect(fetchRevalidatedJson('/api/test-list')).rejects.toBeInstanceOf(ApiHttpError);
    expect(calls).toEqual([null, 'W/"one"', 'W/"one"', null, null]);
  });

  it('keeps one validator per path', async () => {
    const calls: [string, string | null][] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push([path, new Headers(init?.headers).get('if-none-match')]);
      return new Response('[]', { status: 200, headers: { etag: `W/"${path}"` } });
    }));
    await fetchRevalidatedJson('/api/projects/one/runs');
    await fetchRevalidatedJson('/api/projects/two/runs');
    await fetchRevalidatedJson('/api/projects/one/runs');
    expect(calls).toEqual([
      ['/api/projects/one/runs', null],
      ['/api/projects/two/runs', null],
      ['/api/projects/one/runs', 'W/"/api/projects/one/runs"'],
    ]);
  });
});
