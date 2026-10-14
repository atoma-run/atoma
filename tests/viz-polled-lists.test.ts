// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpError, api, fetchRevalidatedJson } from '../src/viz/client/data-api.js';
import type { RunIndexEntry } from '../src/viz/client/types.js';
import { useRunsIndex } from '../src/viz/client-gl/queries.js';

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

describe('the runs index poll', () => {
  it('follows live work every 2s and only discovers new runs every 5s otherwise', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const finished: RunIndexEntry = {
      id: 'done', label: 'done', startedAt: new Date(Date.now() - 60_000).toISOString(), hasError: false,
      endedAt: new Date(Date.now() - 30_000).toISOString(),
    };
    let rows: RunIndexEntry[] = [finished];
    const read = vi.spyOn(api, 'runs').mockImplementation(async () => rows);
    renderHook(() => useRunsIndex(true), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children),
    });
    await tick(1);
    expect(read).toHaveBeenCalledTimes(1);

    // A quiet platform: nothing in two seconds, one discovery at five.
    await tick(2_000);
    expect(read).toHaveBeenCalledTimes(1);
    rows = [{ id: 'live', label: 'live', startedAt: new Date().toISOString(), hasError: false, inFlight: true }, finished];
    await tick(3_000);
    expect(read).toHaveBeenCalledTimes(2);

    // Live work is followed at the former cadence.
    await tick(2_000);
    expect(read).toHaveBeenCalledTimes(3);
    await tick(2_000);
    expect(read).toHaveBeenCalledTimes(4);
  });
});

describe('revalidated list reads', () => {
  it('sends the held validator and hands back the same object on 304', async () => {
    const body = [{ id: 'a' }];
    const calls: (string | null)[] = [];
    const responses = [
      new Response(JSON.stringify(body), { status: 200, headers: { etag: 'W/"one"' } }),
      new Response(null, { status: 304, headers: { etag: 'W/"one"' } }),
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
