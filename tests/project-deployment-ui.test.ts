// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { deploymentCopy, hostedUpdateOffer, hostingCopy, parseHostingSummary, useProjectDeployment, versionLineText, versionWords, type DeploymentSettingsView } from '../src/viz/client-gl/project-deployment.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useGpuStore.setState({ hostingConfirm: null }); });
const translateEn = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);

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
    address: 'https://report.app.atoma.run/', candidate: null, version: null, previous: null, updateStops: false, failed: null };
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

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '33333333-3333-4333-8333-333333333333';
const DEPLOYMENT = '22222222-2222-4222-8222-222222222222';
const a = 'a'.repeat(40); const b = 'b'.repeat(40);
type Summary = NonNullable<DeploymentSettingsView['hosting']>;
/** A stateful application online with version A; version B was accepted and published since. */
function summary(overrides: Partial<Summary> = {}): Summary {
  return { available: true, state: 'ready', deploymentId: DEPLOYMENT, runId: RUN_A, commitSha: a,
    url: 'https://attica.app.atoma.run/', error: null, address: 'https://attica.app.atoma.run/',
    version: { runId: RUN_A, commitSha: a, title: 'First control page', acceptedAt: '2026-10-24T09:00:00.000Z' },
    candidate: { runId: RUN_B, commitSha: b, manifestHash: 'f'.repeat(64), title: 'Finish Attica control page repair', acceptedAt: '2026-10-25T09:00:00.000Z' },
    previous: null, updateStops: true, failed: null, ...overrides };
}
const settings = (hosting: DeploymentSettingsView['hosting'], overrides: Partial<DeploymentSettingsView> = {}): DeploymentSettingsView =>
  ({ projectId: 'project-1', hosting, destination: 'atoma', saved: 'atoma', canEdit: true, busy: false, status: 'idle', ...overrides });

it('shows only what applies: nothing to update when the online version is the latest, one update for a newer one', () => {
  const current = hostingCopy(settings(summary({ candidate: { ...summary().candidate!, runId: RUN_A, commitSha: a } })))!;
  expect(current).toMatchObject({ tone: 'success', address: 'https://attica.app.atoma.run/', update: null, primary: null, confirm: null,
    current: { key: 'hosting.version.online', words: { title: 'First control page' }, hash: 'aaaaaaaa' },
    stop: { id: 'hosting.stop', disabled: false } });
  expect(current.actions.map(action => action.id)).toEqual(['hosting.open', 'hosting.rename']);
  expect(hostingCopy(settings(summary()))).toMatchObject({ update: 'hosting.update.available', primary: { id: 'hosting.update', disabled: false },
    target: { key: 'hosting.version.candidate', words: { title: 'Finish Attica control page repair' }, hash: 'bbbbbbbb' }, askAdmin: null });
  // Stopped: putting it online is the existing first deployment, needing no stop.
  const stopped = hostingCopy(settings(summary({ state: 'stopped', url: null, updateStops: false })))!;
  expect(stopped).toMatchObject({ tone: 'muted', update: 'hosting.update.startable', primary: { id: 'hosting.deploy', disabled: false },
    current: { key: 'hosting.version.last' }, stop: null });
  expect(stopped.actions.map(action => action.id)).toEqual(['hosting.rename']);
  // A legacy deployment still shows where it is served; a member is told whom to ask instead of a button.
  const member = hostingCopy(settings(summary({ address: null }), { canEdit: false }))!;
  expect(member).toMatchObject({ address: 'https://attica.app.atoma.run/', primary: null, stop: null, askAdmin: 'hosting.offer.askAdmin' });
  expect(member.actions.map(action => action.id)).toEqual(['hosting.open']);
  // The destination card never repeats the hosted card's privacy sentence, and has nothing to save once saved.
  expect(deploymentCopy(settings(summary()))).toMatchObject({ notice: null, showSave: false, description: 'deployment.atomaDescription' });
});

const UPDATE = { action: 'update' as const, runId: RUN_B, deploymentId: DEPLOYMENT };

