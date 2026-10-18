// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { useProjectCompute } from '../src/viz/client-gl/project-compute.js';
import { ProjectSettingsAccessible } from '../src/viz/client-gl/ProjectSettingsAccessible.js';
import type { ComputeProjectView } from '../src/contracts/computeProject.js';
const projectId = 'e5115060-d1a1-46bf-8daa-c22af757f3e8', deviceId = 'cfaec756-b83e-46fc-b787-2128f05ce7b8';
function Harness() {
  const compute = useProjectCompute(projectId, true);
  return createElement(ProjectSettingsAccessible, { view: { destination: 'none', saved: 'none', canEdit: true, busy: false, status: 'idle' },
    compute: compute.view, t: key => key, onActivate: compute.activate });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('requires an explicit project grant, then saves the machine with a stale-target guard', async () => {
  const state: ComputeProjectView = { projectId, hostedAllowed: false, canEdit: true, target: { kind: 'hosted' },
    devices: [{ deviceId, name: 'My computer', allowed: false, revoked: false, availability: 'disconnected' }] };
  const mutations: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init) {
      if (typeof init.body !== 'string') throw new Error('Expected JSON body');
      const body = JSON.parse(init.body) as { target?: ComputeProjectView['target'] };
      mutations.push({ url, body });
      if (url.endsWith('/projects')) state.devices[0]!.allowed = true;
      else if (body.target) state.target = body.target;
      return new Response('{}');
    }
    return new Response(JSON.stringify(state));
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  render(createElement(Harness), { wrapper });
  expect(await screen.findByRole('radio', { name: 'My computer' })).toBeDisabled();
  expect(screen.queryByRole('radio', { name: 'compute.hosted' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'compute.connectComputer' })).toHaveAttribute('href', '/compute/setup');
  expect(screen.getByText(/compute.availability.disconnected/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'compute.allowProject' }));
  await waitFor(() => expect(screen.getByRole('radio', { name: 'My computer' })).toBeEnabled());
  expect(mutations[0]?.body).toEqual({ projectId, allowed: true });
  await userEvent.click(screen.getByRole('radio', { name: 'My computer' }));
  expect(mutations).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'compute.save' }));
  await waitFor(() => expect(mutations).toHaveLength(2));
  expect(mutations[1]?.body).toEqual({ target: { kind: 'customer-device', deviceId }, expected: { kind: 'hosted' } });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'compute.save' })).not.toBeInTheDocument());
  client.clear();
});

it('offers an explicit pending-transfer action to its requester without project admin rights', async () => {
  const runId = '85124e11-3e28-4c96-80f7-dbc13db6b205';
  const state: ComputeProjectView = { projectId, hostedAllowed: true, canEdit: false, target: { kind: 'customer-device', deviceId }, devices: [], pendingRuns: [{ runId }] };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init) { state.pendingRuns = []; return new Response('{}'); }
    return new Response(JSON.stringify(state));
  });
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  render(createElement(Harness), { wrapper });
  await userEvent.click(await screen.findByRole('button', { name: 'compute.finalize' }));
  expect(fetcher).toHaveBeenCalledWith(`/api/compute/runs/${runId}/finalize`, expect.objectContaining({ method: 'POST', body: '{}' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'compute.finalize' })).not.toBeInTheDocument());
  client.clear();
});
it('shows an actionable loading failure instead of silently hiding compute settings', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 500 }))
    .mockResolvedValue(new Response(JSON.stringify({ projectId, hostedAllowed: true, canEdit: false, target: { kind: 'hosted' }, devices: [] })));
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  render(createElement(Harness), { wrapper });
  expect(await screen.findByRole('alert')).toHaveTextContent('compute.loadFailed');
  expect(screen.queryByRole('radio', { name: 'compute.hosted' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'compute.refresh' }));
  expect(await screen.findByRole('radio', { name: 'compute.hosted' })).toBeDisabled();
  client.clear();
});
