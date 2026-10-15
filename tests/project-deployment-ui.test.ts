// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { deploymentCopy, hostingCopy, useProjectDeployment, type DeploymentSettingsView } from '../src/viz/client-gl/project-deployment.js';
import { ProjectSettingsAccessible } from '../src/viz/client-gl/ProjectSettingsAccessible.js';
import type { VizProject } from '../src/viz/client/types.js';

const project: VizProject = { projectId: 'project-1', name: 'Report', slug: 'report', family: '', status: 'active',
  repositoryTarget: { installationId: '1', owner: 'owner', name: 'report', visibility: 'private' },
  repositoryStatus: 'pending', repositoryFullName: null, repositoryUrl: null, repositoryError: null,
  createdAt: '', updatedAt: '', deploymentDestination: 'none' };

function Harness({ canEdit = true, projectId = 'project-1' }: { canEdit?: boolean; projectId?: string }) {
  const query = useQuery<VizProject[]>({ queryKey: ['viz', 'projects'], queryFn: () => [project], enabled: false });
  const deployment = useProjectDeployment(query.data?.find(row => row.projectId === projectId), canEdit);
  return createElement(ProjectSettingsAccessible, { view: deployment.view, t: key => key, onActivate: deployment.activate,
    onRenameAddress: deployment.renameAddress });
}
function mount(canEdit = true) {
  const client = new QueryClient();
  client.setQueryData(['viz', 'projects'], [project, { ...project, projectId: 'project-2' }]);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, ...render(createElement(Harness, { canEdit }), { wrapper }) };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('saves only after explicit confirmation and keeps the server preference visible', async () => {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => new Response('{}', { status: init?.method === 'PUT' ? 200 : 503 }));
  vi.stubGlobal('fetch', fetch);
  const { client } = mount();
  expect(screen.getByRole('radio', { name: 'deployment.none' })).toBeChecked();
  await userEvent.click(screen.getByRole('radio', { name: 'deployment.atoma' }));
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  expect(screen.getByText('deployment.unavailable')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'deployment.save' }));
  await waitFor(() => expect(screen.getByText('deployment.saved')).toHaveAttribute('role', 'status'));
  expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/deployment', expect.objectContaining({
    method: 'PUT', body: '{"destination":"atoma","expectedDestination":"none"}',
  }));
  expect(client.getQueryData<VizProject[]>(['viz', 'projects'])![0]!.deploymentDestination).toBe('atoma');
  // Saved: nothing left to save, so the control is gone rather than greyed out.
  expect(screen.queryByRole('button', { name: 'deployment.save' })).not.toBeInTheDocument();
});

it.each([403, 409, 500])('retains the saved choice on a refused save (%s)', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
  const { client } = mount();
  await userEvent.click(screen.getByRole('radio', { name: 'deployment.external' }));
  await userEvent.click(screen.getByRole('button', { name: 'deployment.save' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(status === 409 ? 'deployment.conflict' : 'deployment.failed'));
  expect(client.getQueryData<VizProject[]>(['viz', 'projects'])![0]!.deploymentDestination).toBe('none');
});

it('discards a draft when switching projects and restricts member controls', async () => {
  const { rerender } = mount();
  await userEvent.click(screen.getByRole('radio', { name: 'deployment.atoma' }));
  rerender(createElement(Harness, { projectId: 'project-2', canEdit: false }));
  expect(screen.getByRole('radio', { name: 'deployment.none' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'deployment.external' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'deployment.save' })).not.toBeInTheDocument();
  expect(screen.getByText('deployment.adminOnly')).toBeInTheDocument();
});

it('renames the hosting address only after an explicit, valid save and says the old one redirects', async () => {
  const summary = { available: true, state: 'ready', deploymentId: null, runId: null, commitSha: null, url: null, error: null,
    address: 'https://report.app.atoma.run/', candidate: null };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'PUT' ? {} : summary), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const { client } = mount();
  client.setQueryData(['viz', 'projects'], [{ ...project, deploymentDestination: 'atoma', hostingSubdomain: 'report' }]);
  await userEvent.click(await screen.findByRole('button', { name: 'hosting.rename' }));
  const input = screen.getByRole('textbox', { name: /hosting.renameLabel/ });
  expect(input).toHaveFocus(); expect(input).toHaveValue('report');
  expect(screen.getByText('hosting.renameRedirect')).toBeInTheDocument();
  await userEvent.clear(input); await userEvent.type(input, 'report 2');
  await userEvent.click(screen.getByRole('button', { name: 'hosting.renameSave' }));
  expect(screen.getByRole('alert')).toHaveTextContent('hosting.rename.invalid');
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  await userEvent.clear(input); await userEvent.type(input, 'Report-Hub');
  await userEvent.click(screen.getByRole('button', { name: 'hosting.renameSave' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/hosting-address', expect.objectContaining({
    method: 'PUT', body: '{"subdomain":"report-hub","expectedSubdomain":"report"}' })));
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
});

it('shows only what applies: no update when the online version is the latest, stop-first only for a newer one', () => {
  const a = 'a'.repeat(40); const b = 'b'.repeat(40);
  const online = { available: true, state: 'ready' as const, deploymentId: '22222222-2222-4222-8222-222222222222', runId: null, commitSha: a,
    url: 'https://attica.app.atoma.run/', error: null, address: 'https://attica.app.atoma.run/', candidate: { runId: '11111111-1111-4111-8111-111111111111', manifestHash: 'f'.repeat(64), commitSha: a } };
  const view = (hosting: DeploymentSettingsView['hosting'], canEdit = true): DeploymentSettingsView =>
    ({ hosting, destination: 'atoma', saved: 'atoma', canEdit, busy: false, status: 'idle' });
  const current = hostingCopy(view(online))!;
  expect(current).toMatchObject({ tone: 'success', version: 'aaaaaaaa', address: 'https://attica.app.atoma.run/', update: null, deploy: null,
    stop: { id: 'hosting.stop', disabled: false } });
  expect(current.actions.map(action => action.id)).toEqual(['hosting.open', 'hosting.rename']);
  expect(hostingCopy(view({ ...online, candidate: { ...online.candidate, commitSha: b } }))).toMatchObject({
    update: 'hosting.update.stopFirst', candidateVersion: 'bbbbbbbb', deploy: { disabled: true } });
  const stopped = hostingCopy(view({ ...online, state: 'stopped', url: null }))!;
  expect(stopped).toMatchObject({ tone: 'muted', update: 'hosting.update.ready', deploy: { disabled: false }, stop: null });
  expect(stopped.actions.map(action => action.id)).toEqual(['hosting.rename']);
  // A legacy deployment still shows where it is served; a member sees no administrative control.
  const member = hostingCopy(view({ ...online, address: null }, false))!;
  expect(member).toMatchObject({ address: 'https://attica.app.atoma.run/', deploy: null, stop: null });
  expect(member.actions.map(action => action.id)).toEqual(['hosting.open']);
  // The destination card never repeats the hosted card's privacy sentence, and has nothing to save once saved.
  expect(deploymentCopy(view(online))).toMatchObject({ notice: null, showSave: false, description: 'deployment.atomaDescription' });
});
