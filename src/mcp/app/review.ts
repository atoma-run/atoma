import { z } from 'zod';
import { runReviewSchema, runComparisonResultSchema, traceDetailPageSchema, type RunReview } from '../../contracts/clientExperience.js';
import { acceptDeliveryInputSchema } from '../../contracts/projects.js';

type Options = {
  ref: () => { projectId: string; runId: string };
  call: (name: string, args: Record<string, unknown>, timeout?: number) => Promise<unknown>;
  t: (key: string, vars?: Record<string, unknown>) => string;
  changed: () => void;
  error: (error: unknown) => void;
  refresh: () => Promise<void>;
  message: (text: string) => Promise<void>;
};

/** Saved evidence and explicit client consent. No read starts a preview, run or publication. */
export function reviewCard(options: Options) {
  const el = (id: string) => document.getElementById(`review-${id}`)!;
  const btn = (id: string) => el(id) as HTMLButtonElement;
  const summary = el('summary') as HTMLTextAreaElement;
  const consent = el('consent') as HTMLInputElement;
  const feedback = el('feedback') as HTMLTextAreaElement;
  const draft = el('draft') as HTMLTextAreaElement;
  let view: RunReview | null = null;
  let comparison: RunReview['comparison'] = null;
  let detail: z.infer<typeof traceDetailPageSchema> | null = null;
  let resultText: string | null = '';
  let pending: z.infer<typeof acceptDeliveryInputSchema> | null = null;
  let epoch = 0;
  let readId = 0;
  let working = false;
  let comparing = false;
  let reading = false;
  let messaging = false;
  let unavailable = false;
  let reviewedHash: string | null | undefined;
  const changed = () => { render(); options.changed(); };

  function render() {
    document.getElementById('review')!.hidden = !view;
    if (!view) return;
    for (const [id, key] of Object.entries({ title: 'reviewTitle', evidence: 'reviewEvidence',
      'summary-label': 'reviewSummary', 'feedback-label': 'reviewFeedback', changes: 'reviewChanges',
      test: 'reviewTest', result: 'reviewResult', 'result-more': 'moreText', 'compare-more': 'more',
      retry: 'reviewRetryPublication', 'draft-label': 'reviewDraft', 'identity-title': 'reviewIdentityTitle' })) el(id).textContent = options.t(key);
    el('identity').textContent = options.t('reviewIdentity', { run: view.run.projectRunId, hash: view.run.artifactManifestHash ?? '—' });
    el('files-state').textContent = options.t(view.delivery === 'text' ? 'reviewTextDelivery' : `reviewFiles_${view.filesState}`);
    el('consent-copy').textContent = options.t(view.delivery === 'text' ? 'reviewConsentText' : 'reviewConsentFiles');
    el('acceptance').textContent = view.clientAcceptance
      ? options.t('reviewAccepted', { at: new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(view.clientAcceptance.acceptedAt)), review: view.clientAcceptance.review })
      : options.t(view.publicationStatus === 'published' ? 'reviewHistorical' : 'reviewNotAccepted');
    el('accept-form').hidden = !view.canRequestAcceptance;
    summary.disabled = consent.disabled = working || unavailable || !!pending;
    btn('accept').disabled = working || unavailable || (!pending && (!consent.checked || !summary.value.trim()));
    btn('accept').textContent = options.t(working ? 'reviewSaving' : pending ? 'reviewRetryAcceptance'
      : view.delivery === 'text' ? 'reviewAcceptText' : 'reviewAcceptFiles');
    btn('retry').hidden = !view.canRetryPublication;
    btn('retry').disabled = working || unavailable;
    btn('test').hidden = !view.nextSteps.some(step => step.tool === 'atoma_run_preview');
    btn('test').disabled = btn('changes').disabled = messaging || unavailable;
    el('comparison').textContent = comparison ? options.t('reviewCompared', { base: comparison.baseRunId, ...comparison.counts })
      : options.t(`reviewComparison_${view.comparisonState}`);
    el('comparison-note').textContent = comparison ? options.t('reviewComparisonPage', { from: comparison.files.length ? (comparison.nextOffset ?? comparison.total) - comparison.files.length + 1 : 0, to: comparison.nextOffset ?? comparison.total, total: comparison.total }) + ' ' + comparison.note : '';
    el('comparison-files').replaceChildren(...(comparison?.files ?? []).map(file => {
      const item = document.createElement('li'); item.textContent = `${options.t(`reviewChange_${file.change}`)} · ${file.path}`; return item;
    }));
    btn('compare-more').hidden = comparison?.nextOffset == null;
    btn('compare-more').disabled = comparing;
    btn('result').disabled = btn('result-more').disabled = reading;
    btn('result-more').hidden = detail?.nextTextOffset == null;
    el('result-page').hidden = !detail;
    if (detail) {
      let display = detail.text;
      if (detail.nextTextOffset === null && resultText !== null) {
        try {
          const parsed = JSON.parse(resultText) as unknown;
          const answer = z.object({ result: z.object({ output: z.unknown() }) }).safeParse(parsed);
          display = answer.success && typeof answer.data.result.output === 'string' ? answer.data.result.output : JSON.stringify(parsed, null, 2);
        } catch { /* An incomplete or malformed host payload remains literal evidence. */ }
      }
      el('result-text').textContent = display;
      el('result-range').textContent = options.t('reviewResultRange', { from: detail.nextTextOffset === null && resultText !== null ? 1 : detail.textOffset + 1,
        to: detail.textOffset + detail.text.length, total: detail.totalChars });
    }
    el('state').textContent = unavailable ? options.t('reviewUnavailable') : working ? options.t('reviewSaving') : '';
  }

  async function load() {
    const token = epoch;
    const request = ++readId;
    try {
      const next = runReviewSchema.parse(await options.call('atoma_run_review', options.ref()));
      if (token !== epoch || request !== readId) return;
      if (reviewedHash !== next.run.artifactManifestHash) {
        reviewedHash = next.run.artifactManifestHash; pending = null; consent.checked = false; summary.value = '';
      }
      if (next.clientAcceptance) pending = null;
      if (next.comparison?.snapshot !== comparison?.snapshot) comparison = next.comparison;
      view = next; unavailable = false; render();
    } catch (error) {
      if (token === epoch && request === readId) { unavailable = true; render(); }
      throw error;
    }
  }

  async function publish(retry: boolean) {
    if (!view || working || unavailable || !(retry ? view.canRetryPublication : view.canRequestAcceptance)) return;
    if (!retry && !pending) {
      if (!consent.checked) return;
      const parsed = acceptDeliveryInputSchema.safeParse({ manifestHash: view.run.artifactManifestHash, review: summary.value.trim() });
      if (!parsed.success) { options.error(new Error(options.t('reviewRequired'))); return; }
      pending = parsed.data;
    }
    const token = epoch;
    const source = options.ref();
    working = true; changed();
    try {
      await options.call(retry ? 'atoma_publication_retry' : 'atoma_run_accept', { ...source, ...(!retry ? pending : {}) }, 180_000);
    } catch (error) {
      if (token === epoch) options.error(error);
    } finally {
      // The write may have committed before a timeout. Read its durable receipt before offering another action.
      if (token === epoch) {
        try { await load(); } catch (error) { if (token === epoch) options.error(error); }
        if (token === epoch) {
          working = false; changed();
          await options.refresh().catch(error => { if (token === epoch) options.error(error); });
        }
      }
    }
  }
  summary.oninput = consent.onchange = render;
  btn('accept').onclick = () => { void publish(false); };
  btn('retry').onclick = () => { void publish(true); };

  async function readResult(more: boolean) {
    if (reading) return;
    const token = epoch;
    if (!more) { detail = null; resultText = ''; }
    reading = true; render();
    try {
      const raw = await options.call('atoma_run_trace', { runId: options.ref().runId, section: 'result',
        ...(more && detail ? { snapshot: detail.snapshot, textOffset: detail.nextTextOffset } : {}) });
      if (token !== epoch) return;
      const parsed = traceDetailPageSchema.safeParse(raw);
      if (!parsed.success) {
        detail = null;
        const note = z.object({ note: z.string() }).safeParse(raw);
        throw new Error(note.success ? note.data.note : options.t('failure'));
      }
      if (resultText !== null) resultText = resultText.length + parsed.data.text.length <= 240_000 ? resultText + parsed.data.text : null;
      detail = parsed.data;
    } catch (error) { if (token === epoch) options.error(error); }
    finally { if (token === epoch) { reading = false; render(); } }
  }
  btn('result').onclick = () => { void readResult(false); };
  btn('result-more').onclick = () => { void readResult(true); };
  btn('compare-more').onclick = () => {
    if (!comparison || comparison.nextOffset === null || comparing) return;
    const token = epoch;
    comparing = true; render();
    void options.call('atoma_run_compare', { ...options.ref(), baseRunId: comparison.baseRunId,
      snapshot: comparison.snapshot, offset: comparison.nextOffset, limit: 30 })
      .then(raw => { if (token === epoch) comparison = runComparisonResultSchema.parse(raw); })
      .catch(error => { if (token === epoch) options.error(error); })
      .finally(() => { if (token === epoch) { comparing = false; render(); } });
  };

  async function handoff(test: boolean) {
    if (!view || messaging || unavailable) return;
    if (!test && !feedback.value.trim()) { options.error(new Error(options.t('reviewFeedbackRequired'))); return; }
    const token = epoch;
    const source = options.ref();
    // This is a conversation request, never authority to launch or accept a delivery.
    const text = options.t(test ? 'reviewTestPrompt' : 'reviewChangesPrompt', { ...source, feedback: feedback.value.trim() });
    draft.value = text; el('handoff').hidden = false;
    messaging = true; render();
    try {
      await options.message(text);
      if (token === epoch) el('handoff-state').textContent = options.t('reviewSent');
    } catch {
      if (token === epoch) el('handoff-state').textContent = options.t('reviewSendUnavailable');
    } finally { if (token === epoch) { messaging = false; render(); } }
  }
  btn('test').onclick = () => { void handoff(true); };
  btn('changes').onclick = () => { void handoff(false); };
  return { load, render,
    invalidate() { unavailable = true; render(); },
    get waiting() { return working || view?.publicationStatus === 'publishing'; },
    reset() {
      epoch++; view = null; comparison = null; detail = null; resultText = ''; pending = null; reviewedHash = undefined;
      working = comparing = reading = messaging = unavailable = false; summary.value = feedback.value = draft.value = '';
      consent.checked = false; el('handoff').hidden = true; el('handoff-state').textContent = ''; render();
    },
  };
}
