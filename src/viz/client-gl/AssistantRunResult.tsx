import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssistantRun, AssistantView } from '../../contracts/assistant.js';
import { api } from '../client/data-api.js';
import { ButtonIcon } from './ButtonIcon.js';
import { RelativeTime } from './RelativeTime.js';
import { parentTestCardLine } from './run-result.js';
import { hostedUpdateOffer, type DeploymentSettingsView } from './project-deployment.js';
import { HostedUpdateOfferSection } from './HostedUpdateOffer.js';

/**
 * The card's headline. A delivery asks to be looked at only while it awaits
 * acceptance: once accepted (or published) it says so, and one that can no
 * longer be accepted (expired, superseded, or its review not read yet) just
 * says it finished (2026-10-26: an accepted card still asked to be accepted).
 */
export function outcomeKey(status: string, review: { clientAcceptance?: unknown; publicationStatus?: string | null } | undefined,
  canAccept: boolean | undefined): string {
  if (status !== 'delivered') return `assistant.outcome.${status}`;
  if (review?.clientAcceptance || review?.publicationStatus === 'published') return 'assistant.outcome.deliveredAccepted';
  return canAccept ? 'assistant.outcome.delivered' : 'assistant.outcome.deliveredSettled';
}

/** Current host receipts, not a generated reply or a rewrite of the conversation journal. */
export function AssistantRunResult({ scopeKey, id, target, run, locale, t, onRun, hosting }: {
  scopeKey: string; target: AssistantRun; run: NonNullable<AssistantView['run']>;
  /** The card's element id, which the conversation's "see the result" control scrolls to. */
  id?: string;
  locale: string;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onRun: (run: AssistantRun, traceId: string | null) => void;
  /** The selected project's hosted application: offered an update once this run is its accepted version. */
  hosting?: { view: DeploymentSettingsView; onActivate: (id: string) => void } | null;
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
  // Accepted and published: the online application may still run an older version.
  const offer = run.status === 'delivered' ? hostedUpdateOffer(hosting?.view, { projectId: target.projectId, projectRunId: target.runId }) : null;

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

  return <article id={id} className="gpu-assistant-message gpu-assistant-message--receipt gpu-assistant-result" aria-label={t('assistant.runResult')}>
    <div className="gpu-assistant-message-meta"><strong>{t('assistant.receipt')}</strong>
      {run.endedAt ? <RelativeTime at={run.endedAt} locale={locale} t={t} /> : null}</div>
    {/* Named as its deployment and activity lines name it, so "accepted" and "put online" read as one version (2026-10-26). */}
    {run.title ? <p><strong>{run.title}</strong></p> : null}
    <p>{run.title ? t(outcomeKey(run.status, review, canAccept)) : <strong>{t(outcomeKey(run.status, review, canAccept))}</strong>}
      {run.costUsd !== null ? ` · $${run.costUsd.toFixed(2)}` : ''}</p>
    {/* The outcome line already says it did not complete; the host's own words stay one click away. */}
    {run.error ? <details className="gpu-assistant-error-details"><summary>{t('assistant.errorDetails')}</summary><p>{run.error}</p></details> : null}
    {review?.verification.acceptanceApproved === true ? <p>{t('assistant.checksApproved')}</p> : null}
    {parentTestsLine ? <p>{parentTestsLine}</p> : null}
    {review?.publicationStatus === 'published' ? <p>{t('assistant.deliveryPublished')}</p>
      : review?.publicationStatus === 'publishing' ? <p role="status">{t('assistant.deliveryPublishing')}</p>
      // The headline already says it was accepted: only an unfinished publication adds a sentence.
      : review?.clientAcceptance ? (publishFiles ? <p>{t('assistant.deliveryAcceptedPending')}</p> : null)
      : canAccept ? <p>{t(publishFiles ? 'assistant.deliveryReady' : 'assistant.deliveryReadyText')}</p> : null}
    {review?.filesState === 'expired' ? <p>{t('assistant.deliveryExpired')}</p> : null}
    {offer && hosting ? <HostedUpdateOfferSection offer={offer} t={t} onActivate={hosting.onActivate} /> : null}
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
