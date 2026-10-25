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
import type { RunReview } from '../src/contracts/clientExperience.js';
import { EXAMPLE_ACCOUNT_SUBSCRIPTIONS } from '../src/contracts/accountSubscriptions.js';
import { timestampTooltip } from '../src/viz/client-gl/renderer/relative-time.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); });
const projectId = 'a660aa4f-4b75-49a8-9454-449b77c06f9d';
const proposalId = '6019a7f7-680f-4725-9a9b-5edca21730eb';
function view(): AssistantView { return { available: true, busy: false, nextBefore: null, choices: [{ id: 'api:openai:small', model: 'api:openai:small', label: 'Small', payer: 'org-key' }], model: 'api:openai:small', run: null, conversation: { ...emptyConversation(), modelChoice: 'api:openai:small' } }; }
function deliveryReview(): RunReview {
  return {
    run: { projectId, projectRunId: 'run-1', goal: 'Build the tracker', status: 'delivered', artifactManifestHash: 'a'.repeat(64) },
    acceptedReferenceRunId: null, delivery: 'files', filesState: 'available',
    files: { projectId, runId: 'run-1', status: 'delivered', files: [{ path: 'index.html', size: 10 }], total: 1, nextOffset: null },
    comparison: null, comparisonState: 'no_recorded_base',
    verification: { stage: 'finished', message: 'Run delivered.', source: 'trace', evidence: 'available',
      lastActivityAt: null, criteria: [], criteriaTruncated: false, acceptanceApproved: true },
    clientAcceptance: null, publicationStatus: null, canRequestAcceptance: true, canRetryPublication: false,
    untrusted: true, bytes: 'not-revalidated', nextSteps: [], note: 'Saved evidence only.',
  };
}
function deliveredView() {
  const data = view();
  data.run = { projectId, runId: 'run-1', status: 'delivered', costUsd: 0.52, traceId: 'trace-1', error: null, endedAt: null };
  data.conversation.lastRun = { projectId, runId: 'run-1' };
  return data;
}
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

it('says a finished Compute run is waiting for its results instead of "in progress"', async () => {
  const data = view();
  data.run = { projectId, runId: 'run-1', status: 'running', costUsd: 0.52, traceId: 'trace-1', error: null, endedAt: null, resultsWaiting: true };
  panel(data);
  expect(await screen.findByText(translate('en', 'assistant.resultsWaiting'))).toBeVisible();
  expect(screen.getByText(translate('en', 'assistant.runStatus', { status: translate('en', 'projects.resultsWaiting.status') }), { exact: false })).toBeVisible();
  expect(screen.queryByText(translate('en', 'assistant.runInProgress'))).not.toBeInTheDocument();
});

it('shows a start refused for results waiting in plain words, never the machine-facing refusal', async () => {
  for (const [reason, key] of [['results-waiting', 'assistant.busyResultsWaiting'], ['others-results-waiting', 'assistant.busyResultsWaitingOther'],
    // Its computer was connected and accepting work (review 2026-10-25): never "open Atoma Compute".
    ['results-stalled', 'assistant.busyResultsStalled'], ['others-results-stalled', 'assistant.busyResultsStalledOther']] as const) {
    const data = view();
    data.conversation.version = 3;
    data.conversation.proposal = { id: proposalId, state: 'pending', action: { kind: 'start_run', projectId,
      goal: 'Add stock alerts', acceptanceCriteria: [] } };
    const machine = 'Organisation concurrent run limit reached: a finished run is waiting (run 85124e11-3e28-4c96-80f7-dbc13db6b205)';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: machine, reason }), { status: 409 }));
    const { unmount } = panel(data);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve and start run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(translate('en', key));
    expect(screen.queryByText(machine, { exact: false })).not.toBeInTheDocument();
    unmount(); vi.restoreAllMocks();
  }
});

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

