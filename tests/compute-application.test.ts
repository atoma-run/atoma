import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { computeMain, type ComputeApplicationHooks } from '../src/launcher/computeApplication.js';
const m = vi.hoisted(() => ({ home: '', connect: vi.fn(), close: vi.fn(), read: vi.fn(), diagnose: vi.fn(), control: vi.fn() }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => m.home }));
vi.mock('../src/launcher/computeCredential.js', () => ({ ComputeCredential: class { read = m.read; } }));
vi.mock('../src/launcher/desktopCompute.js', () => ({ DesktopCompute: { diagnoseClient: m.diagnose } }));
vi.mock('../src/launcher/computeMachine.js', () => ({ ComputeMachine: class { connect = m.connect; close = m.close; } }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  vi.resetAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => {});
  m.home = realpathSync(mkdtempSync(join(tmpdir(), 'compute-application-')));
  Object.defineProperty(process, 'platform', { value: originalPlatform.value === 'win32' ? 'win32' : 'darwin' });
  const root = join(m.home, '.atoma', 'compute'); mkdirSync(root, { recursive: true, mode: 0o700 });
  const image = `ghcr.io/atoma-run/atoma/worker@sha256:${'a'.repeat(64)}`;
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ version: 1, origin: 'https://atoma.run', deviceId: randomUUID(), orgId: randomUUID(), workspaceImage: image, workerImage: image, retrievalImage: image, previewImage: image, egress: true }));
  m.diagnose.mockResolvedValue({ cpus: 8, memoryBytes: 8 * 1024 ** 3, diskBytes: 20 * 1024 ** 3 });
  m.read.mockResolvedValue('credential-only-in-runtime'); m.close.mockResolvedValue(undefined); m.control.mockResolvedValue(undefined);
});
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); vi.restoreAllMocks(); rmSync(m.home, { recursive: true, force: true }); });
it('holds shutdown until the actual shared machine confirms engine cleanup', async () => {
  let finish!: () => void;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  m.close.mockReturnValue(cleanup);
  m.connect.mockResolvedValue({ requestControl: m.control, finished: new Promise(() => {}) });
  const abort = new AbortController(); const done = vi.fn();
  const hooks: ComputeApplicationHooks = { appVersion: '0.4.0', signal: abort.signal, controls: () => abort.abort() };
  const running = computeMain(['start'], hooks).then(done);
  await vi.waitFor(() => expect(m.close).toHaveBeenCalled()); expect(done).not.toHaveBeenCalled();
  finish(); await running; expect(done).toHaveBeenCalledOnce();
});
it('turns a raw engine cleanup failure into an unconfirmed stop for the desktop quit gate', async () => {
  m.close.mockRejectedValue(new Error('docker daemon unavailable'));
  m.connect.mockRejectedValue(new Error('connection lost'));
  await expect(computeMain(['start'], { appVersion: '0.4.0' })).rejects.toThrow('stop remains unconfirmed');
});
it('uses the existing control protocol and refuses to reconnect a drained desktop session', async () => {
  m.connect.mockResolvedValue({ requestControl: m.control, finished: Promise.resolve(true) });
  let control: Parameters<NonNullable<ComputeApplicationHooks['controls']>>[0] | undefined;
  await computeMain(['start'], { appVersion: '0.4.0', controls: value => { control = value; }, reconnect: () => false });
  await control!('drain'); await control!('pause');
  expect(m.control.mock.calls).toEqual([['accepting', false], ['pause']]); expect(m.connect).toHaveBeenCalledOnce();
});
