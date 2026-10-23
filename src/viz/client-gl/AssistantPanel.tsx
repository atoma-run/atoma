import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssistantRequest, AssistantRun, AssistantView } from '../../contracts/assistant.js';
import { api } from '../client/data-api.js';
import { RelativeTime } from './RelativeTime.js';
import { useGpuStore } from './store.js';
import { AtomaLoader, loaderVisible, revealClass, useLoadingReveal } from './AtomaLoader.js';
import { ButtonIcon } from './ButtonIcon.js';
import { AssistantMarkdown } from './AssistantMarkdown.js';
import { AssistantRunResult } from './AssistantRunResult.js';

interface Props {
  scopeKey: string; projectId: string | null; locale: string;
  externalAgentGuide?: ReactNode; onboarding?: ReactNode;
  heading?: ReactNode;
  collapsed?: boolean;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onSettings: (tab: 'subscriptions' | 'keys') => void; onScopeChange: (id: string) => void; onProject: (id: string) => void; onRun: (run: AssistantRun, traceId: string | null) => void;
}

interface OptimisticMessage {
  requestId: string;
  scopeKey: string;
  projectId: string | null;
  text: string;
  at: string;
  knownMessageIds: ReadonlySet<string>;
}

function isRecordedMessage(message: OptimisticMessage, view: AssistantView | undefined): boolean {
  return view?.conversation.lastRequestId === message.requestId && view.conversation.messages.some(saved =>
    saved.role === 'user' && saved.text === message.text && !!saved.id && !message.knownMessageIds.has(saved.id));
}

/**
 * Selectable conversation and native inputs INSIDE the Projects guide card
 * (owner, 2026-10-09): the guide's contextual title is the card's, this is
 * its body, and the external-agent path takes over the body when opened.
 * The guide owns the frame, the veil and the collapse; this block fills it.
 */
