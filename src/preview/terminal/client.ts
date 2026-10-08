import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { TERMINAL_UPLOAD_BYTES, terminalOutputSchema } from '../../contracts/previewTerminal.js';

const labels = await fetch('/labels.json').then((res) => res.json()) as Record<string, Record<string, string>>;
const language = navigator.language.split('-')[0] ?? 'en';
const t = (key: string) => labels[language]?.[key] || labels['en']?.[key] || key;
for (const element of document.querySelectorAll<HTMLElement>('[data-label]')) element.textContent = t(element.dataset['label']!);
const status = document.querySelector<HTMLElement>('#status')!;
const terminal = new Terminal({ cursorBlink: true, scrollback: 3000, screenReaderMode: true,
  fontFamily: 'ui-monospace, monospace', fontSize: 14,
  theme: { background: '#081b24', foreground: '#e2edf2', cursor: '#18cce6' },
  linkHandler: { activate: () => undefined },
});
// Escape sequences from executed code never gain clipboard access.
terminal.parser.registerOscHandler(52, () => true);
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.querySelector<HTMLElement>('#terminal')!);
terminal.focus();
let cursor = 0;
let alive = true;
let queue = Promise.resolve();
let pendingInput = 0;
const encoder = new TextEncoder();
async function post(path: string, bytes: BodyInit): Promise<void> {
  const result = await fetch(path, { method: 'POST', headers: { 'x-atoma-terminal': '1' }, body: bytes, signal: AbortSignal.timeout(5000) });
  if (!result.ok) throw new Error('request-failed');
}
function input(value: string): void {
  if (!alive) return;
  const bytes = encoder.encode(value);
  if (pendingInput + bytes.length > 65536) { status.textContent = t('inputLimit'); return; }
  pendingInput += bytes.length;
  queue = queue.then(async () => {
    for (let offset = 0; offset < bytes.length; offset += 8192) await post('/input', bytes.slice(offset, offset + 8192));
  }).catch(() => { status.textContent = t('connectionFailed'); })
    .finally(() => { pendingInput -= bytes.length; });
}
terminal.onData(input);
const resize = () => {
  fit.fit();
  if (alive) void post('/resize', JSON.stringify({ cols: terminal.cols, rows: terminal.rows })).catch(() => { status.textContent = t('connectionFailed'); });
};
new ResizeObserver(resize).observe(document.querySelector<HTMLElement>('#terminal')!);
resize();
document.querySelector('#interrupt')!.addEventListener('click', () => { input('\x03'); terminal.focus(); });
document.querySelector<HTMLInputElement>('#upload')!.addEventListener('change', (event) => {
  const field = event.currentTarget as HTMLInputElement;
  const file = field.files?.[0];
  if (!file) return;
  if (file.size > TERMINAL_UPLOAD_BYTES) { status.textContent = t('uploadLimit'); field.value = ''; return; }
  void post(`/upload?name=${encodeURIComponent(file.name)}`, file)
    .then(() => { status.textContent = `${t('uploaded')} ${file.name}`; })
    .catch(() => { status.textContent = t('uploadFailed'); }).finally(() => { field.value = ''; });
});
async function poll(): Promise<void> {
  if (!alive) return;
  try {
    const result = await fetch(`/output?after=${cursor}`, { signal: AbortSignal.timeout(5000) });
    if (!result.ok) throw new Error('unavailable');
    const chunk = terminalOutputSchema.parse(await result.json());
    if (chunk.truncated) terminal.writeln(`\r\n${t('truncated')}\r\n`);
    await new Promise<void>((done) => terminal.write(Uint8Array.from(atob(chunk.data), (ch) => ch.charCodeAt(0)), done));
    cursor = chunk.cursor;
    if (chunk.exitCode !== null && chunk.data.length === 0) {
      alive = false;
      status.textContent = `${t('exited')} ${chunk.exitCode}. ${t('restartHint')}`;
      return;
    }
    window.setTimeout(() => { void poll(); }, chunk.data ? 30 : 200);
  } catch {
    // Never replay keystrokes after uncertain delivery. Reopening goes through
    // the authenticated parent and obtains a fresh grant.
    alive = false;
    status.textContent = t('connectionFailed');
  }
}
window.addEventListener('pagehide', () => { alive = false; });
void poll();
