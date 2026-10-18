import { computeSetupView } from '../src/viz/computeSetup.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectComputeTarget, DOCKER_DOWNLOADS } from '../src/contracts/computeSetup.js';
import { nativeComputeTarget, supportedWslVersion, downloadDocker, DesktopPreparation } from '../src/launcher/desktopApp/preparation.js';
afterEach(() => vi.unstubAllGlobals());
it('selects instructions without treating Intel in a Mac browser as physical architecture', () => {
  expect(detectComputeTarget('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
  expect(detectComputeTarget('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows-x64');
  expect(detectComputeTarget('', 'Win32')).toBe('windows-x64');
  expect(detectComputeTarget('Macintosh', 'MacIntel', '', 5)).toBe('unsupported');
  expect(detectComputeTarget('Android')).toBe('unsupported');
  expect(detectComputeTarget('Windows ARM64')).toBe('unsupported');
  expect(detectComputeTarget('Linux x86_64')).toBe('unsupported');
  expect(detectComputeTarget('')).toBe('unknown');
  expect(nativeComputeTarget('darwin', 'arm64')).toBe('mac-arm64');
  expect(nativeComputeTarget('darwin', 'x64')).toBe('mac-x64');
  expect(nativeComputeTarget('win32', 'arm64')).toBe('unsupported');
});
it('requires the documented WSL version, across localized output', () => {
  for (const version of ['2.1.5.0', '2.2.0', '3.0.0']) expect(supportedWslVersion(`WSL : ${version}`)).toBe(true);
  for (const version of ['2.1.4', '1.2.3', 'unavailable']) expect(supportedWslVersion(version)).toBe(false);
});
it('streams only fixed vendor downloads, checks length and refuses oversized bodies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'compute-download-'));
  const fetcher = vi.fn(async () => new Response('installer', { headers: { 'content-length': '9' } }));
  vi.stubGlobal('fetch', fetcher);
  try {
    const file = join(root, 'installer'); const progress = vi.fn();
    await downloadDocker(DOCKER_DOWNLOADS['mac-arm64'], file, new AbortController().signal, progress);
    expect(readFileSync(file, 'utf8')).toBe('installer'); expect(progress).toHaveBeenLastCalledWith(9, 9);
    expect(fetcher).toHaveBeenCalledWith(DOCKER_DOWNLOADS['mac-arm64'], expect.objectContaining({ redirect: 'error' }));
    await expect(downloadDocker('https://evil.example/file', file, new AbortController().signal, progress)).rejects.toThrow('Unknown');
    fetcher.mockImplementation(async () => new Response('x', { headers: { 'content-length': '3000000000' } }));
    await expect(downloadDocker(DOCKER_DOWNLOADS['mac-arm64'], join(root, 'big'), new AbortController().signal, progress)).rejects.toThrow('too large');
    fetcher.mockImplementation(async () => new Response('x', { headers: { 'content-length': '9' } }));
    await expect(downloadDocker(DOCKER_DOWNLOADS['mac-arm64'], join(root, 'short'), new AbortController().signal, progress)).rejects.toThrow('Incomplete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('persists only preparation intent across reopen, never a run command', () => {
  const root = mkdtempSync(join(tmpdir(), 'compute-prepare-'));
  try {
    const first = new DesktopPreparation(root, vi.fn()); expect(first.pending()).toBe(false); first.remember(true);
    const reopened = new DesktopPreparation(root, vi.fn()); expect(reopened.pending()).toBe(true); reopened.remember(false);
    expect(first.pending()).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('offers the published native asset only when available, preserving the explicit choice', () => {
  const url = new URL('https://atoma.run/compute/setup?os=mac-arm64');
  expect(computeSetupView('en', url, 'Windows', '', true)).toContain('Atoma-Compute-0.4.0-mac-arm64.dmg');
  expect(computeSetupView('en', url, 'Windows', '', false)).not.toContain('href="https://github.com/atoma-run/atoma/releases/download/');
});
