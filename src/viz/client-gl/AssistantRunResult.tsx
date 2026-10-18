import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssistantRun, AssistantView } from '../../contracts/assistant.js';
import { api } from '../client/data-api.js';
import { ButtonIcon } from './ButtonIcon.js';
import { relativeTime, timestampTooltip } from './renderer/relative-time.js';
import { parentTestCardLine } from './run-result.js';

/** Current host receipts, not a generated reply or a rewrite of the conversation journal. */
export function AssistantRunResult({ scopeKey, target, run, locale, now, t, onRun }: {
  scopeKey: string; target: AssistantRun; run: NonNullable<AssistantView['run']>;
  locale: string; now: number;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onRun: (run: AssistantRun, traceId: string | null) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['viz', 'run-review', scopeKey, target.projectId, target.runId],
    queryFn: () => api.runReview(target.projectId, target.runId),
    enabled: run.status === 'delivered', retry: false, refetchInterval: 5000,
  });
  const review = query.data;
  const parentTestsLine = parentTestCardLine(review?.parentTests, t);
  const [reviewText, setReviewText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const publishFiles = review?.delivery === 'files' && (review.files?.total ?? 0) > 0;
  const canAccept = run.status === 'delivered' && review?.canRequestAcceptance && !!review.run.artifactManifestHash;

  async function accept(retry = false) {
    if (inFlight.current || query.isError || !review || (retry ? !review.canRetryPublication : !canAccept || !reviewText.trim())) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      if (retry) await api.retryPublication(target.projectId, target.runId);
      else await api.acceptDelivery(target.projectId, target.runId, {
        manifestHash: review.run.artifactManifestHash!, review: reviewText.trim(),
      });
      setConfirming(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('assistant.deliveryFailed'));
    } finally {
      // Acceptance may have persisted even when publication failed or the response was lost.
      await query.refetch();
      for (const key of ['projects', 'project', 'runs', 'assistant']) void client.invalidateQueries({ queryKey: ['viz', key] });
      inFlight.current = false; setBusy(false);
    }
  }

  return <article className="gpu-assistant-message gpu-assistant-message--receipt gpu-assistant-result" aria-label={t('assistant.runResult')}>
    <div className="gpu-assistant-message-meta"><strong>{t('assistant.receipt')}</strong>
      {run.endedAt ? <time dateTime={run.endedAt} title={timestampTooltip(run.endedAt, locale) ?? run.endedAt}>
        {relativeTime(run.endedAt, t, locale, now) || run.endedAt}</time> : null}</div>
    <p><strong>{t(`assistant.outcome.${run.status}`)}</strong>
      {run.costUsd !== null ? ` · $${run.costUsd.toFixed(2)}` : ''}</p>
    {run.error ? <p>{run.error}</p> : null}
    {review?.verification.acceptanceApproved === true ? <p>{t('assistant.checksApproved')}</p> : null}
    {parentTestsLine ? <p>{parentTestsLine}</p> : null}
    {review?.publicationStatus === 'published' ? <p>{t('assistant.deliveryPublished')}</p>
      : review?.publicationStatus === 'publishing' ? <p role="status">{t('assistant.deliveryPublishing')}</p>
      : review?.clientAcceptance ? <p>{t(publishFiles ? 'assistant.deliveryAcceptedPending' : 'assistant.deliveryAccepted')}</p>
      : canAccept ? <p>{t(publishFiles ? 'assistant.deliveryReady' : 'assistant.deliveryReadyText')}</p> : null}
    {review?.filesState === 'expired' ? <p>{t('assistant.deliveryExpired')}</p> : null}
    <div className="gpu-assistant-message-actions">
      <button type="button" onClick={() => onRun(target, run.traceId)}><ButtonIcon kind="play" />{t('assistant.openRun')}</button>
      {canAccept && !confirming ? <button type="button" disabled={busy || query.isError} onClick={() => setConfirming(true)}>
        {t(publishFiles ? 'assistant.reviewAndPublish' : 'assistant.reviewAndAccept')}</button> : null}
      {review?.canRetryPublication ? <button type="button" disabled={busy || query.isError} onClick={() => void accept(true)}>{t('assistant.retryPublish')}</button> : null}
    </div>
    {canAccept && confirming ? <form aria-busy={busy} onSubmit={event => { event.preventDefault(); void accept(); }}>
      <label htmlFor="assistant-delivery-review">{t('assistant.deliveryReview')}</label>
      <textarea id="assistant-delivery-review" value={reviewText} onChange={event => setReviewText(event.target.value)}
        placeholder={t('assistant.deliveryReviewHint')} maxLength={2000} rows={2} disabled={busy} required />
      <div className="gpu-assistant-message-actions">
        <button type="submit" className="gpu-assistant-primary" disabled={busy || query.isError || !reviewText.trim()}>
          {t(publishFiles ? 'assistant.acceptAndPublish' : 'assistant.acceptDelivery')}</button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)}>{t('assistant.cancelDeliveryReview')}</button>
      </div>
    </form> : null}
    {busy ? <p role="status">{t('assistant.deliverySaving')}</p> : null}
    {query.isError ? <p role="alert">{t('assistant.deliveryReadFailed')} <button type="button" onClick={() => void query.refetch()}>{t('assistant.retry')}</button></p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </article>;
}
