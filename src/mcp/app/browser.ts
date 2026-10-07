import { App } from '@modelcontextprotocol/ext-apps';
import { createInstance } from 'i18next';
import { z } from 'zod';
import { artifactFileResultSchema, artifactPageResultSchema, runViewSchema } from '../../contracts/clientExperience.js';

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
async function call(name: string, args: Record<string, unknown>) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) {
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
  label('refresh', 'refresh'); label('cancel', cancelArmed ? 'confirmCancel' : 'cancel');
  label('criteria-title', 'criteria'); label('files-title', 'files'); label('more-files', 'more'); label('more-text', 'moreText');
  element('note').textContent = t(run?.status === 'partial' ? 'partial' : 'untrusted');
  element('title').textContent = run?.title || run?.goal.slice(0, 160) || 'Atoma';
  element('status').textContent = run ? `${run.status} · ${run.progress?.message ?? ''}` : t('waiting');
  element('activity').textContent = run?.progress?.lastActivityAt
    ? t('lastActivity', { time: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(run.progress.lastActivityAt)) }) : '';
  element('cost').textContent = run?.costUsd != null ? t('cost', { cost: new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(run.costUsd) }) : '';
  button('cancel').hidden = !run?.actions?.canCancel;
  element('receipt').replaceChildren();
  if (run?.publication) {
    element('receipt').append(document.createTextNode(t('publication', { status: run.publication.status }) + ' · '));
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
    download.onclick = () => { void downloadFile(file).catch(showError); };
    li.append(name, open, download); return li;
  }));
  button('more-files').hidden = nextFiles === null;
  document.querySelector('main')!.setAttribute('aria-busy', String(busy));
}
async function loadFiles(append = false) {
  if (!run || !['delivered', 'partial'].includes(run.status)) return;
  const epoch = generation;
  const page = artifactPageResultSchema.parse(await call('atoma_run_artifacts', { ...ref(), offset: append ? nextFiles ?? 0 : 0 }));
  if (epoch !== generation) return;
  files = append ? [...files, ...page.files] : page.files; nextFiles = page.nextOffset; render();
}
async function readFile(file: z.infer<typeof artifactPageResultSchema>['files'][number], more = false) {
  const epoch = generation;
  const selection = ++fileGeneration;
  const previous = selected;
  if (!more) clearPreview();
  const data = artifactFileResultSchema.parse(await call('atoma_run_file', { ...ref(), path: file.path,
    ...(more && previous ? { offset: previous.nextTextOffset, snapshot: previous.snapshot } : {}) }));
  if (epoch !== generation || selection !== fileGeneration) return;
  selected = data;
  element('preview-section').hidden = false;
  element('file-title').textContent = file.path;
  element('text').textContent = data.text ?? t('binary'); element('text').hidden = false;
  button('more-text').hidden = data.nextTextOffset === null;
  if (!more && file.uri && ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(data.mimeType)) {
    const result = await app.readServerResource({ uri: file.uri });
    if (epoch !== generation || selection !== fileGeneration) return;
    const content = result.contents[0];
    if (!content) return;
    const bytes = 'blob' in content ? Uint8Array.from(atob(content.blob), c => c.charCodeAt(0)) : new TextEncoder().encode(content.text);
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
  if (run && ['running', 'queued'].includes(run.status) && !document.hidden) timer = setTimeout(() => { void refresh().catch(showError); }, 5000);
}
async function refresh() {
  if (!run || busy) return;
  const epoch = generation;
  busy = true; button('refresh').disabled = true; element('error').hidden = true;
  try {
    const latest = runViewSchema.parse(await call('atoma_run_status', ref()));
    if (epoch !== generation) return;
    run = latest;
    await loadFiles();
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
  button('cancel').disabled = true;
  void call('atoma_run_cancel', ref()).then(() => refresh()).catch(showError).finally(() => {
    cancelArmed = false; button('cancel').disabled = false; render();
  });
};
app.ontoolresult = result => {
  const parsed = runViewSchema.safeParse(result.structuredContent);
  if (!parsed.success) return;
  generation++; fileGeneration++; cancelArmed = false; clearPreview(); run = parsed.data; files = []; nextFiles = null; render();
  void refresh().catch(showError);
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
