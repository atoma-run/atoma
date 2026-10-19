import { computeSettings, saveComputeBudget } from '../src/launcher/computeApplication.js';
import { recommendedComputeBudget, resolveComputeBudget, computeWorkloadBudget } from '../src/contracts/computeLocal.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComputeDesktopController } from '../src/launcher/desktopApp/controller.js';
import { computeDesktopCommandSchema } from '../src/contracts/computeDesktop.js';
import { COMPUTE_IMAGES } from '../src/contracts/computeImages.js';
import { ComputeInventory } from '../src/launcher/computeInventory.js';
import type { ComputeApplicationHooks } from '../src/launcher/computeApplication.js';
let root: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'compute-desktop-')));
  // Keep native Windows filesystem semantics while admitting Linux test hosts.
  Object.defineProperty(process, 'platform', { value: platform.value === 'win32' ? 'win32' : 'darwin' });
});
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
  saveComputeBudget(root, { cpus: 12, memoryGiB: 12 });
  const before = computeSettings(root);
  const run = vi.fn(async (args: string[], hooks?: ComputeApplicationHooks) => {
    if (args[0] === 'pull') {
      const images = COMPUTE_IMAGES[process.arch === 'arm64' ? 'arm64' : 'amd64'];
      expect(computeSettings(root)).toEqual({ ...before, workerImage: images.worker, workspaceImage: images.workspace,
        previewImage: images.preview, retrievalImage: images.retrieval });
      hooks?.download?.(4, 4);
    }
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
it('keeps existing pins when opening, refreshing or diagnosing an existing pairing', async () => {
  paired(); const before = computeSettings(root);
  const app = new ComputeDesktopController('0.4.0', vi.fn(), vi.fn(), vi.fn(async () => {}), root, preparation);
  await app.initialize(); await app.refresh(); await app.execute({ action: 'diagnose' });
  await vi.waitFor(() => expect(app.snapshot().phase).toBe('idle'));
  expect(computeSettings(root)).toEqual(before);
});
it('refuses image replacement while another client owns the inventory', async () => {
  paired(); const before = computeSettings(root);
  const owner = new ComputeInventory(root);
  try {
    const run = vi.fn(async () => {});
    const app = new ComputeDesktopController('0.4.0', vi.fn(), vi.fn(), run, root, preparation);
    await app.execute({ action: 'prepare' });
    await vi.waitFor(() => expect(app.snapshot().issue).toBe('busy'));
    expect(run).not.toHaveBeenCalled(); expect(computeSettings(root)).toEqual(before);
  } finally { owner.close(); }
});
it('requires confirmed workload teardown before refreshing component pins', async () => {
  paired(); const before = computeSettings(root);
  const owner = new ComputeInventory(root);
  owner.reserve({ runId: randomUUID(), generation: 1 }); owner.close();
  const run = vi.fn(async () => {});
  const app = new ComputeDesktopController('0.4.0', vi.fn(), vi.fn(), run, root, preparation);
  await app.execute({ action: 'prepare' });
  await vi.waitFor(() => expect(app.snapshot().issue).toBe('stop-unconfirmed'));
  expect(run).not.toHaveBeenCalled(); expect(computeSettings(root)).toEqual(before);
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

it('reports an image transfer failure as a download issue, not missing Docker', async () => {
  paired();
  const run = vi.fn(async () => { throw new Error('docker pull: network timeout'); });
  const app = new ComputeDesktopController('0.4.0', vi.fn(), vi.fn(), run, root, preparation);
  await app.execute({ action: 'prepare' });
  await vi.waitFor(() => expect(app.snapshot().issue).toBe('download'));
});

it('recommends bounded budgets and includes concurrent preview and proxy overhead', () => {
  expect(recommendedComputeBudget({ cpus: 14, memoryBytes: 17.5 * 1024 ** 3 })).toEqual({ cpus: 9, memoryGiB: 10 });
  expect(recommendedComputeBudget({ cpus: 5, memoryBytes: 6 * 1024 ** 3 })).toEqual({ cpus: 5, memoryGiB: 6 });
  for (const cpus of [5, 8, 14, 32, 64]) for (const memoryGiB of [6, 8, 16, 64]) {
    const split = computeWorkloadBudget({ cpus, memoryGiB });
    expect(split.tools.cpus + split.search.cpus + 2).toBe(cpus);
    expect(split.tools.memoryGiB + split.search.memoryGiB + 2).toBe(memoryGiB);
    expect(split.tools.cpus).toBeGreaterThanOrEqual(2);
    expect(split.search.memoryGiB).toBeGreaterThanOrEqual(2);
  }
  expect(() => resolveComputeBudget({ cpus: 8, memoryBytes: 8 * 1024 ** 3 }, { cpus: 9, memoryGiB: 6 })).toThrow('exceeds');
  expect(() => resolveComputeBudget({ cpus: 8, memoryBytes: 8 * 1024 ** 3 }, { cpus: 5, memoryGiB: 9 })).toThrow('exceeds');
  expect(computeDesktopCommandSchema.safeParse({ action: 'resources', budget: { cpus: 0, memoryGiB: 6 } }).success).toBe(false);
});
it('persists resource changes while connected without stopping or modifying the current allocation', async () => {
  paired(); const control = vi.fn(async () => {});
  const diagnostic = { cpus: 14, memoryBytes: 17.5 * 1024 ** 3, diskBytes: 20 * 1024 ** 3, version: '29', system: 'Docker Desktop', isolation: 'desktop-containers' as const };
  const run = vi.fn(async (_args: string[], hooks?: ComputeApplicationHooks) => {
    hooks?.diagnostic?.(diagnostic);
    hooks?.controls?.(control, async () => ({ resourceBudget: { cpus: 9, memoryGiB: 10 }, allocations: [], transfers: [], resources: [], disk: { freeBytes: null, reserveBytes: 1024 } }));
    hooks?.connection?.(true);
    await new Promise<void>(resolve => hooks?.signal?.addEventListener('abort', () => resolve()));
  });
  const app = new ComputeDesktopController('0.4.0', vi.fn(), vi.fn(), run, root, preparation);
  await app.execute({ action: 'connect' });
  await vi.waitFor(() => expect(app.snapshot().connected).toBe(true));
  await app.refresh();
  expect(app.snapshot().resourceBudget).toEqual({ cpus: 9, memoryGiB: 10 });
  await app.execute({ action: 'resources', budget: { cpus: 12, memoryGiB: 12 } });
  expect(computeSettings(root).resourceBudget).toEqual({ cpus: 12, memoryGiB: 12 });
  expect(app.snapshot().activeResourceBudget).toEqual({ cpus: 9, memoryGiB: 10 });
  expect(control).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledOnce();
  await expect(app.execute({ action: 'resources', budget: { cpus: 15, memoryGiB: 12 } })).rejects.toThrow('exceeds');
  expect(computeSettings(root).resourceBudget?.cpus).toBe(12);
  await app.stop();
});