it('asks a plain confirmation before an update, worded by whether the site goes down', () => {
  const stateful = hostingCopy(settings(summary(), { confirming: UPDATE }))!;
  expect(stateful.primary).toBeNull(); expect(stateful.stop).toBeNull();
  expect(stateful.confirm).toEqual({ message: 'hosting.confirm.update', actions: [{ id: 'hosting.confirm', disabled: false }, { id: 'hosting.cancel' }] });
  expect(hostingCopy(settings(summary({ updateStops: false }), { confirming: UPDATE }))!.confirm!.message).toBe('hosting.confirm.updateLive');
  // A member never sees a confirmation, even when the store holds one.
  expect(hostingCopy(settings(summary(), { confirming: UPDATE, canEdit: false }))!.confirm).toBeNull();
  // Progress and outcome in plain words.
  expect(hostingCopy(settings(summary(), { hostingBusy: true, hostingBusyAction: 'update' }))).toMatchObject({
    status: 'hosting.progress.stopping', primary: { id: 'hosting.update', disabled: true } });
  expect(hostingCopy(settings(summary({ state: 'starting', url: null }), { hostingAction: 'update' }))!.progress).toBe('hosting.progress.starting');
  expect(hostingCopy(settings(summary({ runId: RUN_B, commitSha: b }), { hostingAction: 'update' }))!.progress).toBe('hosting.outcome.updated');
});

it('says plainly when the new version did not start and offers the previous one back', () => {
  const failed = summary({ state: 'failed', url: null, runId: RUN_B, commitSha: b, error: 'startup-failed', updateStops: false,
    failed: { runId: RUN_B }, version: summary().candidate, previous: { ...summary().version!, manifestHash: 'e'.repeat(64) } });
  const copy = hostingCopy(settings(failed, { hostingAction: 'update' }))!;
  expect(copy).toMatchObject({ tone: 'error', update: 'hosting.outcome.failed', primary: { id: 'hosting.restore' },
    retry: { id: 'hosting.deploy', label: 'hosting.retry' }, target: { key: 'hosting.version.previous', words: { title: 'First control page' } } });
  expect(hostingCopy(settings(failed, { confirming: { action: 'restore', runId: RUN_A, deploymentId: DEPLOYMENT } }))!.confirm!.message).toBe('hosting.confirm.restore');
  expect(hostingCopy(settings(failed, { canEdit: false }))).toMatchObject({ primary: null, retry: null, askAdmin: 'hosting.offer.askAdmin' });
});

it('describes versions in words: the title and when it was accepted, never the hash first', () => {
  const now = new Date('2026-10-25T18:00:00');
  const words = { title: 'Finish Attica control page repair', acceptedAt: new Date('2026-10-25T09:00:00').toISOString() };
  expect(versionWords(words, translateEn, 'en', now)).toBe('Finish Attica control page repair, accepted today');
  expect(versionWords({ ...words, acceptedAt: new Date('2026-10-24T09:00:00').toISOString() }, translateEn, 'en', now))
    .toBe('Finish Attica control page repair, accepted yesterday');
  expect(versionWords({ ...words, acceptedAt: new Date('2026-10-03T09:00:00').toISOString() }, translateEn, 'en', now))
    .toBe('Finish Attica control page repair, accepted on October 3, 2026');
  expect(versionWords({ title: null, acceptedAt: null }, translateEn, 'en', now)).toBe('an earlier version');
  expect(versionLineText({ key: 'hosting.version.online', words, hash: 'aaaaaaaa' }, translateEn, 'en', now))
    .toBe('Online: Finish Attica control page repair, accepted today');
});