export function AssistantPanel({ scopeKey, projectId, locale, externalAgentGuide, onboarding, heading, collapsed = false, t, onSettings, onScopeChange, onProject, onRun }: Props) {
  const client = useQueryClient();
  const queryKey = ['viz', 'assistant', scopeKey, projectId];
  const conversationId = useRef<string | undefined>(undefined);
  const query = useQuery({ queryKey, queryFn: () => api.assistant(projectId, { conversationId: conversationId.current }), retry: false,
    refetchInterval: 5000 });
  const reveal = useLoadingReveal(query.isPending);
  const [older, setOlder] = useState<AssistantView['conversation']['messages']>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState('');
  const [optimistic, setOptimistic] = useState<OptimisticMessage | null>(null);
  const modelPreferenceKey = `atoma.viz.assistant-model:${encodeURIComponent(scopeKey)}`;
  const [selection, setSelection] = useState<string | null>(() => {
    try { return localStorage.getItem(modelPreferenceKey); } catch { return null; }
  });
  const [editingModel, setEditingModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalAgentOpen, setExternalAgentOpen] = useState(false);
  const pending = useRef<AssistantRequest | null>(null);
  const mounted = useRef(true);
  const panel = useRef<HTMLElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  // No focus on mount: the card is on screen whenever Projects is, and a
  // textarea stealing focus from the canvas on every visit would be a defect.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const conversation = query.data?.conversation;
  const visibleOptimistic = optimistic?.scopeKey === scopeKey && optimistic.projectId === projectId &&
    !isRecordedMessage(optimistic, query.data) ? optimistic : null;
  const hasUsage = (conversation?.inputTokens ?? 0) > 0 || (conversation?.outputTokens ?? 0) > 0;
  useEffect(() => {
    conversationId.current = conversation?.id ?? undefined;
    setOlder([]); setBefore(query.data?.nextBefore ?? null);
  }, [conversation?.id, conversation?.version, query.data?.nextBefore]);
  useEffect(() => {
    if (conversation?.projectId && conversation.projectId !== projectId) onScopeChange(conversation.projectId);
  }, [conversation?.projectId, projectId, onScopeChange]);
  const waiting = busy || query.data?.busy === true;
  const active = useGpuStore(state => !state.selectedProjectId || state.projectSection === 'conversation');
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; },
    [conversation?.messages.at(-1)?.id ?? conversation?.messages.length, visibleOptimistic?.requestId, query.data?.run?.status, waiting, active]);
  const proposal = conversation?.proposal;
  // A start's read runs, as saved; Approve echoes exactly these back.
  const readRunIds = proposal?.action.kind === 'start_run' ? proposal.action.readRunIds ?? [] : [];
  const readRunsProjectId = proposal?.action.kind === 'start_run' ? proposal.action.projectId : null;
  // Their titles come from the run list the open project already polls: the same cache entry, no polling of its own.
  const projectRuns = useQuery({ queryKey: ['viz', 'project', readRunsProjectId, 'runs'],
    queryFn: () => api.projectRuns(readRunsProjectId!), enabled: readRunIds.length > 0 && readRunsProjectId !== null, staleTime: 5_000 });
  const shownRun = query.data?.run ?? null;
  const runInProgress = shownRun?.status === 'queued' || shownRun?.status === 'running';
  const modelChoice = selection ?? conversation?.modelChoice ?? '';
  const choices = query.data?.choices ?? [];
  const selected = choices.find(choice => choice.id === modelChoice);
  const modelLabel = selected ? `${selected.label} · ${t(`assistant.payer.${selected.payer}`)}` : '';
  useEffect(() => {
    if (!selected) return;
    try { localStorage.setItem(modelPreferenceKey, selected.id); } catch { /* Storage may be disabled. */ }
  }, [modelPreferenceKey, selected?.id]);
  const canSend = query.data?.available && selected !== undefined;
  // No exchange yet. A run started elsewhere does not make the conversation
  // tall: the card keeps its natural height, the result card or the live
  // status included (2026-10-12: a full-height empty log above "running").
  const quiet = !waiting && !visibleOptimistic && older.length === 0 && !conversation?.messages.length && !before &&
    (!proposal || proposal.state === 'done');
  const finishedRun = shownRun && ['delivered', 'partial', 'failed', 'cancelled'].includes(shownRun.status) ? shownRun : null;
  const messages = [...older, ...(conversation?.messages ?? []), ...(visibleOptimistic
    ? [{ id: visibleOptimistic.requestId, role: 'user' as const, text: visibleOptimistic.text, at: visibleOptimistic.at }]
    : [])];
  const endedAtMs = finishedRun?.endedAt ? Date.parse(finishedRun.endedAt) : NaN;
  const firstLaterMessage = Number.isFinite(endedAtMs) ? messages.findIndex(message => Date.parse(message.at) > endedAtMs) : -1;
  const resultPosition = firstLaterMessage < 0 ? messages.length : firstLaterMessage;
  const timeline: Array<{ kind: 'message'; message: typeof messages[number]; index: number } | { kind: 'result' }> =
    messages.map((message, index) => ({ kind: 'message', message, index }));
  if (finishedRun) timeline.splice(resultPosition, 0, { kind: 'result' });
  const resultCard = finishedRun ? <AssistantRunResult key={`${scopeKey}:${finishedRun.runId}`} scopeKey={scopeKey}
    target={{ projectId: finishedRun.projectId, runId: finishedRun.runId }} run={finishedRun} locale={locale} t={t} onRun={onRun} /> : null;
  const empty = quiet && !finishedRun;
  const newProjectPrompt = empty && !projectId && !shownRun;
  const compact = externalAgentOpen || Boolean(query.data && choices.length > 0 && quiet && !error && !query.isError);
  useLayoutEffect(() => {
    useGpuStore.setState({ projectAssistantCompact: compact });
    return () => { useGpuStore.setState({ projectAssistantCompact: false }); };
  }, [compact]);
  const fitContents = compact && !externalAgentOpen && !collapsed;
  useLayoutEffect(() => {
    const element = panel.current;
    const card = element?.closest<HTMLElement>('.gpu-project-mcp');
    if (!fitContents || !element || !card || typeof ResizeObserver === 'undefined') return;
    // Measure natural DOM height, before the camera transform. The renderer
    // uses the same value for the card and the following project rows.
    const measure = () => {
      if (card.hidden) return;
      const style = getComputedStyle(card);
      const inset = [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth]
        .reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
      const height = Math.ceil(element.offsetHeight + inset);
      if (height !== useGpuStore.getState().projectAssistantCompactHeight) {
        useGpuStore.setState({ projectAssistantCompactHeight: height });
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      useGpuStore.setState({ projectAssistantCompactHeight: null });
    };
  }, [fitContents]);

  async function submit(kind: 'message' | 'confirm') {
    if (!conversation || waiting || (kind === 'message' && (runInProgress || !canSend || !draft.trim()))) return;
    const previous = pending.current;
    const request: AssistantRequest = previous && previous.kind === kind &&
      (previous.kind === 'confirm' ? previous.proposalId === proposal?.id : previous.text === draft.trim() && previous.modelChoice === modelChoice)
      ? previous
      : kind === 'message'
        ? { kind, requestId: crypto.randomUUID(), version: conversation.version, projectId, ...(conversation.id ? { conversationId: conversation.id } : {}), text: draft.trim(), modelChoice }
        : { kind, requestId: crypto.randomUUID(), version: conversation.version, projectId, ...(conversation.id ? { conversationId: conversation.id } : {}), proposalId: proposal!.id,
          ...(readRunIds.length ? { readRunIds } : {}) };
    pending.current = request;
    const submittedDraft = draft;
    const submittedMessage: OptimisticMessage | null = request.kind === 'message'
      ? { requestId: request.requestId, scopeKey, projectId, text: request.text,
        at: new Date().toISOString(), knownMessageIds: new Set(conversation.messages.flatMap(message => message.id ? [message.id] : [])) }
      : null;
    if (submittedMessage) {
      setOptimistic(submittedMessage);
      setDraft('');
    }
    setBusy(true); setError(null);
    try {
      const result = await api.assistantRequest(request);
      if (!mounted.current) return;
      client.setQueryData<AssistantView>(queryKey, result);
      if (kind === 'message') setOptimistic(null);
      pending.current = null;
      void client.invalidateQueries({ queryKey: ['viz', 'projects'] });
      void client.invalidateQueries({ queryKey: ['viz', 'project'] });
      void client.invalidateQueries({ queryKey: ['viz', 'runs'] });
    } catch (failure) {
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : t('assistant.failed'));
        const refreshed = await query.refetch();
        const recorded = submittedMessage !== null && isRecordedMessage(submittedMessage, refreshed.data);
        if (submittedMessage && !refreshed.data?.busy) {
          setOptimistic(null);
          if (!recorded) setDraft(submittedDraft);
        }
        // A received request has already spent its allowance, including a failed model response.
        if (refreshed.data?.conversation.lastRequestId === request.requestId && !refreshed.data.busy) pending.current = null;
      }
    } finally { if (mounted.current) setBusy(false); }
  }

  async function loadOlder() {
    if (!before || !conversation?.id || loadingHistory) return;
    setLoadingHistory(true);
    try {
      const page = await api.assistant(projectId, { conversationId: conversation.id, before });
      if (!mounted.current) return;
      if (page.conversation.version !== client.getQueryData<AssistantView>(queryKey)?.conversation.version) { await query.refetch(); return; }
      setOlder(previous => [...page.conversation.messages, ...previous]); setBefore(page.nextBefore);
    } catch { if (mounted.current) setError(t('assistant.failed')); }
    finally { if (mounted.current) setLoadingHistory(false); }
  }

  async function copyContinuation() {
    if (!conversation?.id) return;
    try {
      await navigator.clipboard.writeText(t('assistant.continuationPrompt', { id: conversation.id }));
      setCopied(true);
    } catch { setError(t('assistant.copyFailed')); }
  }

  return <section ref={panel} className={`gpu-assistant${fitContents ? ' gpu-assistant--fit' : ''}`} aria-label={t('assistant.title')}>
    <header className="gpu-assistant-header">
    {heading}
    {query.data && !collapsed && !externalAgentOpen ? <div className="gpu-assistant-connection">
      {selected && !editingModel ? <>
        <span className="gpu-assistant-model-label">{t('assistant.model')}</span>
        <span className="gpu-assistant-model-value" title={modelLabel}>{modelLabel}</span>
        <button type="button" className="gpu-assistant-model-change" disabled={waiting} onClick={() => setEditingModel(true)}><ButtonIcon kind="settings" />{t('assistant.changeModel')}</button>
      </> : <>
      <label htmlFor="assistant-model">{t('assistant.model')}</label>
      <select id="assistant-model" value={modelChoice} autoFocus={editingModel} disabled={waiting || choices.length === 0} onChange={event => {
        setSelection(event.target.value); pending.current = null;
        try { localStorage.setItem(modelPreferenceKey, event.target.value); } catch { /* Keep the in-memory choice. */ }
        setEditingModel(false);
      }}>
        <option value="">{t(choices.length ? 'assistant.chooseModel' : 'assistant.noModels')}</option>
        {modelChoice && !selected ? <option value={modelChoice}>{t('assistant.connectionUnavailable')}</option> : null}
        {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label} · {t(`assistant.payer.${choice.payer}`)}</option>)}
      </select>
      <button type="button" onClick={() => onSettings('subscriptions')}>{t('assistant.connections')}</button>
      {selected ? <button type="button" className="gpu-assistant-model-keep" onClick={() => setEditingModel(false)}>{t('assistant.keepModel')}</button> : null}
      </>}
      {!query.data.available || (modelChoice && !selected) ? <small role="status">{t(!query.data.available ? 'assistant.unavailable' : 'assistant.connectionUnavailable')}</small> : null}
    </div> : null}
    </header>
    <div id="project-mcp-content" className="gpu-assistant-content" hidden={collapsed}>
    {onboarding}
    <div className={`gpu-assistant-conversation${empty ? ' gpu-assistant-conversation--empty' : ''}`} hidden={externalAgentOpen}>
    {query.isError ? <div role="alert"><p>{t('assistant.failed')}</p><button onClick={() => void query.refetch()}>{t('assistant.retry')}</button></div> : null}
    {loaderVisible(reveal) ? <AtomaLoader section leaving={reveal === 'leaving'} label={t('assistant.loading')} /> : null}
    {query.data && choices.length === 0 ? <div className={`gpu-assistant-setup${revealClass(reveal)}`}>
      {(query.data.subscriptions ?? []).map(subscription => <div key={subscription.provider}>
        <span>{subscription.provider === 'claude' ? 'Claude' : 'ChatGPT'} · {t(`settings.subscriptionState.${subscription.state}`)}</span>
        <button type="button" onClick={() => onSettings('subscriptions')}>{t(subscription.state === 'connected' || subscription.state === 'connecting' ? 'assistant.connections' :
          `settings.subscription${subscription.state === 'reauth_required' ? 'Reconnect' : 'Connect'}${subscription.provider === 'claude' ? 'Claude' : ''}`)}</button>
      </div>)}
      <button type="button" onClick={() => onSettings('keys')}>{t('assistant.apiKeys')}</button>
    </div> : null}
    <div className={`gpu-assistant-log${empty ? ' gpu-assistant-log--empty' : ''}${revealClass(reveal)}`} hidden={newProjectPrompt} ref={log} role="log" aria-label={t('assistant.conversation')} aria-live="polite" aria-relevant="additions">
      {before ? <button type="button" disabled={loadingHistory} onClick={() => void loadOlder()}>{t('assistant.olderMessages')}</button> : null}
      {empty && conversation && projectId ? <p className="gpu-assistant-empty">{t('assistant.existingHint')}</p> : null}
      {timeline.map(entry => {
        if (entry.kind === 'result') return resultCard;
        const { message } = entry;
        return <article key={message.id ?? `${message.at}:${entry.index}`} className={`gpu-assistant-message gpu-assistant-message--${message.role}`}>
        <div className="gpu-assistant-message-meta"><strong>{t(message.role === 'user' ? 'assistant.you' : message.role === 'receipt' ? 'assistant.receipt' : 'assistant.title')}</strong>
          {message.origin === 'mcp' ? <span>{t('assistant.sharedFrom', { client: message.clientLabel ?? 'MCP' })}</span> : null}
          <RelativeTime at={message.at} locale={locale} t={t} /></div>
        {message.role === 'assistant' ? <AssistantMarkdown text={message.text} />
          : <p>{message.role === 'receipt' ? t(message.text) : message.text}</p>}
        {message.projectId || message.run ? <div className="gpu-assistant-message-actions">
          {message.projectId ? <button type="button" onClick={() => onProject(message.projectId!)}><ButtonIcon kind="folder" />{t('assistant.openProject')}</button> : null}
          {message.run ? <button type="button" onClick={() => onRun(message.run!, query.data?.run?.runId === message.run!.runId ? query.data.run.traceId : null)}><ButtonIcon kind="play" />{t('assistant.openRun')}</button> : null}
        </div> : null}
        </article>;
      })}
      {proposal && proposal.state !== 'done' ? <article className="gpu-assistant-proposal" aria-label={t('assistant.proposal')}>
        <h3>{t('assistant.proposal')}</h3>
        {proposal.action.kind === 'create_project' ? <>
          <p><strong>{proposal.action.project.name}</strong> · {proposal.action.project.slug}</p>
          <p>{t('assistant.repository')}: {proposal.action.project.repositoryTarget.owner}/{proposal.action.project.repositoryTarget.name}</p>
          <p>{t('assistant.visibility')}: <strong>{t(`assistant.${proposal.action.project.repositoryTarget.visibility}`)}</strong></p>
          {proposal.action.project.repositoryTarget.source ? <p>{t('assistant.source')}: {proposal.action.project.repositoryTarget.source.owner}/{proposal.action.project.repositoryTarget.source.name} · {proposal.action.project.repositoryTarget.source.mode}</p> : null}
          <p>{proposal.action.project.initialPrompt}</p>
        </> : <><p>{t('assistant.project')}: {proposal.projectName ?? proposal.action.projectId}</p><p>{proposal.action.goal}</p>
          {proposal.action.acceptanceCriteria.length ? <ul>{proposal.action.acceptanceCriteria.map((line, index) => <li key={index}>{line}</li>)}</ul> : null}
          {readRunIds.length ? <div className="gpu-assistant-read-runs">
            <p><strong>{t('assistant.readRuns', { count: readRunIds.length })}</strong></p>
            <p>{t('assistant.readRunsNotice')}</p>
            <ul>{readRunIds.map(runId => {
              const run = projectRuns.data?.find(row => row.projectRunId === runId);
              const at = run ? run.endedAt ?? run.createdAt : null;
              // An id the cached list does not hold shows alone; a title is model text, never markup.
              return <li key={runId}>{run?.title ? <>{run.title} · </> : null}<code>{runId.slice(0, 8)}</code>
                {run ? <> · {t(`projects.runStatus.${run.status}`)}</> : null}
                {at ? <> · <RelativeTime at={at} locale={locale} t={t} /></> : null}</li>;
            })}</ul>
          </div> : null}
          <p>{t('assistant.runCostNotice')}</p></>}
        <p>{t('assistant.reviseHint')}</p>
        {proposal.state === 'pending' ? <button className="gpu-assistant-primary" disabled={waiting}
          onClick={() => void submit('confirm')}>{t(proposal.action.kind === 'create_project' ? 'assistant.create' : 'assistant.launch')}</button>
          : <p role="status">{t(waiting ? 'assistant.working' : 'assistant.uncertain')}</p>}
      </article> : null}
      {waiting ? <div className="gpu-assistant-message gpu-assistant-message--assistant gpu-assistant-typing" role="status" aria-label={t('assistant.working')}>
        <span className="gpu-assistant-typing-dots" aria-hidden="true"><span /><span /><span /></span>
      </div> : null}
    </div>
    {shownRun && !finishedRun ? <div className="gpu-assistant-run" role="status">
      <span>{t('assistant.runStatus', { status: t(`projects.runStatus.${shownRun.status}`) })}
        {shownRun.costUsd !== null ? ` · $${shownRun.costUsd.toFixed(2)}` : ''}</span>
      <button type="button" onClick={() => onRun({ projectId: shownRun.projectId, runId: shownRun.runId }, shownRun.traceId)}><ButtonIcon kind="play" />{t('assistant.openRun')}</button>
    </div> : null}
    {error ? <p role="alert" className="gpu-assistant-error">{error}</p> : null}
    {runInProgress ? <p role="status">{t('assistant.runInProgress')}</p> : <form aria-busy={waiting} onSubmit={event => { event.preventDefault(); void submit('message'); }}>
      <label htmlFor="assistant-message" className={newProjectPrompt ? 'gpu-assistant-empty' : undefined}>{t(newProjectPrompt ? 'assistant.newHint' : 'assistant.message')}</label>
      <textarea id="assistant-message" ref={composer} value={draft} maxLength={4000} rows={2} enterKeyHint="send"
        placeholder={waiting ? '' : t('assistant.placeholder')} disabled={waiting || !canSend}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault();
          if (!event.repeat) event.currentTarget.form?.requestSubmit();
        }}
        onChange={event => { setDraft(event.target.value); pending.current = null; }} />
      <div className="gpu-assistant-footer">{hasUsage ? <small title={t('assistant.cost', { cost: (conversation?.costUsd ?? 0).toFixed(4) })}>{t('assistant.cost', { cost: (conversation?.costUsd ?? 0).toFixed(4) })}</small> : null}
        <button type="submit" className="gpu-assistant-primary" disabled={waiting || !draft.trim() || !canSend}>
          <ButtonIcon kind={waiting ? 'clock' : 'send'} />{t(waiting ? 'assistant.working' : 'assistant.send')}</button></div>
    </form>}
    </div>
    {externalAgentOpen && error ? <p role="alert" className="gpu-assistant-error">{error}</p> : null}
    <details className="gpu-project-mcp-own-agent" open={externalAgentOpen}
      onToggle={event => setExternalAgentOpen(event.currentTarget.open)}>
      <summary>{t(externalAgentOpen ? 'assistant.backToConversation' : 'projects.mcpOwnAgent')}</summary>
      <div className="gpu-project-mcp-own-agent-body">
        {conversation?.id ? <div className="gpu-assistant-handoff"><button type="button" onClick={() => void copyContinuation()}>
          {t(copied ? 'assistant.continuationCopied' : 'assistant.continueElsewhere')}</button><small>{t('assistant.continuityHint')}</small></div> : null}
        {externalAgentGuide}
      </div>
    </details>
    </div>
  </section>;
}
