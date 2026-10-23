import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { computeMain, saveComputeBudget, type ComputeApplicationHooks } from '../src/launcher/computeApplication.js';
const m = vi.hoisted(() => ({ home: '', connect: vi.fn(), close: vi.fn(), read: vi.fn(), diagnose: vi.fn(), control: vi.fn(), construct: vi.fn() }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => m.home }));
vi.mock('../src/launcher/computeCredential.js', () => ({ ComputeCredential: class { read = m.read; } }));
vi.mock('../src/launcher/desktopCompute.js', () => ({ DesktopCompute: { diagnoseClient: m.diagnose, diagnose: m.diagnose } }));
vi.mock('../src/launcher/computeMachine.js', () => ({ ComputeMachine: class { constructor(options: unknown) { m.construct(options); } connect = m.connect; close = m.close; } }));
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

it('reads the saved budget for each new assignment and advertises the initial selected capacity', async () => {
  m.diagnose.mockResolvedValue({ cpus: 14, memoryBytes: 17.5 * 1024 ** 3, diskBytes: 20 * 1024 ** 3 });
  m.connect.mockResolvedValue({ requestControl: m.control, finished: Promise.resolve(true) });
  await computeMain(['start'], { appVersion: '0.4.0', controls: () => {}, reconnect: () => false });
  expect(m.connect.mock.calls[0]![0].capabilities).toMatchObject({ cpus: 9, memoryBytes: 10 * 1024 ** 3 });
  const options = m.construct.mock.calls[0]![0] as { resourceBudget: () => Promise<unknown> };
  expect(await options.resourceBudget()).toEqual({ cpus: 9, memoryGiB: 10 });
  saveComputeBudget(join(m.home, '.atoma', 'compute'), { cpus: 12, memoryGiB: 12 });
  expect(await options.resourceBudget()).toEqual({ cpus: 12, memoryGiB: 12 });
  m.diagnose.mockResolvedValue({ cpus: 8, memoryBytes: 8 * 1024 ** 3 });
  await expect(options.resourceBudget()).rejects.toThrow('exceeds');
});

// 2026-10-23: the host sends its delivery classification only to a device that
// advertises `preview-classification`. An installation still pinned to an older
// workspace image (an upgrade not yet prepared) must not advertise it: that
// image's copier parses the start command strictly and would refuse the field.
it('advertises preview classification only while running the bundled workspace image', async () => {
  const { computeServices } = await import('../src/launcher/computeApplication.js');
  const { COMPUTE_IMAGES } = await import('../src/contracts/computeImages.js');
  for (const architecture of ['arm64', 'x64'] as const) {
    const bundled = COMPUTE_IMAGES[architecture === 'arm64' ? 'arm64' : 'amd64'].workspace;
    expect(computeServices(bundled, architecture)).toContain('preview-classification');
    expect(computeServices(bundled.replace(/sha256:.*/, 'sha256:' + '0'.repeat(64)), architecture)).not.toContain('preview-classification');
    expect(computeServices(bundled.replace(/sha256:.*/, 'sha256:' + '0'.repeat(64)), architecture)).toEqual(['workspace', 'tools', 'retrieval', 'preview']);
  }
});