it('updates from the accessible twin only after an explicit Confirm, then shows its progress', async () => {
  let current = summary();
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { current = summary({ state: 'starting', url: null }); return new Response('{}', { status: 202 }); }
    return new Response(JSON.stringify(current), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  const { client } = mount();
  client.setQueryData(['viz', 'projects'], [{ ...project, deploymentDestination: 'atoma', hostingSubdomain: 'attica' }]);
  const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  const update = await screen.findByRole('button', { name: 'hosting.update' });
  // The versions lead in words; their hashes sit only inside the technical details.
  expect(screen.getAllByText(/^hosting\.version\.(online|candidate)$/)).toHaveLength(2);
  for (const paragraph of screen.getAllByText(/hosting\.version\./)) expect(paragraph.textContent).not.toMatch(/aaaaaaaa|bbbbbbbb/);
  expect(screen.getAllByText('hosting.versionDetails').map(summary => summary.tagName)).toEqual(['SUMMARY', 'SUMMARY']);
  await userEvent.click(update);
  expect(screen.getByText('hosting.confirm.update')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'hosting.update' })).not.toBeInTheDocument();
  expect(posts()).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: 'hosting.cancel' }));
  expect(screen.queryByText('hosting.confirm.update')).not.toBeInTheDocument();
  expect(posts()).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: 'hosting.update' }));
  await userEvent.click(screen.getByRole('button', { name: 'hosting.confirm' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]).toEqual(['/api/projects/project-1/hosting/update', expect.objectContaining({
    body: JSON.stringify({ runId: RUN_B, manifestHash: 'f'.repeat(64), expectedDeploymentId: DEPLOYMENT }) })]);
  await waitFor(() => expect(screen.getAllByText('hosting.progress.starting').length).toBeGreaterThan(0));
  expect(screen.queryByText('hosting.confirm.update')).not.toBeInTheDocument();
});

const RUN_C = '44444444-4444-4444-8444-444444444444';
const c = 'c'.repeat(40);
/** Version C was accepted after the person asked to update to B. */
const newerThanAsked = () => summary({ candidate: { ...summary().candidate!, runId: RUN_C, commitSha: c, manifestHash: 'd'.repeat(64) } });

it('drops a confirmation the status no longer matches: another accepted version, or another deployment', () => {
  const moved = hostingCopy(settings(newerThanAsked(), { confirming: UPDATE }))!;
  expect(moved.confirm).toBeNull();
  expect(moved.primary).toMatchObject({ id: 'hosting.update' });
  expect(hostingCopy(settings(summary({ deploymentId: '55555555-5555-4555-8555-555555555555' }), { confirming: UPDATE }))!.confirm).toBeNull();
  // The run card and the result page read the same rule.
  expect(hostedUpdateOffer(settings(newerThanAsked(), { confirming: UPDATE }), { projectId: 'project-1', projectRunId: RUN_C }))
    .toMatchObject({ confirm: null, actions: [{ id: 'hosting.update' }] });
});

it('records what a confirmation names, drops it when the status moves, and posts only the recorded version', async () => {
  let current = summary();
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST'
    ? new Response('{}', { status: 202 }) : new Response(JSON.stringify(current), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const { client } = mount();
  client.setQueryData(['viz', 'projects'], [{ ...project, deploymentDestination: 'atoma', hostingSubdomain: 'attica' }]);
  const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  await userEvent.click(await screen.findByRole('button', { name: 'hosting.update' }));
  expect(useGpuStore.getState().hostingConfirm).toEqual({ projectId: 'project-1', action: 'update', runId: RUN_B, deploymentId: DEPLOYMENT });
  current = newerThanAsked();
  await client.refetchQueries({ queryKey: ['hosting', 'project-1'] });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'hosting.confirm' })).not.toBeInTheDocument());
  expect(useGpuStore.getState().hostingConfirm).toBeNull();
  expect(posts()).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: 'hosting.update' }));
  await userEvent.click(screen.getByRole('button', { name: 'hosting.confirm' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]![1]!.body).toBe(JSON.stringify({ runId: RUN_C, manifestHash: 'd'.repeat(64), expectedDeploymentId: DEPLOYMENT }));
});

it('drops a pending confirmation when the person leaves the screen that asked for it', () => {
  const pending = { projectId: 'project-1', action: 'update' as const, runId: RUN_B, deploymentId: DEPLOYMENT };
  const leaves: Array<() => void> = [
    () => useGpuStore.getState().selectProjectSection('runs'),
    () => useGpuStore.getState().selectProject('project-2'),
    () => useGpuStore.getState().setView('settings'),
    () => useGpuStore.getState().selectResult('another-run'),
    () => useGpuStore.getState().openWorkspace(null),
  ];
  for (const leave of leaves) {
    useGpuStore.setState({ view: 'projects', resultRunId: null, hostingConfirm: pending });
    leave();
    expect(useGpuStore.getState().hostingConfirm).toBeNull();
  }
  // Re-asserting the screen already shown is not leaving it.
  useGpuStore.setState({ view: 'projects', hostingConfirm: pending });
  useGpuStore.getState().setView('projects');
  expect(useGpuStore.getState().hostingConfirm).toEqual(pending);
});

