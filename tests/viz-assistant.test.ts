// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { timestampTooltip } from '../src/viz/client-gl/renderer/relative-time.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); });
const projectId = 'a660aa4f-4b75-49a8-9454-449b77c06f9d';
const proposalId = '6019a7f7-680f-4725-9a9b-5edca21730eb';
function view(): AssistantView { return { available: true, busy: false, nextBefore: null, choices: [{ id: 'api:openai:small', model: 'api:openai:small', label: 'Small', payer: 'org-key' }], model: 'api:openai:small', run: null, conversation: { ...emptyConversation(), modelChoice: 'api:openai:small' } }; }
function panel(data: AssistantView = view(), scopeKey = 'alice:org-a') {
  vi.spyOn(api, 'assistant').mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const props = { scopeKey, projectId: null, locale: 'en', inert: false,
    externalAgentGuide: createElement('button', { type: 'button' }, 'Connect your agent'),
    t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
    onSettings: vi.fn(), onScopeChange: vi.fn(), onProject: vi.fn(), onRun: vi.fn() };
  const { unmount } = render(createElement(QueryClientProvider, { client }, createElement(AssistantPanel, props)));
  return { client, props, unmount };
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

it('inserts a newline with Shift+Enter and sends the complete draft once with Enter', async () => {
  const data = view();
  let finish!: (result: AssistantView) => void;
  const request = vi.spyOn(api, 'assistantRequest').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  panel(data);
  const input = screen.getByRole('textbox');
  await waitFor(() => expect(input).toBeEnabled());
  const user = userEvent.setup();
  await user.type(input, 'Build a tracker');
  await user.keyboard('{Shift>}{Enter}{/Shift}Add stock alerts');
  expect(input).toHaveValue('Build a tracker\nAdd stock alerts');
  expect(request).not.toHaveBeenCalled();
  await user.keyboard('{Enter}{Enter}');
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message', text: 'Build a tracker\nAdd stock alerts' }));
  expect(input).toBeDisabled();
  expect(input).toHaveValue('');
  expect(input.closest('form')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('status', { name: 'Working…' })).toBeVisible();
  expect(useGpuStore.getState().projectAssistantCompact).toBe(false);
  await act(async () => { finish({ ...data, conversation: { ...data.conversation, version: 1 } }); });
  expect(input).toHaveValue('');
  expect(input).toBeEnabled();
  expect(input.closest('form')).toHaveAttribute('aria-busy', 'false');
  expect(screen.queryByRole('status', { name: 'Working…' })).not.toBeInTheDocument();
});

it('keeps the typing indicator and disabled composer while a server-side reply is pending', async () => {
  const data = { ...view(), busy: true };
  const { client } = panel(data);
  expect(await screen.findByRole('status', { name: 'Working…' })).toBeVisible();
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('textbox').closest('form')).toHaveAttribute('aria-busy', 'true');
  await act(async () => {
    client.setQueryData(['viz', 'assistant', 'alice:org-a', null], { ...data, busy: false,
      conversation: { ...data.conversation, version: 1, messages: [{ role: 'assistant', text: 'Here is the plan.', at: '2026-10-09T10:00:00.000Z' }] } });
  });
  expect(await screen.findByText('Here is the plan.')).toBeVisible();
  expect(screen.queryByRole('status', { name: 'Working…' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox')).toBeEnabled();
});

it('does not send empty or whitespace-only drafts with Enter', async () => {
  const request = vi.spyOn(api, 'assistantRequest').mockResolvedValue(view());
  panel();
  const input = screen.getByRole('textbox');
  await waitFor(() => expect(input).toBeEnabled());
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard('{Enter}   {Shift>}{Enter}{/Shift}{Enter}');
  expect(request).not.toHaveBeenCalled();
  expect(input).toHaveValue('   \n');
});

it.each([
  ['IME composition', { isComposing: true }],
  ['IME composition reported by key code', { keyCode: 229 }],
  ['a held Enter key', { repeat: true }],
] as const)('does not submit while handling %s', async (_label, keyboardState) => {
  const request = vi.spyOn(api, 'assistantRequest').mockResolvedValue(view());
  panel();
  const input = screen.getByRole('textbox');
  await waitFor(() => expect(input).toBeEnabled());
  await userEvent.type(input, 'Keep this draft');
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', ...keyboardState });
  expect(request).not.toHaveBeenCalled();
  expect(input).toHaveValue('Keep this draft');
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

it('formats assistant Markdown while preserving the recorded prose and literal user messages', async () => {
  const data = view();
  const text = ['## Proposed goal', '', '**Stock alerts** with `node --test` and *no dependencies*.', '',
    '- Keep inventory', '- Flag low stock', '', '> Review before starting.', '',
    '3. Verify persistence', '4. Update the README', '', '```js', 'const label = "<stock>";', '```', '',
    '| Check | Result |', '| --- | --- |', '| HTTP | Passed |', '',
    '[Repository](https://example.com/stock "Open repository")'].join('\n');
  data.conversation.messages = [
    { role: 'user', text: '**Keep this literal**', at: '2026-10-08T10:00:00.000Z' },
    { role: 'assistant', text, at: '2026-10-08T10:00:01.000Z' },
  ];
  panel(data);
  const heading = await screen.findByRole('heading', { name: 'Proposed goal', level: 2 });
  expect(heading).toBeVisible();
  expect(screen.getByText('Stock alerts').tagName).toBe('STRONG');
  expect(screen.getByText('no dependencies').tagName).toBe('EM');
  expect(screen.getByText('node --test').tagName).toBe('CODE');
  expect(screen.getByText('Review before starting.').closest('blockquote')).not.toBeNull();
  expect(screen.getAllByRole('listitem')).toHaveLength(4);
  expect(screen.getByText('Verify persistence').closest('ol')).toHaveAttribute('start', '3');
  expect(screen.getByText('const label = "<stock>";').closest('pre')).not.toBeNull();
  expect(within(screen.getByRole('table')).getByRole('cell', { name: 'Passed' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Repository' })).toHaveAttribute('href', 'https://example.com/stock');
  expect(screen.getByText('**Keep this literal**').querySelector('strong')).toBeNull();
  expect(data.conversation.messages[1]?.text).toBe(text);
  await userEvent.type(screen.getByRole('textbox'), 'Keep the selected text');
  expect(screen.getByRole('heading', { name: 'Proposed goal' })).toBe(heading);
});

it('keeps Markdown content inert while allowing explicit web links', async () => {
  const data = view();
  data.conversation.messages = [{ role: 'assistant', at: '2026-10-08T10:00:00.000Z', text: [
    '<img src="https://example.com/raw.png" onerror="steal()">', '',
    '![Tracking image](https://example.com/pixel.png)', '',
    '[Script](javascript:steal) [Data](data:text/html,bad) [Relative](/api/private) [Protocol relative](//example.com)', '',
    '[Safe](https://example.com/docs)',
  ].join('\n') }];
  panel(data);
  const safe = await screen.findByRole('link', { name: 'Safe' });
  expect(safe).toHaveAttribute('target', '_blank');
  expect(safe).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(screen.getByText('<img src="https://example.com/raw.png" onerror="steal()">')).toBeVisible();
  expect(screen.getByText('Tracking image')).toBeVisible();
  expect(document.querySelector('.gpu-assistant-markdown img, .gpu-assistant-markdown [onerror]')).toBeNull();
});

it('renders raw model HTML literally and preserves a failed draft for correction', async () => {
  const data = view();
  data.conversation.messages = [{ role: 'assistant', text: '<script>steal()</script>', at: '2026-10-08T10:00:00.000Z' }];
  let fail!: (error: Error) => void;
  vi.spyOn(api, 'assistantRequest').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  panel(data);
  expect(await screen.findByText('<script>steal()</script>')).toBeVisible();
  expect(document.querySelector('.gpu-assistant script')).toBeNull();
  await userEvent.type(screen.getByRole('textbox'), 'Keep my draft');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('status', { name: 'Working…' })).toBeVisible();
  await act(async () => { fail(new Error('Try again')); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Try again');
  expect(screen.getByRole('textbox')).toHaveValue('Keep my draft');
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.queryByRole('status', { name: 'Working…' })).not.toBeInTheDocument();
});

it('shows refreshing relative message ages with the exact timestamp available on hover', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const at = '2026-10-09T10:00:00.000Z';
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(at) + 30_000);
  const data = view();
  data.conversation.messages = [{ role: 'user', text: 'A recent idea', at }];
  panel(data);
  const stamp = await screen.findByText('a few seconds ago');
  expect(stamp).toHaveAttribute('datetime', at);
  expect(stamp).toHaveAttribute('title', timestampTooltip(at, 'en'));
  now.mockReturnValue(Date.parse(at) + 90_000);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(stamp).toHaveTextContent('a few minutes ago');
});

it('shows run status, opens the existing run view and separates conversation cost', async () => {
  const data = view();
  data.run = { status: 'delivered', costUsd: 0.52, traceId: 'trace-1', error: null };
  data.conversation.lastRun = { projectId, runId: 'run-1' };
  data.conversation.costUsd = 0.0012;
  data.conversation.inputTokens = 900;
  data.conversation.outputTokens = 240;
  const { props } = panel(data);
  expect(await screen.findByText(/Run: delivered/)).toHaveTextContent('$0.52');
  expect(screen.getByText(/Conversation:/)).toHaveTextContent('$0.0012');
  await userEvent.click(screen.getByRole('button', { name: 'Open run' }));
  expect(props.onRun).toHaveBeenCalledWith(data.conversation.lastRun, 'trace-1');
});

it('disables inference on an unconfigured host and fills its host card without a frame of its own', async () => {
  panel({ ...view(), available: false, choices: [], model: null });
  await screen.findByText(/Connect your personal subscription/);
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Assistant model' })).toBeDisabled();
  // Hosted by the project guide (2026-10-09): no title, toggle or close of its own.
  expect(screen.getByRole('region', { name: 'Atoma assistant' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Back to projects' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
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
  const continuation = await screen.findByRole('button', { name: 'Continue in Claude or another agent' });
  const disclosure = screen.getByText('Prefer your own agent? Connect it through MCP').closest('details')!;
  expect(continuation).not.toBeVisible();
  expect(within(disclosure).getByRole('button', { name: 'Connect your agent' })).not.toBeVisible();
  await user.click(within(disclosure).getByText('Prefer your own agent? Connect it through MCP'));
  expect(continuation).toBeVisible();
  expect(useGpuStore.getState().projectAssistantCompact).toBe(true);
  expect(within(disclosure).getByRole('button', { name: 'Connect your agent' })).toBeVisible();
  await user.click(continuation);
  expect(copy).toHaveBeenCalledWith(expect.stringContaining(`conversationId "${proposalId}"`));
  expect(copy.mock.calls[0]![0]).toContain('atoma_conversation_update');
  expect(copy.mock.calls[0]![0]).not.toContain('A private saved detail');
  expect(screen.getByText('Continuation prompt copied')).toBeVisible();
  await user.click(screen.getByText('Back to conversation'));
  expect(useGpuStore.getState().projectAssistantCompact).toBe(false);
});

it('gives the external guide the card and restores the compact empty conversation with its draft', async () => {
  panel();
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  expect(useGpuStore.getState().projectAssistantCompact).toBe(true);
  await userEvent.type(screen.getByRole('textbox'), 'Keep this idea');
  await userEvent.click(screen.getByText('Prefer your own agent? Connect it through MCP'));
  expect(await screen.findByText('Back to conversation')).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connect your agent' })).toBeVisible();
  expect(useGpuStore.getState().projectAssistantCompact).toBe(true);
  await userEvent.click(screen.getByText('Back to conversation'));
  expect(await screen.findByRole('textbox')).toHaveValue('Keep this idea');
  expect(useGpuStore.getState().projectAssistantCompact).toBe(true);
  cleanup();
  expect(useGpuStore.getState().projectAssistantCompact).toBe(false);
});

it('expands the empty card when a shared message arrives', async () => {
  const data = view();
  const { client } = panel(data);
  await waitFor(() => expect(useGpuStore.getState().projectAssistantCompact).toBe(true));
  await act(async () => {
    client.setQueryData(['viz', 'assistant', 'alice:org-a', null], { ...data,
      conversation: { ...data.conversation, version: 1, messages: [
        { role: 'assistant', text: 'A shared update', at: '2026-10-09T10:00:00.000Z' },
      ] } });
  });
  expect(await screen.findByText('A shared update')).toBeVisible();
  expect(useGpuStore.getState().projectAssistantCompact).toBe(false);
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
  expect(screen.getByRole('combobox', { name: 'Assistant model' })).toHaveValue('api:openai:small');
  await userEvent.click(screen.getByRole('button', { name: 'Manage connections' }));
  expect(props.onSettings).toHaveBeenCalledOnce();
});

it('shows the retained model as text and remembers an unsent change after remount', async () => {
  const data = view();
  data.choices.push({ id: 'api:anthropic:fast', model: 'api:anthropic:fast', label: 'Fast', payer: 'org-key' });
  const first = panel(data);
  await userEvent.click(await screen.findByRole('button', { name: 'Change model' }));
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Assistant model' }), 'api:anthropic:fast');
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.getByText('Fast · Your organisation’s API key')).toBeVisible();
  first.unmount();
  const second = panel(data); // Server still has the old model: no message was sent.
  expect(await screen.findByText('Fast · Your organisation’s API key')).toBeVisible();
  expect(screen.getByRole('textbox')).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: 'Change model' }));
  expect(screen.getByRole('combobox')).toHaveValue('api:anthropic:fast');
  await userEvent.click(screen.getByRole('button', { name: 'Keep this model' }));
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  second.unmount();
  const withoutSelection = { ...data, conversation: { ...data.conversation, modelChoice: undefined } };
  const otherOrg = panel(withoutSelection, 'alice:org-b');
  expect(await screen.findByRole('combobox')).toHaveValue('');
  otherOrg.unmount();
  panel(withoutSelection, 'bob:org-a');
  expect(await screen.findByRole('combobox')).toHaveValue('');
});

it('keeps an unavailable remembered model visible without silently choosing another payer', async () => {
  const first = panel();
  await screen.findByRole('button', { name: 'Change model' });
  first.unmount();
  panel({ ...view(), choices: [{ id: 'platform:small', model: 'small', label: 'Platform', payer: 'host-key' }] });
  expect(await screen.findByRole('combobox')).toHaveValue('api:openai:small');
  expect(screen.getByRole('textbox')).toBeDisabled();
});

it('lets the user choose a model when browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  const data = view(); delete data.conversation.modelChoice;
  panel(data);
  await userEvent.selectOptions(await screen.findByRole('combobox'), 'api:openai:small');
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Change model' })).toBeVisible();
});
