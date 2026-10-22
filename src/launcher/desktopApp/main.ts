import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, shell, Tray, utilityProcess, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeDesktopCommandSchema, computeDesktopLinkSchema, computeDesktopStateSchema, computeDesktopUpdateActionSchema, type ComputeDesktopCommand, type ComputeDesktopState } from '../../contracts/computeDesktop.js';
import { z } from 'zod';
import { DesktopUpdates } from './updates.js';
import { autoUpdater } from 'electron-updater';
import { translate } from '../../viz/client/i18n-catalog.js';
import { isLocale, SUPPORTED_LOCALES, type Locale } from '../../contracts/locales.js';
let selectedLocale: Locale | undefined;
const t = (key: string) => { const language = selectedLocale ?? app.getLocale().split('-')[0]; return translate(isLocale(language) ? language : 'en', `compute.app.${key}`); };
declare const DESKTOP_SIGNED: boolean;

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayIcons: { idle: Electron.NativeImage; ready: Electron.NativeImage } | undefined;
function refreshTray(): void {
  if (!tray || !trayIcons) return;
  const ready = state?.connected && state.phase === 'connected' && state.accepting && !state.issue
    && !state.allocations.some(allocation => allocation.state === 'unconfirmed');
  tray.setImage(ready ? trayIcons.ready : trayIcons.idle);
  tray.setToolTip(ready ? `Atoma Compute — ${t('readyTitle')}` : 'Atoma Compute');
}
function createTrayIcons(): NonNullable<typeof trayIcons> {
  const source = nativeImage.createFromPath(join(root, 'icon.png'));
  const createBadge = (fill: readonly number[]): Electron.NativeImage => {
    const icon = nativeImage.createEmpty();
    for (const scaleFactor of [1, 2]) {
      const size = 20 * scaleFactor;
      const bitmap = source.resize({ width: size, height: size }).toBitmap();
      // NativeImage bitmaps use BGRA. A dark rim keeps both badge colors distinct on light menus.
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const distance = Math.hypot((x + 0.5) / scaleFactor - 16, (y + 0.5) / scaleFactor - 16);
        const coverage = Math.max(0, Math.min(1, (3.5 - distance) * scaleFactor));
        if (!coverage) continue;
        const color = distance < 2.5 ? fill : [38, 23, 13];
        const offset = (y * size + x) * 4;
        for (let channel = 0; channel < 3; channel++) bitmap[offset + channel] = Math.round(color[channel]! * coverage + bitmap[offset + channel]! * (1 - coverage));
        bitmap[offset + 3] = Math.round(255 * coverage + bitmap[offset + 3]! * (1 - coverage));
      }
      const image = nativeImage.createFromBitmap(bitmap, { width: size, height: size });
      icon.addRepresentation({ scaleFactor, buffer: image.toPNG() });
    }
    return icon;
  };
  return { idle: createBadge([156, 163, 175]), ready: createBadge([94, 197, 34]) };
}
let worker: Electron.UtilityProcess;
let workerAlive = false;
let runtimeLost = false;
let state: ComputeDesktopState | undefined;
let quitting = false, asking = false, sequence = 0;
const pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
const root = __dirname;
const page = pathToFileURL(join(root, 'index.html')).href;
let updateTimer: ReturnType<typeof setInterval> | undefined;
const updates = new DesktopUpdates(app.isPackaged && DESKTOP_SIGNED, {
  check: async () => {
    const result = await autoUpdater.checkForUpdates();
    return result?.isUpdateAvailable ? result.updateInfo.version : null;
  },
  download: () => autoUpdater.downloadUpdate(),
  command: send, runtime: () => state,
  changed: value => window?.webContents.send('compute:update-state', value),
  install: () => {
    // The utility process has confirmed idle teardown before reaching this callback.
    quitting = true;
    try { autoUpdater.quitAndInstall(false, true); }
    catch (error) { quitting = false; throw error; }
  },
});
const links = { atoma: 'https://atoma.run/', docker: 'https://www.docker.com/products/docker-desktop/', updates: 'https://github.com/atoma-run/atoma/releases' };
function send(command: ComputeDesktopCommand): Promise<void> {
  if (runtimeLost && command.action === 'disconnect') return Promise.reject(new Error('Workload stop remains unconfirmed'));
  if (!workerAlive && command.action === 'connect') startWorker();
  if (!workerAlive || pending.size >= 8) return Promise.reject(new Error('Compute unavailable'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Compute operation unconfirmed')); }, 120_000);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, command });
  });
}
function startWorker(): void {
    const smoke = !app.isPackaged && process.argv.includes('--compute-smoke');
    workerAlive = true;
    worker = utilityProcess.fork(join(root, smoke ? 'runtime-smoke.mjs' : 'runtime.mjs'), [app.getVersion()], { serviceName: 'Atoma Compute runtime', stdio: 'ignore' });
    worker.on('message', (message: unknown) => {
      const result = z.object({ kind: z.string() }).passthrough().safeParse(message);
      if (!result.success) return;
      if (result.data.kind === 'state') {
        const next = computeDesktopStateSchema.safeParse(result.data.state);
        if (!next.success) return;
        if (next.data.connected) runtimeLost = false;
        state = runtimeLost ? { ...next.data, issue: 'stop-unconfirmed' } : next.data; window?.webContents.send('compute:state', state);
        refreshTray();
        void updates.advance();
      } else if (result.data.kind === 'pairing') {
        const url = result.data.url;
        if (typeof url === 'string' && /^https:\/\/atoma\.run\/compute\/pair\?code=[A-Za-z0-9_-]{22}$/.test(url)) void shell.openExternal(url);
      } else if (result.data.kind === 'reply') {
        const item = pending.get(Number(result.data.id));
        if (item) { clearTimeout(item.timer); pending.delete(Number(result.data.id)); if (result.data.ok === true) item.resolve(); else item.reject(new Error('Compute operation unavailable')); }
      }
    });
    worker.on('exit', () => {
      workerAlive = false;
      if (!quitting) runtimeLost = true;
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Compute runtime exited')); } pending.clear();
      if (!quitting && state) { state = { ...state, phase: 'error', connected: false, issue: 'stop-unconfirmed' }; window?.webContents.send('compute:state', state); refreshTray(); void updates.advance(); show(); }
    });
}
function authorize(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('Untrusted desktop caller');
}
function show() { if (window) { window.show(); window.focus(); } }
async function quit() {
  if (asking || quitting) return;
  asking = true;
  try {
    if (state && !['idle', 'error'].includes(state.phase)) {
      const result = await dialog.showMessageBox({ type: 'question', title: 'Atoma Compute', message: t('quitTitle'), detail: t('quitBody'), buttons: [t('keepRunning'), t('quit')], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
    }
    await send({ action: 'disconnect' });
    quitting = true; app.quit();
  } catch { show(); await dialog.showMessageBox({ type: 'error', title: 'Atoma Compute', message: t('issue.stop-unconfirmed'), detail: t('quitFailed'), buttons: [t('ok')] }); }
  finally { asking = false; }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('will-quit', () => { if (updateTimer) clearInterval(updateTimer); if (workerAlive) worker.kill(); tray?.destroy(); });
  app.on('second-instance', show);
  app.on('activate', show);
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quit(); } });
  void app.whenReady().then(async () => {
    startWorker();
    window = new BrowserWindow({ width: 960, height: 740, minWidth: 560, minHeight: 620, title: 'Atoma Compute', backgroundColor: '#0d1726',
      webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    ipcMain.handle('compute:language', (event, input: unknown) => { authorize(event); selectedLocale = z.enum(SUPPORTED_LOCALES).parse(input); refreshTray(); });
    ipcMain.handle('compute:state', event => { authorize(event); return state; });
    ipcMain.handle('compute:command', async (event, input: unknown) => { authorize(event); const command = computeDesktopCommandSchema.parse(input);
      if (command.action === 'disconnect-idle' || updates.pending && !['refresh', 'resources', 'pause', 'stop', 'disconnect'].includes(command.action)) throw new Error('An update is waiting for work to finish');
      await send(command); });
    ipcMain.handle('compute:open', async (event, input: unknown) => { authorize(event); const link = computeDesktopLinkSchema.parse(input); if (link === 'updates') { if (updates.snapshot().phase === 'unsupported') await shell.openExternal(links.updates); else await updates.action('check'); } else await shell.openExternal(links[link]); });
    ipcMain.handle('compute:update-state', event => { authorize(event); return updates.snapshot(); });
    ipcMain.handle('compute:update', async (event, input: unknown) => { authorize(event); await updates.action(computeDesktopUpdateActionSchema.parse(input)); });
    autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = false; autoUpdater.allowDowngrade = false;
    autoUpdater.channel = `latest-${process.arch}`;
    autoUpdater.on('download-progress', progress => updates.progress(progress.percent));
    autoUpdater.on('error', () => {
      if (updates.snapshot().phase === 'installing') quitting = false;
      if (updates.snapshot().phase !== 'unsupported') updates.failed();
    });
    trayIcons = createTrayIcons();
    tray = new Tray(trayIcons.idle); refreshTray();
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Atoma Compute', click: show }, { type: 'separator' }, { label: t('quitMenu'), click: () => { void quit(); } }]));
    tray.on('click', show);
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Atoma Compute', submenu: [{ label: t('showMenu'), click: show }, { type: 'separator' }, { label: t('quitMenu'), accelerator: 'CmdOrCtrl+Q', click: () => { void quit(); } }] }, { role: 'editMenu' }, { role: 'viewMenu' }]));
    powerMonitor.on('suspend', () => { void send({ action: 'disconnect' }).catch(() => {}); });
    await window.loadFile(join(root, 'index.html'));
    void updates.action('check');
    updateTimer = setInterval(() => { void updates.action('check'); }, 4 * 60 * 60_000);
    updateTimer.unref();
    powerMonitor.on('resume', () => { void updates.action('check'); });
  });
}
