// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantPanel } from '../src/viz/client-gl/AssistantPanel.js';
import { api } from '../src/viz/client/data-api.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { emptyConversation } from '../src/viz/assistantStore.js';
import type { AssistantView } from '../src/contracts/assistant.js';
import { EXAMPLE_ACCOUNT_SUBSCRIPTIONS } from '../src/contracts/accountSubscriptions.js';

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });
const projectId = 'a660aa4f-4b75-49a8-9454-449b77c06f9d';
const proposalId = '6019a7f7-680f-4725-9a9b-5edca21730eb';
function view(): AssistantView { return { available: true, busy: false, nextBefore: null, choices: [{ id: 'api:openai:small', model: 'api:openai:small', label: 'Small', payer: 'org-key' }], model: 'api:openai:small', run: null, conversation: { ...emptyConversation(), modelChoice: 'api:openai:small' } }; }
function panel(data: AssistantView = view()) {
  vi.spyOn(api, 'assistant').mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const props = { scopeKey: 'alice:org-a', projectId: null, locale: 'en', inert: false,
    t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
    projectSelected: false, collapsed: false, onToggle: vi.fn(),
    onSettings: vi.fn(), onScopeChange: vi.fn(), onProject: vi.fn(), onRun: vi.fn() };
  render(createElement(QueryClientProvider, { client }, createElement(AssistantPanel, props)));
  return { client, props };
}

it('sends only the typed message and presents a proposal without executing it', async () => {
  const initial = view();
  const next: AssistantView = { ...initial, conversation: { ...initial.conversation, version: 1,
    messages: [{ role: 'assistant', text: 'Review your new project.', at: '2026-10-08T10:00:00.000Z' }],
    proposal: { id: proposalId, state: 'pending', action: { kind: 'create_project', project: {
      name: 'Stock tracker', slug: 'stock-tracker', initialPrompt: 'Build a stock tracker', followUpstream: false, showcase: 'listed',
      repositoryTarget: { installationId: '123', owner: 'example', name: 'stock-tracker', visibility: 'private' },
    } } } } };
  const request = vi.spyOn(api, 'assistantRequest').mockResolvedValue(next);
  panel(initial);
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  await userEvent.type(screen.getByRole('textbox'), 'Build a stock tracker');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('button', { name: 'Create this project' })).toBeEnabled();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message', version: 0, projectId: null, text: 'Build a stock tracker' }));
  expect(screen.getByText('example/stock-tracker', { exact: false })).toBeVisible();
  expect(screen.getByText('Private')).toBeVisible();
});

it('confirms the displayed proposal id and version without allowing browser-authored actions', async () => {
  const data = view();
  data.conversation.version = 3;
  data.conversation.proposal = { id: proposalId, state: 'pending', action: { kind: 'start_run', projectId,
    goal: 'Add stock alerts', acceptanceCriteria: ['Highlight low stock'] } };
  const done = { ...data, conversation: { ...data.conversation, proposal: null, version: 4 } };
  const request = vi.spyOn(api, 'assistantRequest').mockResolvedValue(done);
  panel(data);
  await userEvent.click(await screen.findByRole('button', { name: 'Approve and start run' }));
  expect(request).toHaveBeenCalledWith({ kind: 'confirm', version: 3, projectId: null, proposalId, requestId: expect.any(String) });
  expect(request).toHaveBeenCalledTimes(1);
});

it('renders model text literally and preserves a failed draft for correction', async () => {
  const data = view();
  data.conversation.messages = [{ role: 'assistant', text: '<script>steal()</script>', at: '2026-10-08T10:00:00.000Z' }];
  vi.spyOn(api, 'assistantRequest').mockRejectedValue(new Error('Try again'));
  panel(data);
  expect(await screen.findByText('<script>steal()</script>')).toBeVisible();
  expect(document.querySelector('.gpu-assistant script')).toBeNull();
  await userEvent.type(screen.getByRole('textbox'), 'Keep my draft');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Try again');
  expect(screen.getByRole('textbox')).toHaveValue('Keep my draft');
});

it('shows run status, opens the existing run view and separates conversation cost', async () => {
  const data = view();
  data.run = { status: 'delivered', costUsd: 0.52, traceId: 'trace-1', error: null };
  data.conversation.lastRun = { projectId, runId: 'run-1' };
  data.conversation.costUsd = 0.0012;
  const { props } = panel(data);
  expect(await screen.findByText(/Run: delivered/)).toHaveTextContent('$0.52');
  expect(screen.getByText(/Conversation:/)).toHaveTextContent('$0.0012');
  await userEvent.click(screen.getByRole('button', { name: 'Open run' }));
  expect(props.onRun).toHaveBeenCalledWith(data.conversation.lastRun, 'trace-1');
});

it('disables inference on an unconfigured host and collapses to its title like the guide', async () => {
  const { props } = panel({ ...view(), available: false, choices: [], model: null });
  await screen.findByText(/Connect your personal subscription/);
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Assistant model' })).toBeDisabled();
  const toggle = screen.getByRole('button', { name: 'Atoma assistant' });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await userEvent.click(toggle);
  expect(props.onToggle).toHaveBeenCalledOnce();
});

