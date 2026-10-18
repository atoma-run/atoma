import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComputeDesktopController } from '../src/launcher/desktopApp/controller.js';
import { computeDesktopCommandSchema } from '../src/contracts/computeDesktop.js';
import type { ComputeApplicationHooks } from '../src/launcher/computeApplication.js';
let root: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'compute-desktop-'))); Object.defineProperty(process, 'platform', { value: 'darwin' }); });
afterEach(() => { Object.defineProperty(process, 'platform', platform); rmSync(root, { recursive: true, force: true }); });
const preparation = { inspect: vi.fn(async () => ({ target: 'mac-arm64' as const, osVersion: '24', stage: 'ready' as const, downloadedBytes: 0, totalBytes: null })), ensureRunning: vi.fn(async () => true), installDocker: vi.fn(async () => {}), installWsl: vi.fn(async () => {}), pending: () => false, remember: vi.fn() };
function paired() {
  const image = `ghcr.io/atoma-run/atoma/worker@sha256:${'a'.repeat(64)}`;
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ version: 1, origin: 'https://atoma.run', deviceId: randomUUID(), orgId: randomUUID(), workspaceImage: image, workerImage: image, retrievalImage: image, previewImage: image, egress: true }));
}
it('only accepts closed commands and bounds pairing names', () => {
  expect(computeDesktopCommandSchema.safeParse({ action: 'shell', command: 'whoami' }).success).toBe(false);
  expect(computeDesktopCommandSchema.safeParse({ action: 'connect', server: 'https://evil.example' }).success).toBe(false);
  expect(computeDesktopCommandSchema.safeParse({ action: 'pair', name: 'x'.repeat(121) }).success).toBe(false);
});
it('pairs through the shared client with native pinned images and no credential in the public state', async () => {
  const opened = vi.fn();
  const run = vi.fn(async (args: string[], hooks?: ComputeApplicationHooks) => { expect(args[0]).toBe('pair'); hooks?.pairing?.('https://atoma.run/compute/pair?code=abcdefghijklmnopqrstuv'); });
  const app = new ComputeDesktopController('0.4.0', vi.fn(), opened, run, root, preparation);
  await app.execute({ action: 'pair', name: 'My Mac' });
  await vi.waitFor(() => expect(app.snapshot().paired).toBe(true));
  expect(run.mock.calls[0]![0]).toContain('--worker-image');
  expect(opened).toHaveBeenCalledOnce();
  expect(JSON.stringify(app.snapshot())).not.toMatch(/credential|secret|verificationUrl/);
  await expect(app.execute({ action: 'pair', name: 'Duplicate' })).rejects.toThrow('already paired');
});
it('prepares, reports progress, connects, drains and waits for confirmed cleanup on quit', async () => {
  paired(); const control = vi.fn(async () => {}); let release!: () => void; let stopping = false;
  const run = vi.fn(async (args: string[], hooks?: ComputeApplicationHooks) => {
    if (args[0] === 'pull') hooks?.download?.(4, 4);
    if (args[0] === 'start') {
      hooks?.controls?.(control, async () => ({ allocations: [], transfers: [], resources: [], disk: { freeBytes: null, reserveBytes: 1024 } }));
      hooks?.connection?.(true);
      await new Promise<void>(resolve => { release = resolve; hooks?.signal?.addEventListener('abort', () => { stopping = true; }); });
    }
  });
  const app = new ComputeDesktopController('0.4.0', vi.fn(), vi.fn(), run, root, preparation);
  await app.execute({ action: 'prepare' });
  await vi.waitFor(() => expect(app.snapshot().connected).toBe(true));
  expect(run.mock.calls.map(call => call[0][0])).toEqual(['pull', 'doctor', 'start']);
  expect(app.snapshot().download).toEqual({ completed: 4, total: 4 });
  await expect(app.execute({ action: 'prepare' })).rejects.toThrow('already active');
  await app.execute({ action: 'drain' }); expect(control).toHaveBeenCalledWith('drain');
  expect(app.snapshot().accepting).toBe(false);
  const done = vi.fn(); const quit = app.stop().then(done);
  await vi.waitFor(() => expect(stopping).toBe(true)); expect(done).not.toHaveBeenCalled();
  release(); await quit; expect(app.snapshot().phase).toBe('idle');
});
it('never reports successful shutdown when engine stop remains unconfirmed', async () => {
  paired();
  const run = vi.fn(async (_args: string[], hooks?: ComputeApplicationHooks) => {
    hooks?.connection?.(true);
    await new Promise<void>((_resolve, reject) => hooks?.signal?.addEventListener('abort', () => reject(new Error('Compute workload stop remains unconfirmed'))));
  });
  const app = new ComputeDesktopController('0.4.0', vi.fn(), vi.fn(), run, root, preparation);
  await app.execute({ action: 'connect' });
  await vi.waitFor(() => expect(app.snapshot().connected).toBe(true));
  await expect(app.stop()).rejects.toThrow('unconfirmed');
  expect(app.snapshot()).toMatchObject({ phase: 'error', issue: 'stop-unconfirmed' });
});

it('waits for missing Docker without pulling images and resumes only after readiness', async () => {
  paired(); const run = vi.fn(async () => {});
  let ready = false;
  const prep = { ...preparation, ensureRunning: vi.fn(async () => ready), inspect: vi.fn(async () => ({ target: 'mac-arm64' as const, osVersion: '24', stage: ready ? 'ready' as const : 'install-required' as const, downloadedBytes: 0, totalBytes: null })) };
  const app = new ComputeDesktopController('0.4.0', vi.fn(), vi.fn(), run, root, prep);
  await app.execute({ action: 'prepare' });
  await vi.waitFor(() => expect(app.snapshot().phase).toBe('idle'));
  expect(run).not.toHaveBeenCalled();
  await app.refresh(); expect(run).not.toHaveBeenCalled();
  ready = true; await app.refresh();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
});
it('cancel removes pending preparation and does not resume after Docker becomes ready', async () => {
  paired(); const run = vi.fn(async () => {});
  const prep = { ...preparation, ensureRunning: vi.fn(async () => false) };
  const app = new ComputeDesktopController('0.4.0', vi.fn(), vi.fn(), run, root, prep);
  await app.execute({ action: 'prepare' });
  await vi.waitFor(() => expect(app.snapshot().phase).toBe('idle'));
  await app.execute({ action: 'cancel' }); await app.refresh(); expect(run).not.toHaveBeenCalled();
  expect(prep.remember).toHaveBeenLastCalledWith(false);
});
