import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { computeMain } from '../src/cli/compute.js';
const mocks = vi.hoisted(() => ({ home: '', save: vi.fn(), remove: vi.fn(), diagnose: vi.fn(), pull: vi.fn() }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => mocks.home }));
vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));
vi.mock('../src/launcher/computeCredential.js', () => ({ ComputeCredential: class { save = mocks.save; remove = mocks.remove; } }));
vi.mock('../src/launcher/desktopCompute.js', () => ({ DesktopCompute: { diagnoseClient: mocks.diagnose, pullImages: mocks.pull } }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mocks.home = realpathSync(mkdtempSync(join(tmpdir(), 'compute-cli-')));
  Object.defineProperty(process, 'platform', { value: originalPlatform.value === 'win32' ? 'win32' : 'darwin' });
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.save.mockReset(); mocks.pull.mockReset(); mocks.diagnose.mockReset();
});
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(mocks.home, { recursive: true, force: true }); });
it('pairs with browser proof and persists no plaintext credential in local settings', async () => {
  const deviceId = randomUUID(), orgId = randomUUID(), credential = randomBytes(32).toString('base64url'), code = randomBytes(16).toString('base64url');
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code, expiresAt: Date.now() + 60_000,
    verificationUrl: `https://atoma.example/compute/pair?code=${code}` }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ deviceId, orgId, credential })));
  vi.stubGlobal('fetch', fetch);
  const image = `registry.example/compute@sha256:${'a'.repeat(64)}`;
  await computeMain(['pair', '--server', 'https://atoma.example', '--name', 'Test computer', '--workspace-image', image, '--worker-image', image, '--retrieval-image', image, '--preview-image', image]);
  expect(mocks.save).toHaveBeenCalledWith(credential);
  const config = readFileSync(join(mocks.home, '.atoma', 'compute', 'settings.json'), 'utf8');
  expect(config).not.toContain(credential); expect(JSON.parse(config)).toMatchObject({ deviceId, orgId, origin: 'https://atoma.example' });
  expect(JSON.stringify(output.mock.calls)).not.toContain(credential);
  const begin = JSON.parse(fetch.mock.calls[0]![1].body as string) as { secretHash: string };
  const redeem = JSON.parse(fetch.mock.calls[1]![1].body as string) as { secret: string };
  expect(begin.secretHash).toHaveLength(64); expect(redeem.secret).toHaveLength(43); expect(config).not.toContain(redeem.secret);
  expect(mocks.pull).not.toHaveBeenCalled(); expect(mocks.diagnose).not.toHaveBeenCalled();
});
it('offers help without requiring a supported OS and refuses unknown commands', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  await expect(computeMain(['--help'])).resolves.toBeUndefined();
  await expect(computeMain(['install-docker'])).rejects.toThrow('Atoma Compute');
  await expect(computeMain(['start'])).rejects.toThrow('native Windows');
});
it('refuses mutable images before requesting pairing or changing the machine', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(computeMain(['pair', '--server', 'https://atoma.example', '--name', 'Test', '--workspace-image', 'latest', '--worker-image', 'latest'])).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});
