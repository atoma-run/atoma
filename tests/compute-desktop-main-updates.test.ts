import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComputeDesktopCommand } from '../src/contracts/computeDesktop.js';
import { computeDesktopStateSchema } from '../src/contracts/computeDesktop.js';

const mocks = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  const { pathToFileURL } = await import('node:url');
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getLocale: () => 'en', getVersion: () => '0.4.41', quit: vi.fn(),
  });
  const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
  const web = Object.assign(new EventEmitter(), {
    send: vi.fn(), mainFrame: { url: 'file:///compute-test/index.html' }, setWindowOpenHandler: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
  });
  const window = Object.assign(new EventEmitter(), { webContents: web, show: vi.fn(), focus: vi.fn(), hide: vi.fn(), loadFile: vi.fn(async (path: string) => { web.mainFrame.url = pathToFileURL(path).href; }) });
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.4.42' } })),
    downloadUpdate: vi.fn(async () => []), quitAndInstall: vi.fn(),
    autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: true, channel: '',
  });
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
  return { app, worker, web, window, updater, handlers, power: new EventEmitter(), open: vi.fn(), trayImage: vi.fn(), trayTooltip: vi.fn() };
});
vi.mock('electron', () => ({
  app: mocks.app, BrowserWindow: class { constructor() { return mocks.window; } },
  dialog: { showMessageBox: vi.fn() }, ipcMain: { handle: (name: string, handler: (event: unknown, input?: unknown) => unknown) => mocks.handlers.set(name, handler) },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  nativeImage: {
    createFromPath: () => ({ resize: ({ width }: { width: number }) => ({ kind: 'idle', toBitmap: () => Buffer.alloc(width * width * 4) }) }),
    createEmpty: () => ({ kind: 'ready', addRepresentation: vi.fn() }),
    createFromBitmap: () => ({ toPNG: () => Buffer.alloc(0) }),
  }, powerMonitor: mocks.power, shell: { openExternal: mocks.open },
  Tray: class { setImage = mocks.trayImage; setToolTip = mocks.trayTooltip; setContextMenu() {} on() {} destroy() {} }, utilityProcess: { fork: () => mocks.worker },
}));
vi.mock('electron-updater', () => ({ autoUpdater: mocks.updater }));
const caller = () => ({ sender: mocks.web, senderFrame: mocks.web.mainFrame });
const invoke = (name: string, input?: unknown) => mocks.handlers.get(name)!(caller(), input);
beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal('__dirname', '/compute-test'); vi.stubGlobal('DESKTOP_SIGNED', true);
  mocks.app.removeAllListeners(); mocks.worker.removeAllListeners(); mocks.updater.removeAllListeners(); mocks.power.removeAllListeners(); mocks.handlers.clear();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('connects the signed main-process updater to authenticated IPC and waits for runtime-confirmed idle teardown', async () => {
  const runtime = computeDesktopStateSchema.parse({ paired: true, connected: true, accepting: true, phase: 'connected', issue: null,
    deviceName: 'Computer', download: null, diagnostic: null, allocations: [], transfers: [], resources: [] });
  mocks.worker.postMessage.mockImplementation(({ id, command }: { id: number; command: ComputeDesktopCommand }) => {
    if (command.action === 'drain') runtime.accepting = false;
    void Promise.resolve().then(() => {
      mocks.worker.emit('message', { kind: 'state', state: runtime });
      mocks.worker.emit('message', { kind: 'reply', id, ok: true });
    });
  });
  await import('../src/launcher/desktopApp/main.js');
  await vi.waitFor(() => expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce());
  expect(invoke('compute:update-state')).toMatchObject({ phase: 'available', version: '0.4.42' });
  expect(mocks.updater.autoDownload).toBe(false); expect(mocks.updater.autoInstallOnAppQuit).toBe(false); expect(mocks.updater.allowDowngrade).toBe(false);
  expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();
  await expect(mocks.handlers.get('compute:update')!({ sender: {} }, 'install')).rejects.toThrow('Untrusted');
  await expect(invoke('compute:update', 'shell')).rejects.toThrow();
  mocks.worker.emit('message', { kind: 'state', state: runtime });
  await invoke('compute:update', 'install');
  expect(invoke('compute:update-state')).toMatchObject({ phase: 'waiting' });
  await expect(invoke('compute:command', { action: 'accept' })).rejects.toThrow('update');
  await expect(invoke('compute:command', { action: 'disconnect-idle' })).rejects.toThrow();
  mocks.worker.emit('message', { kind: 'state', state: runtime });
  await vi.waitFor(() => expect(mocks.updater.quitAndInstall).toHaveBeenCalledWith(false, true));
  expect(mocks.worker.postMessage.mock.calls.map(([request]) => (request as { command: ComputeDesktopCommand }).command.action)).toEqual(['drain', 'disconnect-idle']);
  expect(mocks.worker.kill).not.toHaveBeenCalled();
});

it('leaves unsigned previews on manual downloads without polling or installing', async () => {
  vi.stubGlobal('DESKTOP_SIGNED', false);
  await import('../src/launcher/desktopApp/main.js');
  await vi.waitFor(() => expect(mocks.handlers.has('compute:update-state')).toBe(true));
  expect(invoke('compute:update-state')).toMatchObject({ phase: 'unsupported' });
  await invoke('compute:open', 'updates'); expect(mocks.open).toHaveBeenCalledWith('https://github.com/atoma-run/atoma/releases');
  await invoke('compute:update', 'install'); await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
  expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled(); expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
});

it('shows the green tray badge only while connected and ready, and clears it on runtime loss', async () => {
  vi.stubGlobal('DESKTOP_SIGNED', false);
  await import('../src/launcher/desktopApp/main.js');
  await vi.waitFor(() => expect(mocks.handlers.has('compute:state')).toBe(true));
  expect(mocks.trayImage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'idle' }));
  const ready = computeDesktopStateSchema.parse({ paired: true, connected: true, accepting: true, phase: 'connected', issue: null,
    deviceName: 'Computer', download: null, diagnostic: null, allocations: [], transfers: [], resources: [] });
  const emit = (patch = {}) => mocks.worker.emit('message', { kind: 'state', state: { ...ready, ...patch } });
  emit();
  expect(mocks.trayImage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'ready' }));
  expect(mocks.trayTooltip).toHaveBeenLastCalledWith('Atoma Compute — Your computer is ready');
  for (const patch of [{ connected: false }, { phase: 'connecting' }, { accepting: false }, { issue: 'stop-unconfirmed' }]) {
    emit(patch);
    expect(mocks.trayImage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'idle' }));
    emit();
    expect(mocks.trayImage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'ready' }));
  }
  mocks.worker.emit('exit');
  expect(mocks.trayImage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'idle' }));
  expect(mocks.trayTooltip).toHaveBeenLastCalledWith('Atoma Compute');
});
