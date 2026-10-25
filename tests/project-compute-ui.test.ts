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
import { translate } from '../src/viz/client/i18n-catalog.js';
import { formatDateTime } from '../src/viz/client/date-format.js';
import { computeResultsAttempt } from '../src/viz/client-gl/compute-results.js';
const projectId = 'e5115060-d1a1-46bf-8daa-c22af757f3e8', deviceId = 'cfaec756-b83e-46fc-b787-2128f05ce7b8';
function Harness() {
  const compute = useProjectCompute(projectId, true);
  return createElement(ProjectSettingsAccessible, { view: { destination: 'none', saved: 'none', canEdit: true, busy: false, status: 'idle' },
    compute: compute.view, t: key => key, onActivate: compute.activate });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows pairing when no computer exists and keeps hosted execution available to platform admins', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ projectId, hostedAllowed: true, canEdit: true,
    target: { kind: 'hosted' }, devices: [] }))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  render(createElement(Harness), { wrapper });
  expect(await screen.findByRole('radio', { name: 'compute.hosted' })).toBeEnabled();
  expect(screen.getByRole('link', { name: 'compute.connectComputer' })).toHaveAttribute('href', '/compute/setup');
  expect(screen.queryByText('compute.hostedBeta')).not.toBeInTheDocument();
  client.clear();
});
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
  expect(screen.getByRole('radio', { name: 'compute.hosted' })).toBeDisabled();
  expect(screen.getByText('compute.hostedBeta')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'compute.contact' })).toHaveAttribute('href', 'mailto:mgf@iotanet.net?subject=Atoma%20Compute');
  expect(screen.queryByRole('link', { name: 'compute.connectComputer' })).not.toBeInTheDocument();
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
  expect(await screen.findByText('compute.pending')).toBeInTheDocument();
  // Plain words only: the run is named by the action, never by a truncated id.
  expect(screen.queryByText(new RegExp(runId.slice(0, 8)))).not.toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: 'compute.finalize' }));
  expect(fetcher).toHaveBeenCalledWith(`/api/compute/runs/${runId}/finalize`, expect.objectContaining({ method: 'POST', body: '{}' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'compute.finalize' })).not.toBeInTheDocument());
  expect(screen.getByText('compute.resultsArrived')).toHaveAttribute('role', 'status');
  client.clear();
});
it('says plainly when the results could not be fetched yet', async () => {
  const runId = '85124e11-3e28-4c96-80f7-dbc13db6b205';
  const state: ComputeProjectView = { projectId, hostedAllowed: true, canEdit: false, target: { kind: 'customer-device', deviceId }, devices: [], pendingRuns: [{ runId }] };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init
    ? new Response(JSON.stringify({ error: 'Compute request unavailable or changed; refresh before retrying' }), { status: 409 })
    : new Response(JSON.stringify(state))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  render(createElement(Harness), { wrapper });
  await userEvent.click(await screen.findByRole('button', { name: 'compute.finalize' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('compute.resultsPending');
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
function EnglishHarness() {
  const compute = useProjectCompute(projectId, true);
  return createElement(ProjectSettingsAccessible, { view: { destination: 'none', saved: 'none', canEdit: true, busy: false, status: 'idle' },
    compute: compute.view, t: (key, vars) => translate('en', key, vars), onActivate: compute.activate, locale: 'en' });
}
function renderEnglish(state: ComputeProjectView, mutate: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => init ? mutate(url) : new Response(JSON.stringify(state))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  render(createElement(EnglishHarness), { wrapper });
  return client;
}
it('names each pending run by its title and start, and offers to close one that stopped before it finished', async () => {
  const finished = '85124e11-3e28-4c96-80f7-dbc13db6b205', stopped = '0c1f3a2e-0b7c-4f61-9a55-7d3d8f0c9e11';
  const startedAt = '2026-10-24T09:30:00.000Z';
  const client = renderEnglish({ projectId, hostedAllowed: true, canEdit: false, target: { kind: 'customer-device', deviceId }, devices: [],
    pendingRuns: [{ runId: finished, label: 'Booking page', startedAt, phase: 'finalizing' },
      { runId: stopped, label: 'Price list', startedAt, phase: 'interrupted' }] }, () => new Response('{}'));
  const date = formatDateTime(startedAt, 'en');
  expect(await screen.findByText(translate('en', 'compute.pending', { label: 'Booking page', date }))).toBeInTheDocument();
  expect(screen.getByText(translate('en', 'compute.pendingInterrupted', { label: 'Price list', date }))).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: translate('en', 'compute.finalize') })).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: translate('en', 'compute.close') }));
  expect(await screen.findByText(translate('en', 'compute.runClosed'))).toHaveAttribute('role', 'status');
  expect(fetch).toHaveBeenCalledWith(`/api/compute/runs/${stopped}/finalize`, expect.objectContaining({ method: 'POST' }));
  client.clear();
});
it('says the results are on their way when a transfer is already running, instead of asking to try again', async () => {
  const runId = '85124e11-3e28-4c96-80f7-dbc13db6b205';
  const client = renderEnglish({ projectId, hostedAllowed: true, canEdit: false, target: { kind: 'customer-device', deviceId }, devices: [],
    pendingRuns: [{ runId, label: 'Booking page', startedAt: '2026-10-24T09:30:00.000Z', phase: 'finalizing' }] },
  () => new Response(JSON.stringify({ error: 'Compute results are being transferred', reason: 'active' }), { status: 409 }));
  await userEvent.click(await screen.findByRole('button', { name: translate('en', 'compute.finalize') }));
  expect(await screen.findByText(translate('en', 'compute.resultsGetting'))).toHaveAttribute('role', 'status');
  expect(screen.queryByText(translate('en', 'compute.resultsPending'))).not.toBeInTheDocument();
  client.clear();
});
it('treats a timed-out "Get the results" as still working', () => {
  expect(computeResultsAttempt(new TypeError('Failed to fetch'))).toBe('working');
  expect(computeResultsAttempt({ status: 504 })).toBe('working');
  expect(computeResultsAttempt({ status: 409, reason: 'active' })).toBe('working');
  expect(computeResultsAttempt({ status: 409, reason: 'pending' })).toBe('waiting');
  expect(computeResultsAttempt({ status: 409 })).toBe('waiting');
});