it('keeps a failed newer version explained beside the version still online, and after a reload', () => {
  // A replacement that did not start beside the version still serving: the
  // newest deployment failed, the ready one is still online.
  const failedBeside = summary({ state: 'failed', error: 'startup-failed', updateStops: false, failed: { runId: RUN_B } });
  const copy = hostingCopy(settings(failedBeside))!;
  expect(copy).toMatchObject({ status: 'hosting.ready', tone: 'warning', update: 'hosting.outcome.failedOnline',
    current: { key: 'hosting.version.online' }, primary: { id: 'hosting.update', label: 'hosting.retry' } });
  expect(copy.actions.map(action => action.id)).toContain('hosting.open');
  const run = { projectId: 'project-1', projectRunId: RUN_B };
  // No action from this tab (a reload): the run's own failure is still said.
  expect(hostedUpdateOffer(settings(failedBeside), run)).toMatchObject({ lead: 'hosting.outcome.failedOnline',
    actions: [{ id: 'hosting.update', label: 'hosting.retry' }] });
  // Off line after the update stopped the old version, with nothing to put back.
  const failedAlone = summary({ state: 'failed', url: null, runId: RUN_B, commitSha: b, error: 'startup-failed', failed: { runId: RUN_B }, version: summary().candidate });
  expect(hostedUpdateOffer(settings(failedAlone), run)).toMatchObject({ lead: 'hosting.outcome.failed',
    actions: [{ id: 'hosting.update', label: 'hosting.retry' }] });
  // Another run's page says nothing about it.
  expect(hostedUpdateOffer(settings(failedAlone), { projectId: 'project-1', projectRunId: RUN_A })).toBeNull();
});

it('never calls a newer accepted version failed because an older attempt failed beside a static version still online', () => {
  // Static: version A online, an attempt with version C failed beside it,
  // then version B was accepted. B was never tried: it is simply newer.
  const RUN_C = '44444444-4444-4444-8444-444444444444';
  const olderFailed = summary({ state: 'failed', error: 'startup-failed', updateStops: false, failed: { runId: RUN_C } });
  const copy = hostingCopy(settings(olderFailed))!;
  expect(copy).toMatchObject({ candidateFailed: false, status: 'hosting.ready', tone: 'success', update: 'hosting.update.available',
    primary: { id: 'hosting.update' } });
  expect(copy.primary).not.toHaveProperty('label');
  expect(hostedUpdateOffer(settings(olderFailed), { projectId: 'project-1', projectRunId: RUN_B }))
    .toMatchObject({ lead: 'hosting.offer.outdated', actions: [{ id: 'hosting.update' }] });
});

it('reads a hosting status from a newer server that added a field, and still refuses a malformed one (2026-10-26)', () => {
  const summary = { available: true, state: 'ready', deploymentId: null, runId: null, commitSha: null, url: null, error: null, address: null,
    candidate: null, version: null, previous: null, updateStops: false, failed: null };
  expect(parseHostingSummary({ ...summary, laterField: { any: 'shape' } })).toEqual(summary);
  expect(() => parseHostingSummary({ ...summary, state: 'exploded' })).toThrow();
  // A history entry with a later field is read; one this tab cannot word is skipped; a longer history is kept.
  const entry = { deploymentId: '2d8f4b6a-3c4d-4e5f-8a0b-2c3d4e5f6a70', runId: '0b6d2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', title: 'v2', traceId: null,
    createdAt: '2026-10-26T10:23:00.000Z', replaced: false, outcome: 'online', keptOnline: false };
  const read = parseHostingSummary({ ...summary, history: [{ ...entry, laterField: 1 }, { ...entry, outcome: 'hibernating' }, ...Array(30).fill(entry)] });
  expect(read.history).toHaveLength(31);
  expect(read.history![0]).toEqual(entry);
});
