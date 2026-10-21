import { expect, it, vi } from 'vitest';
import { DesktopUpdates } from '../src/launcher/desktopApp/updates.js';
import { computeDesktopStateSchema, type ComputeDesktopCommand } from '../src/contracts/computeDesktop.js';
import { randomUUID } from 'node:crypto';

function fixture(supported = true) {
  const runtime = computeDesktopStateSchema.parse({ paired: true, connected: true, accepting: true, phase: 'connected', issue: null,
    deviceName: 'Computer', download: null, diagnostic: null, allocations: [], transfers: [], resources: [] });
  const hooks = {
    check: vi.fn(async (): Promise<string | null> => '0.4.42'), download: vi.fn(async () => {}),
    runtime: () => runtime, install: vi.fn(), changed: vi.fn(),
    command: vi.fn(async (command: ComputeDesktopCommand) => { if (command.action === 'drain') runtime.accepting = false; }),
  };
  return { runtime, hooks, updates: new DesktopUpdates(supported, hooks) };
}
it('discovers an update without downloading, then one click drains and installs after idle confirmation', async () => {
  const { updates, hooks } = fixture();
  await updates.action('check'); expect(updates.snapshot()).toMatchObject({ phase: 'available', version: '0.4.42' });
  expect(hooks.download).not.toHaveBeenCalled(); expect(hooks.command).not.toHaveBeenCalled();
  await updates.action('install');
  expect(updates.snapshot().phase).toBe('waiting'); expect(hooks.command).toHaveBeenCalledWith({ action: 'drain' });
  expect(hooks.install).not.toHaveBeenCalled();
  await updates.advance();
  expect(hooks.command).toHaveBeenLastCalledWith({ action: 'disconnect-idle' }); expect(hooks.install).toHaveBeenCalledOnce();
  await updates.advance(); expect(hooks.install).toHaveBeenCalledOnce();
});
it('never checks, downloads or installs unsigned previews', async () => {
  const { updates, hooks } = fixture(false);
  await updates.action('check'); await updates.action('install'); await updates.advance();
  expect(updates.snapshot().phase).toBe('unsupported'); expect(hooks.check).not.toHaveBeenCalled(); expect(hooks.download).not.toHaveBeenCalled(); expect(hooks.install).not.toHaveBeenCalled();
});
it.each(['allocating', 'active', 'unconfirmed'] as const)('waits for %s allocations without interrupting them', async state => {
  const { updates, hooks, runtime } = fixture();
  runtime.allocations = [{ allocationId: randomUUID(), execution: { runId: randomUUID(), generation: 1 }, state, createdAt: 1 }];
  await updates.action('check'); await updates.action('install'); await updates.advance();
  expect(updates.pending).toBe(true); expect(hooks.command).toHaveBeenCalledTimes(1); expect(hooks.install).not.toHaveBeenCalled();
  runtime.allocations[0]!.state = 'stopped'; await updates.advance(); expect(hooks.install).toHaveBeenCalledOnce();
});
it('waits for transfers and preparation to finish', async () => {
  const { updates, hooks, runtime } = fixture();
  runtime.phase = 'downloading';
  await updates.action('check'); await updates.action('install'); expect(hooks.command).not.toHaveBeenCalled();
  runtime.phase = 'connected'; await updates.advance();
  runtime.transfers = [{ id: 'transfer', direction: 'upload', kind: 'delivery', bytes: 1, files: 1, state: 'transferring' }];
  await updates.advance(); expect(hooks.install).not.toHaveBeenCalled();
  runtime.transfers[0]!.state = 'transferred'; await updates.advance(); expect(hooks.install).toHaveBeenCalledOnce();
});
it('does not install on a failed drain or unconfirmed teardown, and retries the cached download', async () => {
  const { updates, hooks } = fixture();
  hooks.command.mockRejectedValueOnce(new Error('drain failed'));
  await updates.action('check'); await updates.action('install'); expect(updates.snapshot().phase).toBe('error');
  expect(hooks.install).not.toHaveBeenCalled(); expect(updates.pending).toBe(false);
  await updates.action('install');
  hooks.command.mockRejectedValueOnce(new Error('Docker unavailable'));
  await updates.advance(); expect(updates.snapshot().phase).toBe('error'); expect(hooks.install).not.toHaveBeenCalled();
  await updates.action('install'); expect(hooks.install).toHaveBeenCalledOnce(); expect(hooks.download).toHaveBeenCalledOnce();
});
it('postpones installation without re-enabling admission, checking again or downloading twice', async () => {
  const { updates, hooks, runtime } = fixture();
  await updates.action('check'); await updates.action('install'); await updates.action('cancel');
  await updates.advance(); expect(hooks.install).not.toHaveBeenCalled(); expect(runtime.accepting).toBe(false);
  await updates.action('check'); expect(hooks.check).toHaveBeenCalledOnce();
  await updates.action('install'); expect(hooks.install).toHaveBeenCalledOnce(); expect(hooks.download).toHaveBeenCalledOnce();
});
it('serializes checks, clicks and polls, and reports bounded download progress', async () => {
  const { updates, hooks } = fixture();
  let finish!: () => void;
  hooks.download.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await updates.action('check'); const click = updates.action('install');
  await updates.action('install'); await updates.action('check'); await updates.advance();
  updates.progress(140); expect(updates.snapshot().percent).toBe(100);
  updates.progress(Number.NaN); expect(updates.snapshot().percent).toBe(100);
  expect(hooks.download).toHaveBeenCalledOnce(); expect(hooks.command).not.toHaveBeenCalled();
  finish(); await click; await updates.advance(); expect(hooks.install).toHaveBeenCalledOnce();
});
it('recovers from offline checks and download failures without stopping work', async () => {
  const { updates, hooks } = fixture();
  hooks.check.mockRejectedValueOnce(new Error('offline'));
  await updates.action('check'); expect(updates.snapshot().phase).toBe('error');
  await updates.action('check'); hooks.download.mockRejectedValueOnce(new Error('invalid signature'));
  await updates.action('install'); expect(updates.snapshot().phase).toBe('error');
  expect(hooks.command).not.toHaveBeenCalled(); expect(hooks.install).not.toHaveBeenCalled();
  await updates.action('install'); await updates.advance(); expect(hooks.install).toHaveBeenCalledOnce();
});
it('reports current versions and refuses installation after runtime loss', async () => {
  const { updates, hooks, runtime } = fixture();
  hooks.check.mockResolvedValueOnce(null); await updates.action('check'); expect(updates.snapshot().phase).toBe('current');
  await updates.action('install'); expect(hooks.download).not.toHaveBeenCalled();
  await updates.action('check'); runtime.issue = 'stop-unconfirmed'; await updates.action('install');
  expect(updates.snapshot().phase).toBe('error'); expect(hooks.install).not.toHaveBeenCalled();
});
