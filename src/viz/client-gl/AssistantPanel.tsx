import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssistantRequest, AssistantRun, AssistantView } from '../../contracts/assistant.js';
import { api } from '../client/data-api.js';
import { formatDateTime } from '../client/date-format.js';

interface Props {
  scopeKey: string; projectId: string | null; locale: string; inert: boolean;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onSettings: () => void; onScopeChange: (id: string) => void; onClose: () => void; onProject: (id: string) => void; onRun: (run: AssistantRun, traceId: string | null) => void;
}

/** Selectable conversation and native inputs over the Projects view's GPU-drawn panel. */
export function AssistantPanel({ scopeKey, projectId, locale, inert, t, onSettings, onScopeChange, onClose, onProject, onRun }: Props) {
  const client = useQueryClient();
  const queryKey = ['viz', 'assistant', scopeKey, projectId];
  const conversationId = useRef<string | undefined>(undefined);
  const query = useQuery({ queryKey, queryFn: () => api.assistant(projectId, { conversationId: conversationId.current }), retry: false,
    refetchInterval: 5000 });
  const [older, setOlder] = useState<AssistantView['conversation']['messages']>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState('');
  const [selection, setSelection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AssistantRequest | null>(null);
  const mounted = useRef(true);
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { mounted.current = true; composer.current?.focus(); return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [query.data?.conversation.messages.at(-1)?.id ?? query.data?.conversation.messages.length]);
  const conversation = query.data?.conversation;
  useEffect(() => {
    conversationId.current = conversation?.id ?? undefined;
    setOlder([]); setBefore(query.data?.nextBefore ?? null);
  }, [conversation?.id, conversation?.version, query.data?.nextBefore]);
  useEffect(() => {
    if (conversation?.projectId && conversation.projectId !== projectId) onScopeChange(conversation.projectId);
  }, [conversation?.projectId, projectId, onScopeChange]);
  const waiting = busy || query.data?.busy === true;
  const proposal = conversation?.proposal;
  const modelChoice = selection ?? conversation?.modelChoice ?? '';
  const choices = query.data?.choices ?? [];
  const selected = choices.find(choice => choice.id === modelChoice);
  const canSend = query.data?.available && selected !== undefined;

  async function submit(kind: 'message' | 'confirm') {
    if (!conversation || waiting || (kind === 'message' && !canSend)) return;
    const previous = pending.current;
    const request: AssistantRequest = previous && previous.kind === kind &&
      (previous.kind === 'confirm' ? previous.proposalId === proposal?.id : previous.text === draft.trim() && previous.modelChoice === modelChoice)
      ? previous
      : kind === 'message'
        ? { kind, requestId: crypto.randomUUID(), version: conversation.version, projectId, ...(conversation.id ? { conversationId: conversation.id } : {}), text: draft.trim(), modelChoice }
        : { kind, requestId: crypto.randomUUID(), version: conversation.version, projectId, ...(conversation.id ? { conversationId: conversation.id } : {}), proposalId: proposal!.id };
    pending.current = request;
    setBusy(true); setError(null);
    try {
      const result = await api.assistantRequest(request);
      if (!mounted.current) return;
      client.setQueryData<AssistantView>(queryKey, result);
      pending.current = null;
      if (kind === 'message') setDraft('');
      void client.invalidateQueries({ queryKey: ['viz', 'projects'] });
      void client.invalidateQueries({ queryKey: ['viz', 'project'] });
      void client.invalidateQueries({ queryKey: ['viz', 'runs'] });
    } catch (failure) {
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : t('assistant.failed'));
        const refreshed = await query.refetch();
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

  return <section className={`gpu-assistant${inert ? ' gpu-overlays-veiled' : ''}`} inert={inert}
    aria-labelledby="assistant-title" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <header><div><h2 id="assistant-title">{t('assistant.title')}</h2><p>{t('assistant.intro')}</p></div>
      <button type="button" onClick={onClose}>{t('assistant.close')}</button></header>
    {conversation?.id ? <div className="gpu-assistant-handoff"><button type="button" onClick={() => void copyContinuation()}>
      {t(copied ? 'assistant.continuationCopied' : 'assistant.continueElsewhere')}</button><small>{t('assistant.continuityHint')}</small></div> : null}
    {query.isError ? <div role="alert"><p>{t('assistant.failed')}</p><button onClick={() => void query.refetch()}>{t('assistant.retry')}</button></div> : null}
    {query.isPending ? <p role="status">{t('assistant.loading')}</p> : null}
    {query.data ? <div className="gpu-assistant-connection">
      <label htmlFor="assistant-model">{t('assistant.model')}</label>
      <select id="assistant-model" value={modelChoice} disabled={waiting} onChange={event => { setSelection(event.target.value); pending.current = null; }}>
        <option value="">{t('assistant.chooseModel')}</option>
        {modelChoice && !selected ? <option value={modelChoice}>{t('assistant.connectionUnavailable')}</option> : null}
        {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label} · {t(`assistant.payer.${choice.payer}`)}</option>)}
      </select>
      <button type="button" onClick={onSettings}>{t('assistant.connections')}</button>
      {selected ? <small>{t(`assistant.payer.${selected.payer}`)}</small> : <small role="status">{t(!query.data.available ? 'assistant.unavailable' : modelChoice ? 'assistant.connectionUnavailable' : 'assistant.chooseModel')}</small>}
    </div> : null}
    <div className="gpu-assistant-log" ref={log} role="log" aria-label={t('assistant.conversation')} aria-live="polite" aria-relevant="additions">
      {before ? <button type="button" disabled={loadingHistory} onClick={() => void loadOlder()}>{t('assistant.olderMessages')}</button> : null}
      {conversation?.messages.length === 0 ? <p className="gpu-assistant-empty">{t(projectId ? 'assistant.existingHint' : 'assistant.newHint')}</p> : null}
      {[...older, ...(conversation?.messages ?? [])].map((message, i) => <article key={message.id ?? `${message.at}:${i}`} className={`gpu-assistant-message gpu-assistant-message--${message.role}`}>
        <div className="gpu-assistant-message-meta"><strong>{t(message.role === 'user' ? 'assistant.you' : message.role === 'receipt' ? 'assistant.receipt' : 'assistant.title')}</strong>
          {message.origin === 'mcp' ? <span>{t('assistant.sharedFrom', { client: message.clientLabel ?? 'MCP' })}</span> : null}
          <time dateTime={message.at}>{formatDateTime(message.at, locale)}</time></div>
        <p>{message.role === 'receipt' ? t(message.text) : message.text}</p>
        {message.projectId ? <button onClick={() => onProject(message.projectId!)}>{t('assistant.openProject')}</button> : null}
        {message.run ? <button onClick={() => onRun(message.run!, conversation?.lastRun?.runId === message.run!.runId ? query.data?.run?.traceId ?? null : null)}>{t('assistant.openRun')}</button> : null}
      </article>)}
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
          <p>{t('assistant.runCostNotice')}</p></>}
        <p>{t('assistant.reviseHint')}</p>
        {proposal.state === 'pending' ? <button className="gpu-assistant-primary" disabled={waiting}
          onClick={() => void submit('confirm')}>{t(proposal.action.kind === 'create_project' ? 'assistant.create' : 'assistant.launch')}</button>
          : <p role="status">{t(waiting ? 'assistant.working' : 'assistant.uncertain')}</p>}
      </article> : null}
    </div>
    {query.data?.run && conversation?.lastRun ? <div className="gpu-assistant-run" role="status">
      <span>{t('assistant.runStatus', { status: t(`projects.runStatus.${query.data.run.status}`) })}
        {query.data.run.costUsd !== null ? ` · $${query.data.run.costUsd.toFixed(2)}` : ''}</span>
      <button onClick={() => onRun(conversation.lastRun!, query.data?.run?.traceId ?? null)}>{t('assistant.openRun')}</button>
    </div> : null}
    {error ? <p role="alert" className="gpu-assistant-error">{error}</p> : null}
    <form onSubmit={event => { event.preventDefault(); void submit('message'); }}>
      <label htmlFor="assistant-message">{t('assistant.message')}</label>
      <textarea id="assistant-message" ref={composer} value={draft} maxLength={4000} rows={3}
        placeholder={t('assistant.placeholder')} disabled={waiting || !canSend}
        onChange={event => { setDraft(event.target.value); pending.current = null; }} />
      <div className="gpu-assistant-footer"><small>{t('assistant.cost', { cost: (conversation?.costUsd ?? 0).toFixed(4) })}</small>
        <button type="submit" className="gpu-assistant-primary" disabled={waiting || !draft.trim() || !canSend}>
          {t(waiting ? 'assistant.working' : 'assistant.send')}</button></div>
    </form>
  </section>;
}
