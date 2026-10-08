import { App } from '@modelcontextprotocol/ext-apps';
import { createInstance } from 'i18next';
import { z } from 'zod';
import { artifactFileResultSchema, artifactPageResultSchema, runViewSchema, runReviewSchema, serviceProblemSchema } from '../../contracts/clientExperience.js';
import { reviewCard } from './review.js';
import { questionCard } from './question.js';

const app = new App({ name: 'Atoma run', version: '1.0.0' }, {});
const i18n = createInstance();
const copy = JSON.parse(document.getElementById('copy')!.textContent) as Record<string, { translation: Record<string, string> }>;
void i18n.init({ resources: copy, initAsync: false, lng: 'en', fallbackLng: 'en', keySeparator: false, interpolation: { escapeValue: false } });
const t = (key: string, vars?: Record<string, unknown>) => i18n.t(`mcpApp.${key}`, vars);
const element = (id: string) => document.getElementById(id)!;
const button = (id: string) => element(id) as HTMLButtonElement;
let run: z.infer<typeof runViewSchema> | null = null;
let files: z.infer<typeof artifactPageResultSchema>['files'] = [];
let nextFiles: number | null = null;
let selected: z.infer<typeof artifactFileResultSchema> | null = null;
let imageUrl: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let busy = false;
let cancelArmed = false;
let generation = 0;
let fileGeneration = 0;
let filesReading = false;
const decision = questionCard({ ref, call, t, changed: () => { render(); schedule(); }, error: showError,
  open: async source => {
    const epoch = generation;
    const next = runViewSchema.parse(await call('atoma_run_status', source));
    if (epoch === generation) showRun(next);
  } });

const review = reviewCard({ ref, call, t, changed: () => { render(); schedule(); }, error: showError, refresh: () => refresh(false),
  message: async text => {
    const response = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
    if (response.isError) throw new Error(t('reviewSendUnavailable'));
  } });

