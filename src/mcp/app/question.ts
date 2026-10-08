import { clientAnswerSchema, clientQuestionViewSchema, type ClientQuestionView, type AnswerClientQuestion } from '../../contracts/clientQuestion.js';

type RunRef = { projectId: string; runId: string };
type Options = {
  ref: () => RunRef;
  call: (name: string, args: Record<string, unknown>, timeout?: number) => Promise<unknown>;
  t: (key: string, vars?: Record<string, unknown>) => string;
  changed: () => void;
  error: (error: unknown) => void;
  open: (ref: RunRef) => Promise<void>;
};

/** The host owns decisions and continuation identity; this form only submits a user's choice. */
export function questionCard(options: Options) {
  const el = (id: string) => document.getElementById(`decision-${id}`)!;
  const form = el('form');
  const submit = el('submit') as HTMLButtonElement;
  const text = el('text') as HTMLTextAreaElement;
  const open = el('open') as HTMLButtonElement;
  let view: ClientQuestionView | null = null;
  let epoch = 0;
  let readId = 0;
  let builtId: string | undefined;
  let pending: AnswerClientQuestion | null = null;
  let working: 'saving' | 'resuming' | null = null;
  let unavailable = false;
  const current = (token: number) => token === epoch;
  const changed = () => { render(); options.changed(); };

  function render() {
    const record = view?.question;
    document.getElementById('decision')!.hidden = !record;
    if (!record || !view) return;
    const answer = record.answer;
    el('title').textContent = options.t(answer ? 'decisionRecorded' : 'decisionTitle');
    el('question').textContent = record.question.question;
    el('why').textContent = record.question.whyClient;
    el('legend').textContent = options.t('decisionLegend');
    el('other-copy').textContent = options.t('decisionOther');
    el('text-label').textContent = options.t('decisionText');
    el('hint').textContent = options.t('decisionHint');
    if (builtId !== record.questionId) {
      builtId = record.questionId; text.value = ''; pending = null;
      (form.querySelector('input[value=""]') as HTMLInputElement).checked = false;
      el('choices').replaceChildren(...record.question.options.map(choice => {
        const label = document.createElement('label');
        const radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'decision'; radio.value = choice.id;
        const words = document.createElement('span'); words.append(document.createTextNode(choice.label));
        const consequence = document.createElement('small'); consequence.textContent = choice.consequence;
        words.append(consequence); label.append(radio, words); return label;
      }));
    }
    el('answer').hidden = !answer;
    if (answer) {
      const choice = record.question.options.find(item => item.id === answer.value.optionId);
      el('answer').textContent = options.t('decisionAnswer', { answer: [choice?.label, answer.value.text].filter(Boolean).join(' — ') });
    }
    const editable = !answer && view.canAnswer;
    el('options').hidden = el('text-label').hidden = text.hidden = !editable;
    (el('options') as HTMLFieldSetElement).disabled = !!working || !!pending || unavailable;
    text.disabled = !!working || !!pending || unavailable;
    form.hidden = !(editable || view.canResume || working);
    submit.disabled = !!working || unavailable;
    submit.textContent = options.t(answer ? 'decisionResume' : pending ? 'decisionRetry' : 'decisionSubmit');
    el('state').textContent = options.t(unavailable ? 'decisionUnavailable' : working === 'saving' ? 'decisionSaving'
      : working === 'resuming' ? 'decisionResuming' : answer ? 'decisionSaved' : editable ? 'decisionWaiting' : 'decisionReadOnly');
    open.hidden = !view.continuation;
    open.textContent = options.t('decisionOpen', { status: view.continuation?.status ?? '' });
  }

  async function load() {
    const token = epoch;
    const request = ++readId;
    try {
      const next = clientQuestionViewSchema.parse(await options.call('atoma_run_question', options.ref()));
      if (!current(token) || request !== readId) return;
      view = next; unavailable = false;
      if (view.question?.answer) pending = null;
      render();
    } catch (error) {
      if (current(token) && request === readId) { unavailable = true; render(); }
      throw error;
    }
  }

  submit.onclick = event => {
    event.preventDefault();
    if (!view?.question || working || unavailable) return;
    const token = epoch;
    const source = options.ref();
    const record = view.question;
    if (!record.answer && !view.canAnswer || record.answer && !view.canResume) return;
    if (!record.answer && !pending) {
      const optionId = form.querySelector<HTMLInputElement>('input:checked')?.value;
      const answer = clientAnswerSchema.safeParse({ ...(optionId ? { optionId } : {}), ...(text.value.trim() ? { text: text.value.trim() } : {}) });
      if (!answer.success) { options.error(new Error(options.t('decisionRequired'))); return; }
      pending = { questionId: record.questionId, idempotencyKey: crypto.randomUUID(), answer: answer.data };
    }
    working = record.answer ? 'resuming' : 'saving'; changed();
    void (async () => {
      if (!record.answer) {
        // Keep this exact payload on uncertain transport failures; never manufacture a new answer retry.
        await options.call('atoma_run_answer', { ...source, ...pending });
        if (!current(token)) return;
        await load();
        if (!current(token) || !view?.question?.answer || !view.canResume) return;
      }
      working = 'resuming'; changed();
      // Apps proxy ordinary tools/call. The existing synchronous resume waits for the run;
      // refresh reads its durable successor meanwhile, including after a host timeout/reconnect.
      await options.call('atoma_run_resume', source, 10_800_000);
      if (current(token)) await load();
    })().catch(async error => {
      if (current(token)) {
        options.error(error);
        if (working === 'resuming') await load().catch(failure => { if (current(token)) options.error(failure); });
      }
    }).finally(() => {
      if (current(token)) { working = null; changed(); }
    });
  };
  open.onclick = () => {
    if (view?.continuation) void options.open({ projectId: view.projectId, runId: view.continuation.runId }).catch(options.error);
  };
  return {
    load, render,
    invalidate() { unavailable = true; render(); },
    get waiting() { return !!working || !!view?.waitingForClient; },
    get statusText() { return working === 'resuming' ? options.t('decisionResuming') : view?.waitingForClient ? options.t('decisionWaiting') : null; },
    reset() { epoch++; view = null; working = null; pending = null; builtId = undefined; unavailable = false; render(); },
  };
}