it('shows the sent message before typing starts and replaces it with the saved copy without duplication', async () => {
  const data = view();
  let finish!: (result: AssistantView) => void;
  const request = vi.spyOn(api, 'assistantRequest').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { client } = panel(data);
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  await userEvent.type(screen.getByRole('textbox'), 'Why did the run fail?');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  const log = screen.getByRole('log');
  expect(within(log).getAllByText('Why did the run fail?')).toHaveLength(1);
  expect(log.firstElementChild).toHaveTextContent('Why did the run fail?');
  expect(log.lastElementChild).toHaveClass('gpu-assistant-typing');
  const requestId = request.mock.calls[0]![0].requestId;
  const saved: AssistantView = { ...data, busy: true, conversation: { ...data.conversation, version: 1, lastRequestId: requestId,
    messages: [{ id: crypto.randomUUID(), role: 'user', origin: 'atoma', text: 'Why did the run fail?', at: new Date().toISOString() }] } };
  await act(async () => { client.setQueryData(['viz', 'assistant', 'alice:org-a', null], saved); });
  expect(within(log).getAllByText('Why did the run fail?')).toHaveLength(1);
  await act(async () => { finish({ ...saved, busy: false }); });
  expect(within(log).getAllByText('Why did the run fail?')).toHaveLength(1);
  expect(screen.queryByRole('status', { name: 'Working…' })).not.toBeInTheDocument();
});