// A card in the flow (2026-10-09): collapsed, only the title line remains and
// the runs below move up; the conversation query still runs so expanding is
// instant.
it('renders only its title when collapsed', async () => {
  vi.spyOn(api, 'assistant').mockResolvedValue(view());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const onToggle = vi.fn();
  render(createElement(QueryClientProvider, { client }, createElement(AssistantPanel, {
    scopeKey: 'alice:org-a', projectId, locale: 'en', inert: false, projectSelected: true, collapsed: true, onToggle,
    t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
    onSettings: vi.fn(), onScopeChange: vi.fn(), onProject: vi.fn(), onRun: vi.fn() })));
  const toggle = screen.getByRole('button', { name: 'Atoma assistant' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(document.querySelector('.gpu-assistant')).toHaveClass('gpu-assistant--collapsed', 'gpu-assistant--selected');
  await userEvent.click(toggle);
  expect(onToggle).toHaveBeenCalledOnce();
});

it('explains missing connections and opens the relevant Settings tab directly', async () => {
  const { props } = panel({ ...view(), available: false, choices: [], model: null, subscriptions:
    [EXAMPLE_ACCOUNT_SUBSCRIPTIONS.claude, EXAMPLE_ACCOUNT_SUBSCRIPTIONS.codex].map(status => ({ ...status, state: 'reauth_required' })) });
  expect(await screen.findByText('Claude · Reconnect required')).toBeVisible();
  expect(screen.getByText('ChatGPT · Reconnect required')).toBeVisible();
  expect(screen.getByRole('combobox')).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Reconnect Claude' }));
  expect(props.onSettings).toHaveBeenLastCalledWith('subscriptions');
  await userEvent.click(screen.getByRole('button', { name: 'Reconnect ChatGPT' }));
  expect(props.onSettings).toHaveBeenLastCalledWith('subscriptions');
  await userEvent.click(screen.getByRole('button', { name: 'Manage organisation API keys' }));
  expect(props.onSettings).toHaveBeenLastCalledWith('keys');
});


it('copies a usable continuation prompt for the stable conversation, without copying unrelated history', async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const data = view(); data.conversation.id = proposalId;
  data.conversation.messages = [{ role: 'assistant', text: 'A private saved detail', at: '2026-10-08T10:00:00.000Z' }];
  panel(data);
  await user.click(await screen.findByRole('button', { name: 'Continue in Claude or another agent' }));
  expect(copy).toHaveBeenCalledWith(expect.stringContaining(`conversationId "${proposalId}"`));
  expect(copy.mock.calls[0]![0]).toContain('atoma_conversation_update');
  expect(copy.mock.calls[0]![0]).not.toContain('A private saved detail');
  expect(screen.getByText('Continuation prompt copied')).toBeVisible();
});

it('shows shared attribution and reads older history without executing a proposal', async () => {
  const data = view(); data.conversation.id = proposalId; data.nextBefore = 20;
  data.conversation.messages = [{ id: proposalId, role: 'assistant', origin: 'mcp', clientLabel: 'Claude Code', text: 'Latest shared update', at: '2026-10-08T10:00:00.000Z' }];
  panel(data);
  vi.mocked(api.assistant).mockImplementation(async (_projectId, options) => options?.before ? { ...data, nextBefore: null,
    conversation: { ...data.conversation, messages: [{ role: 'user', text: 'The original brief', at: '2026-10-07T10:00:00.000Z' }] } } : data);
  expect(await screen.findByText('Shared via Claude Code (reported)')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  expect(await screen.findByText('The original brief')).toBeVisible();
  expect(screen.getByText('Latest shared update')).toBeVisible();
  expect(api.assistant).toHaveBeenCalledWith(null, { conversationId: proposalId, before: 20 });
});

it('keeps the conversation open on its project after binding, including an external creation', async () => {
  const data = view(); data.conversation.id = proposalId; data.conversation.projectId = projectId;
  const { props } = panel(data);
  await waitFor(() => expect(props.onScopeChange).toHaveBeenCalledWith(projectId));
});


it('discards an older-page response if another client updated the conversation while it was loading', async () => {
  const initial = view(); initial.conversation.id = proposalId; initial.nextBefore = 20;
  const { client } = panel(initial);
  await screen.findByRole('button', { name: 'Load earlier messages' });
  let finish!: (page: AssistantView) => void;
  const latest = { ...initial, conversation: { ...initial.conversation, version: 2,
    messages: [{ role: 'assistant' as const, text: 'Newly shared update', at: '2026-10-08T10:00:00.000Z' }] } };
  vi.mocked(api.assistant).mockImplementation((_id, options) => options?.before ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(latest));
  await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  await act(async () => {
    client.setQueryData(['viz', 'assistant', 'alice:org-a', null], latest);
    finish({ ...initial, conversation: { ...initial.conversation, messages: [{ role: 'user', text: 'Stale page', at: '2026-10-07T10:00:00.000Z' }] } });
  });
  expect(await screen.findByText('Newly shared update')).toBeVisible();
  expect(screen.queryByText('Stale page')).not.toBeInTheDocument();
});


it('requires a visible model and payer choice and never replaces a revoked choice on refresh', async () => {
  const data = view(); delete data.conversation.modelChoice;
  const request = vi.spyOn(api, 'assistantRequest').mockResolvedValue(data);
  const { client, props } = panel(data);
  const picker = await screen.findByRole('combobox', { name: 'Assistant model' });
  expect(screen.getByRole('textbox')).toBeDisabled();
  await userEvent.selectOptions(picker, 'api:openai:small');
  await userEvent.type(screen.getByRole('textbox'), 'Help with the brief');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ modelChoice: 'api:openai:small' }));
  await act(async () => { client.setQueryData(['viz', 'assistant', 'alice:org-a', null], { ...data,
    choices: [{ id: 'platform:api:openai:small', model: 'api:openai:small', label: 'Platform model', payer: 'host-key' }] }); });
  await waitFor(() => expect(screen.getByRole('textbox')).toBeDisabled());
  expect(picker).toHaveValue('api:openai:small');
  await userEvent.click(screen.getByRole('button', { name: 'Manage connections' }));
  expect(props.onSettings).toHaveBeenCalledOnce();
});