function showError(error: unknown) {
  element('error').textContent = error instanceof Error ? error.message : t('failure');
  element('error').hidden = false;
}
function clearPreview() {
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = null;
  selected = null;
  element('preview-section').hidden = true;
  element('image').hidden = true;
  element('text').hidden = true;
}
async function call(name: string, args: Record<string, unknown>, timeout?: number) {
  const result = await app.callServerTool({ name, arguments: args }, timeout ? { timeout } : undefined);
  if (result.isError) {
    const problem = z.object({ error: serviceProblemSchema }).safeParse(result.structuredContent);
    if (problem.success) throw new Error(`${problem.data.error.message} ${problem.data.error.nextAction}`);
    const error = result.content.find(item => item.type === 'text');
    throw new Error(error?.type === 'text' ? error.text : t('failure'));
  }
  if (result.structuredContent) return result.structuredContent;
  const text = result.content.find(item => item.type === 'text');
  if (text?.type !== 'text') throw new Error(t('failure'));
  return JSON.parse(text.text) as unknown;
}
function ref() {
  if (!run) throw new Error(t('waiting'));
  return { projectId: run.projectId, runId: run.projectRunId };
}
function label(id: string, key: string) { element(id).textContent = t(key); }
function render() {
  document.documentElement.lang = i18n.language;
  label('refresh', 'refresh'); label('cancel', cancelArmed ? 'confirmCancel' : 'cancel');
  label('criteria-title', 'criteria'); label('files-title', 'files'); label('more-files', 'more'); label('more-text', 'moreText');
  element('note').textContent = t(run?.status === 'partial' ? 'partial' : 'untrusted');
  element('title').textContent = run?.title || run?.goal.slice(0, 160) || 'Atoma';
  element('status').textContent = decision.statusText ?? (run ? `${run.status} · ${run.progress?.message ?? ''}` : t('waiting'));
  element('activity').textContent = run?.progress?.lastActivityAt
    ? t('lastActivity', { time: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(run.progress.lastActivityAt)) }) : '';
  element('cost').textContent = run?.costUsd != null ? t('cost', { cost: new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(run.costUsd) }) : '';
  button('cancel').hidden = !run?.actions?.canCancel;
  element('receipt').replaceChildren();
  if (run?.publication) {
    element('receipt').append(document.createTextNode(t('publication', { status: run.publication.status }) + ' · '));
    if (run.publication.commitSha) element('receipt').append(document.createTextNode(t('reviewCommit', { commit: run.publication.commitSha, branch: run.publication.git?.branch ?? '—' }) + ' · '));
    if (run.publication.error) element('receipt').append(document.createTextNode(run.publication.error + ' · '));
    if (run.publication.status === 'published') element('receipt').append(document.createTextNode(t('reviewPublished') + ' '));
    const url = run.publication.pullRequestUrl ?? run.publication.repositoryUrl;
    if (url && /^https:\/\/github\.com\//.test(url)) {
      const link = document.createElement('button');
      link.textContent = t(run.publication.pullRequestUrl ? 'openPullRequest' : 'openRepository');
      link.onclick = () => { void app.openLink({ url }).catch(showError); };
      element('receipt').append(link);
    }
  }
  const criteria = run?.progress?.criteria ?? [];
  element('criteria-section').hidden = criteria.length === 0;
  element('criteria').replaceChildren(...criteria.map(item => {
    const li = document.createElement('li');
    li.textContent = `${item.id}: ${item.behaviour} — ${t(item.met === true ? 'met' : item.met === false ? 'notMet' : 'unknown')}${item.reason ? ': ' + item.reason : ''}`;
    return li;
  }));
  element('files-section').hidden = files.length === 0;
  element('files').replaceChildren(...files.map(file => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = `${file.path} (${file.size.toLocaleString(i18n.language)} B)`;
    const open = document.createElement('button'); open.textContent = t('read');
    open.onclick = () => { void readFile(file).catch(showError); };
    const download = document.createElement('button'); download.textContent = t('download');
    download.hidden = !file.uri || !app.getHostCapabilities()?.downloadFile;
    download.onclick = () => { void downloadFile(file).catch(showError); };
    li.append(name, open, download); return li;
  }));
  button('more-files').hidden = nextFiles === null;
  button('more-files').disabled = filesReading;
  decision.render(); review.render();
  document.querySelector('main')!.setAttribute('aria-busy', String(busy));
}
async function loadFiles(append = false) {
  if (!run || !['delivered', 'partial'].includes(run.status) || filesReading) return;
  const epoch = generation;
  filesReading = true; render();
  try {
    const page = artifactPageResultSchema.parse(await call('atoma_run_artifacts', { ...ref(), offset: append ? nextFiles ?? 0 : 0 }));
    if (epoch !== generation) return;
    files = append ? [...files, ...page.files] : page.files; nextFiles = page.nextOffset;
  } catch (error) { if (epoch === generation) throw error; }
  finally { if (epoch === generation) { filesReading = false; render(); } }
}
async function readFile(file: z.infer<typeof artifactPageResultSchema>['files'][number], more = false) {
  const epoch = generation;
  const selection = ++fileGeneration;
  const previous = selected;
  if (!more) clearPreview();
  button('more-text').disabled = true;
  let data: z.infer<typeof artifactFileResultSchema>;
  try { data = artifactFileResultSchema.parse(await call('atoma_run_file', { ...ref(), path: file.path,
    ...(more && previous ? { offset: previous.nextTextOffset, snapshot: previous.snapshot } : {}) }));
  } catch (error) { if (epoch === generation && selection === fileGeneration) throw error; else return; }
  finally { if (epoch === generation && selection === fileGeneration) button('more-text').disabled = false; }
  if (epoch !== generation || selection !== fileGeneration) return;
  selected = data;
  element('preview-section').hidden = false;
  element('file-title').textContent = `${file.path} · ${t('reviewFilePage', { from: data.text?.length ? data.textOffset + 1 : 0, to: data.textOffset + (data.text?.length ?? 0) })}`;
  element('text').textContent = data.text ?? t('binary'); element('text').hidden = false;
  button('more-text').hidden = data.nextTextOffset === null;
  if (!more && file.uri && ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(data.mimeType)) {
    const result = await app.readServerResource({ uri: file.uri });
    if (epoch !== generation || selection !== fileGeneration) return;
    const content = result.contents[0];
    if (!content) return;
    const bytes = 'blob' in content ? Uint8Array.from(atob(content.blob), c => c.charCodeAt(0)) : new TextEncoder().encode(content.text);
    element('file-title').textContent = file.path;
    imageUrl = URL.createObjectURL(new Blob([bytes], { type: data.mimeType }));
    const image = element('image') as HTMLImageElement; image.src = imageUrl; image.alt = file.path; image.hidden = false;
    element('text').hidden = true;
    button('more-text').hidden = true;
  }
}
async function downloadFile(file: z.infer<typeof artifactPageResultSchema>['files'][number]) {
  if (!file.uri || !app.getHostCapabilities()?.downloadFile) throw new Error(t('downloadUnavailable'));
  const result = await app.readServerResource({ uri: file.uri });
  const response = await app.downloadFile({ contents: result.contents.map(resource => ({ type: 'resource' as const, resource })) });
  if (response.isError) throw new Error(t('downloadUnavailable'));
}
function schedule() {
  clearTimeout(timer);
  if (run && (['running', 'queued'].includes(run.status) || decision.waiting || review.waiting) && !document.hidden) timer = setTimeout(() => { void refresh().catch(showError); }, 5000);
}
async function refresh(clearError = true) {
  if (!run || busy) return;
  const epoch = generation;
  busy = true; button('refresh').disabled = true; if (clearError) element('error').hidden = true;
  try {
    const latest = runViewSchema.parse(await call('atoma_run_status', ref()));
    if (epoch !== generation) return;
    run = latest;
    const reads = [decision.load()];
    if (!['queued', 'running'].includes(run.status)) reads.push(review.load());
    reads.push(loadFiles());
    const results = await Promise.allSettled(reads);
    if (epoch === generation) for (const result of results) if (result.status === 'rejected') showError(result.reason);
  } catch (error) {
    if (epoch === generation) { review.invalidate(); decision.invalidate(); showError(error); }
  } finally {
    busy = false; button('refresh').disabled = false; render(); schedule();
    if (epoch !== generation) void refresh().catch(showError);
  }
}
button('refresh').onclick = () => { cancelArmed = false; void refresh().catch(showError); };
button('more-files').onclick = () => { void loadFiles(true).catch(showError); };
button('more-text').onclick = () => { if (selected) void readFile(selected, true).catch(showError); };
button('cancel').onclick = () => {
  if (!cancelArmed) { cancelArmed = true; render(); return; }
  const epoch = generation;
  button('cancel').disabled = true;
  void call('atoma_run_cancel', ref()).then(() => { if (epoch === generation) return refresh(); }).catch(error => { if (epoch === generation) showError(error); }).finally(() => {
    if (epoch !== generation) return;
    cancelArmed = false; button('cancel').disabled = false; render();
  });
};
function showRun(next: z.infer<typeof runViewSchema>) {
  if (run?.projectId === next.projectId && run.projectRunId === next.projectRunId) {
    run = next; render(); void refresh().catch(showError); return;
  }
  generation++; fileGeneration++; filesReading = false; cancelArmed = false; decision.reset(); review.reset(); button('cancel').disabled = false; element('error').hidden = true; clearPreview(); run = next; files = []; nextFiles = null; render();
  void refresh().catch(showError);
}
app.ontoolresult = result => {
  const parsed = runViewSchema.safeParse(result.structuredContent);
  if (parsed.success) { showRun(parsed.data); return; }
  const reviewed = runReviewSchema.safeParse(result.structuredContent);
  if (reviewed.success) showRun({ ...reviewed.data.run, progress: reviewed.data.verification });
};
app.onhostcontextchanged = context => {
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
  if (context.locale) void i18n.changeLanguage(context.locale.split('-')[0]).then(() => render());
};
document.addEventListener('visibilitychange', schedule);
window.addEventListener('pagehide', () => { clearTimeout(timer); clearPreview(); });
render();
void app.connect().then(async () => {
  const context = app.getHostContext();
  if (context?.theme) document.documentElement.style.colorScheme = context.theme;
  if (context?.locale) await i18n.changeLanguage(context.locale.split('-')[0]);
  render();
}).catch(() => showError(new Error(t('connectFailed'))));