it('does not confuse a repeated prompt with its earlier saved copy', async () => {
  const data = view();
  const earlier = { id: crypto.randomUUID(), role: 'user' as const, text: 'Try again', at: '2026-10-18T10:00:00.000Z' };
  data.conversation.messages = [earlier];
  let finish!: (result: AssistantView) => void;
  const request = vi.spyOn(api, 'assistantRequest').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { client } = panel(data);
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  await userEvent.type(screen.getByRole('textbox'), 'Try again');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  const log = screen.getByRole('log');
  expect(within(log).getAllByText('Try again')).toHaveLength(2);
  const requestId = request.mock.calls[0]![0].requestId;
  const claimed: AssistantView = { ...data, busy: true, conversation: { ...data.conversation, version: 1, lastRequestId: requestId } };
  await act(async () => { client.setQueryData(['viz', 'assistant', 'alice:org-a', null], claimed); });
  expect(within(log).getAllByText('Try again')).toHaveLength(2);
  const saved: AssistantView = { ...claimed, conversation: { ...claimed.conversation, messages: [earlier,
    { id: crypto.randomUUID(), role: 'user', text: 'Try again', at: new Date().toISOString() }] } };
  await act(async () => { client.setQueryData(['viz', 'assistant', 'alice:org-a', null], saved); });
  expect(within(log).getAllByText('Try again')).toHaveLength(2);
  await act(async () => { finish({ ...saved, busy: false }); });
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

it('lists a proposal\'s read runs from the cached run list, an unknown one by its id, and echoes them on Approve', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-17T12:00:00.000Z'));
  const known = 'b4c281b5-6022-4ccd-a1eb-d69c5c0165ce', unknown = 'f0e1d2c3-6022-4ccd-a1eb-d69c5c0165ce';
  const runs = vi.spyOn(api, 'projectRuns').mockResolvedValue([{ projectRunId: known, projectId, goal: 'Restore the collector',
    title: 'Release stuck resume lock', status: 'delivered', traceId: 'trace-1', costUsd: 0.19, durationS: 576, error: null,
    createdAt: '2026-10-17T10:40:31.129Z', endedAt: '2026-10-17T10:50:09.924Z', publication: null }]);
  const data = view();
  data.conversation.version = 3;
  data.conversation.proposal = { id: proposalId, state: 'pending', action: { kind: 'start_run', projectId,
    goal: 'Restore browser/collect.js to its earlier bytes', acceptanceCriteria: [], readRunIds: [known, unknown] } };
  const request = vi.spyOn(api, 'assistantRequest').mockResolvedValue({ ...data, conversation: { ...data.conversation, proposal: null, version: 4 } });
  panel(data);
  const card = await screen.findByRole('article', { name: 'For your approval' });
  expect(within(card).getByText('Reads the saved files of these 2 earlier runs')).toBeVisible();
  expect(within(card).getByText('The run gets copies to read, restore from or compare with; they are never delivered or published.')).toBeVisible();
  const [first, second] = within(card).getAllByRole('listitem');
  await waitFor(() => expect(first).toHaveTextContent('Release stuck resume lock · b4c281b5 · delivered · an hour ago'));
  expect(within(first!).getByText('an hour ago')).toHaveAttribute('dateTime', '2026-10-17T10:50:09.924Z');
  expect(second).toHaveTextContent(/^f0e1d2c3$/);
  expect(runs).toHaveBeenCalledWith(projectId);
  await userEvent.click(screen.getByRole('button', { name: 'Approve and start run' }));
  expect(request).toHaveBeenCalledWith({ kind: 'confirm', version: 3, projectId: null, proposalId, requestId: expect.any(String),
    readRunIds: [known, unknown] });
});

it('names one read run in the singular and reads no run list for a proposal without any', async () => {
  const runs = vi.spyOn(api, 'projectRuns').mockResolvedValue([]);
  const data = view();
  data.conversation.proposal = { id: proposalId, state: 'pending', action: { kind: 'start_run', projectId,
    goal: 'Compare the report with its earlier version', acceptanceCriteria: [], readRunIds: ['b4c281b5-6022-4ccd-a1eb-d69c5c0165ce'] } };
  const first = panel(data);
  expect(await screen.findByText('Reads the saved files of this earlier run')).toBeVisible();
  first.unmount();
  runs.mockClear();
  const plain = view();
  plain.conversation.proposal = { id: proposalId, state: 'pending', action: { kind: 'start_run', projectId, goal: 'Add stock alerts', acceptanceCriteria: [] } };
  panel(plain);
  expect(await screen.findByRole('button', { name: 'Approve and start run' })).toBeVisible();
  expect(screen.queryByText(/saved files of/)).not.toBeInTheDocument();
  expect(runs).not.toHaveBeenCalled();
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
  expect(within(screen.getByRole('log')).getByText('Keep my draft')).toBeVisible();
  expect(screen.getByRole('status', { name: 'Working…' })).toBeVisible();
  await act(async () => { fail(new Error('Try again')); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Try again');
  expect(screen.getByRole('textbox')).toHaveValue('Keep my draft');
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(within(screen.getByRole('log')).queryByText('Keep my draft')).not.toBeInTheDocument();
  expect(screen.queryByRole('status', { name: 'Working…' })).not.toBeInTheDocument();
});

it('keeps a saved message in the chat when the response is lost', async () => {
  const data = view();
  let fail!: (error: Error) => void;
  const request = vi.spyOn(api, 'assistantRequest').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  panel(data);
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  await userEvent.type(screen.getByRole('textbox'), 'Check the failed run');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  const requestId = request.mock.calls[0]![0].requestId;
  const saved: AssistantView = { ...data, conversation: { ...data.conversation, version: 1, lastRequestId: requestId,
    messages: [{ id: crypto.randomUUID(), role: 'user', origin: 'atoma', text: 'Check the failed run', at: new Date().toISOString() }] } };
  vi.mocked(api.assistant).mockResolvedValue(saved);
  await act(async () => { fail(new Error('Response lost')); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Response lost');
  expect(within(screen.getByRole('log')).getAllByText('Check the failed run')).toHaveLength(1);
  expect(screen.getByRole('textbox')).toHaveValue('');
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
  vi.spyOn(api, 'runReview').mockResolvedValue(deliveryReview());
  const data = view();
  data.run = { projectId, runId: 'run-1', status: 'delivered', costUsd: 0.52, traceId: 'trace-1', error: null, endedAt: null };
  data.conversation.lastRun = { projectId, runId: 'run-1' };
  data.conversation.costUsd = 0.0012;
  data.conversation.inputTokens = 900;
  data.conversation.outputTokens = 240;
  const { props } = panel(data);
  expect(await screen.findByRole('article', { name: 'Run result' })).toHaveTextContent('$0.52');
  expect(screen.getByText(/Conversation:/)).toHaveTextContent('$0.0012');
  await userEvent.click(screen.getByRole('button', { name: 'Open run' }));
  expect(props.onRun).toHaveBeenCalledWith(data.conversation.lastRun, 'trace-1');
});

it('recovers a delivered run on re-entry and publishes only after explicit review of its manifest', async () => {
  const review = deliveryReview();
  vi.spyOn(api, 'runReview').mockImplementation(async () => review);
  // Exercise the real HTTP client mutation, including the exact URL and JSON body.
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    review.clientAcceptance = { manifestHash: 'a'.repeat(64), review: 'Tested adding and removing books.', principalId: projectId, acceptedAt: '2026-10-12T10:00:00.000Z' };
    review.canRequestAcceptance = false; review.publicationStatus = 'published';
    return new Response('{}', { status: 200 });
  });
  const inference = vi.spyOn(api, 'assistantRequest');
  panel({ ...deliveredView(), available: false, choices: [] }); // No connected model is needed.
  const result = await screen.findByRole('article', { name: 'Run result' });
  expect(within(result).getByText('Run delivered — ready for your review.')).toBeVisible();
  await userEvent.click(await screen.findByRole('button', { name: 'Review and publish to GitHub' }));
  expect(fetch).not.toHaveBeenCalled();
  const confirm = screen.getByRole('button', { name: 'Accept and publish to GitHub' });
  expect(confirm).toBeDisabled();
  await userEvent.type(screen.getByRole('textbox', { name: 'Your review of this delivery' }), 'Tested adding and removing books.');
  await userEvent.click(confirm);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(`/api/projects/${projectId}/runs/run-1/accept`, expect.objectContaining({
    method: 'POST', body: JSON.stringify({ manifestHash: 'a'.repeat(64), review: 'Tested adding and removing books.' }),
  }));
  expect(await screen.findByText('Published to GitHub. Open the run for publication details.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Review and publish to GitHub' })).not.toBeInTheDocument();
  expect(inference).not.toHaveBeenCalled();
});

it('offers review and publication for a run this conversation did not start', async () => {
  // Started over MCP or the CLI: the conversation never recorded it, and the
  // browser had no other place to accept it (2026-10-12).
  const read = vi.spyOn(api, 'runReview').mockResolvedValue(deliveryReview());
  const data = deliveredView(); data.conversation.lastRun = null;
  const { props } = panel(data);
  expect(await screen.findByRole('button', { name: 'Review and publish to GitHub' })).toBeVisible();
  expect(read).toHaveBeenCalledWith(projectId, 'run-1');
  await userEvent.click(screen.getByRole('button', { name: 'Open run' }));
  expect(props.onRun).toHaveBeenCalledWith({ projectId, runId: 'run-1' }, 'trace-1');
});

it.each(['partial', 'failed', 'cancelled'])('announces a %s outcome without offering publication', async status => {
  const read = vi.spyOn(api, 'runReview');
  const data = deliveredView(); data.run!.status = status;
  panel(data);
  expect(await screen.findByRole('article', { name: 'Run result' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /publish to GitHub/ })).not.toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
});

it('replaces live status with the completion card when the polling result changes', async () => {
  vi.spyOn(api, 'runReview').mockResolvedValue(deliveryReview());
  const data = deliveredView(); data.run!.status = 'running';
  const { client } = panel(data);
  expect(await screen.findByText(/Run: running/)).toBeVisible();
  await act(async () => { client.setQueryData(['viz', 'assistant', 'alice:org-a', null], deliveredView()); });
  expect(await screen.findByRole('button', { name: 'Review and publish to GitHub' })).toBeVisible();
  expect(screen.queryByText(/Run: running/)).not.toBeInTheDocument();
});

it('offers acceptance without GitHub for text-only results and refuses unavailable review evidence', async () => {
  const review = deliveryReview(); review.delivery = 'text'; review.files!.files = []; review.files!.total = 0;
  vi.spyOn(api, 'runReview').mockResolvedValue(review);
  const first = panel(deliveredView());
  expect(await screen.findByRole('button', { name: 'Review and accept delivery' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /GitHub/ })).not.toBeInTheDocument();
  first.unmount();
  vi.mocked(api.runReview).mockRejectedValue(new Error('Unavailable'));
  panel(deliveredView());
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the delivery review');
  expect(screen.queryByRole('button', { name: /Review and/ })).not.toBeInTheDocument();
});

it('refreshes acceptance after a lost publication response and retries publication without accepting again', async () => {
  let review = deliveryReview();
  vi.spyOn(api, 'runReview').mockImplementation(async () => review);
  const accept = vi.spyOn(api, 'acceptDelivery').mockImplementation(async () => {
    review = { ...review, canRequestAcceptance: false, canRetryPublication: true, publicationStatus: 'failed',
      clientAcceptance: { manifestHash: 'a'.repeat(64), review: 'Reviewed.', principalId: projectId, acceptedAt: '2026-10-12T10:00:00.000Z' } };
    throw new Error('Publication response lost');
  });
  const publish = vi.spyOn(api, 'retryPublication').mockResolvedValue({} as Awaited<ReturnType<typeof api.retryPublication>>);
  panel(deliveredView());
  await userEvent.click(await screen.findByRole('button', { name: 'Review and publish to GitHub' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Your review of this delivery' }), 'Reviewed.');
  await userEvent.click(screen.getByRole('button', { name: 'Accept and publish to GitHub' }));
  const retry = await screen.findByRole('button', { name: 'Retry GitHub publication' });
  await waitFor(() => expect(retry).toBeEnabled());
  await userEvent.click(retry);
  expect(accept).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledWith(projectId, 'run-1');
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

it('keeps a conversation without messages at its natural height while a run shows', async () => {
  // A run started elsewhere, no exchange: a full-height empty log sat above
  // "Run: running" (2026-10-12). Neither the live status nor the result card
  // turns the card into a tall conversation; a message still does.
  vi.spyOn(api, 'runReview').mockResolvedValue(deliveryReview());
  const data = deliveredView(); data.conversation.lastRun = null; data.run!.status = 'running';
  const { client } = panel(data);
  expect(await screen.findByText(/Run: running/)).toBeVisible();
  expect(screen.getByRole('log')).toHaveClass('gpu-assistant-log--empty');
  expect(useGpuStore.getState().projectAssistantCompact).toBe(true);
  await act(async () => { client.setQueryData(['viz', 'assistant', 'alice:org-a', null], { ...data, run: { ...data.run!, status: 'delivered' } }); });
  expect(await screen.findByRole('button', { name: 'Review and publish to GitHub' })).toBeVisible();
  expect(screen.getByRole('log')).not.toHaveClass('gpu-assistant-log--empty');
  expect(useGpuStore.getState().projectAssistantCompact).toBe(true);
  await act(async () => { client.setQueryData(['viz', 'assistant', 'alice:org-a', null], { ...data, run: { ...data.run!, status: 'delivered' },
    conversation: { ...data.conversation, version: 1, messages: [{ role: 'assistant', text: 'A shared update', at: '2026-10-09T10:00:00.000Z' }] } }); });
  expect(await screen.findByText('A shared update')).toBeVisible();
  expect(useGpuStore.getState().projectAssistantCompact).toBe(false);
});

it.each(['delivered', 'partial', 'failed', 'cancelled'])('hides the composer during queued and running runs and restores its draft after %s', async status => {
  vi.spyOn(api, 'runReview').mockResolvedValue(deliveryReview());
  const request = vi.spyOn(api, 'assistantRequest').mockResolvedValue(view());
  const data = deliveredView(); data.run = null;
  const { client, props } = panel(data);
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  await userEvent.type(screen.getByRole('textbox'), 'Keep this draft');
  const run = { ...deliveredView().run!, status: 'queued' };
  for (const liveStatus of ['queued', 'running']) {
    await act(async () => { client.setQueryData(['viz', 'assistant', 'alice:org-a', null], { ...data, run: { ...run, status: liveStatus } }); });
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.getByText('A run is queued or in progress. You can request a change after its result is available.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Open run' }));
    expect(props.onRun).toHaveBeenLastCalledWith({ projectId, runId: run.runId }, run.traceId);
  }
  await act(async () => { client.setQueryData(['viz', 'assistant', 'alice:org-a', null], { ...data, run: { ...run, status } }); });
  expect(await screen.findByRole('textbox')).toHaveValue('Keep this draft');
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  expect(screen.queryByText('A run is queued or in progress. You can request a change after its result is available.')).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});

it('places a finished run before a later question and shows its completion time', async () => {
  const data = deliveredView();
  data.run = { ...data.run!, status: 'failed', endedAt: '2026-10-18T10:00:00.000Z', error: 'runner finished with outcome error' };
  data.conversation.messages = [
    { role: 'receipt', text: 'assistant.runStarted', at: '2026-10-18T09:00:00.000Z' },
    { role: 'user', text: 'Why did the run fail?', at: '2026-10-18T10:01:00.000Z' },
  ];
  panel(data);
  const log = await screen.findByRole('log');
  const items = within(log).getAllByRole('article');
  expect(items).toHaveLength(3);
  expect(items[0]).toHaveTextContent('Run requested.');
  expect(items[1]).toHaveTextContent('Run failed');
  expect(items[2]).toHaveTextContent('Why did the run fail?');
  const time = items[1]!.querySelector('time');
  expect(time).toHaveAttribute('dateTime', data.run.endedAt);
  expect(time).toHaveAttribute('title', timestampTooltip(data.run.endedAt!, 'en'));
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
  await userEvent.click(await screen.findByRole('button', { name: 'Load earlier messages' }));
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
