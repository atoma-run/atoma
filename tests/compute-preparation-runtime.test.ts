import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ commands: vi.fn(), exists: vi.fn() }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: mocks.commands });
  return { ...actual, execFile };
});
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: mocks.exists }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), release: () => '24.0.0' }));
import { DesktopPreparation } from '../src/launcher/desktopApp/preparation.js';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!;
const initialPath = process.env.PATH;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' }); Object.defineProperty(process, 'arch', { value: 'arm64' });
  mocks.exists.mockReset().mockReturnValue(false); mocks.commands.mockReset();
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', architecture); process.env.PATH = initialPath; });
it('does not launch or download anything during missing-Docker inspection', async () => {
  const preparation = new DesktopPreparation('/unused', vi.fn());
  expect((await preparation.inspect()).stage).toBe('install-required');
  expect(await preparation.ensureRunning(new AbortController().signal)).toBe(false);
  expect(mocks.commands).not.toHaveBeenCalled();
});
it('starts an installed verified Docker and waits for actual engine readiness', async () => {
  mocks.exists.mockImplementation((path: string) => path === '/Applications/Docker.app');
  let inspections = 0;
  mocks.commands.mockImplementation(async (file: string, args: string[]) => {
    if (file === 'docker') {
      if (++inspections === 1) throw new Error('daemon unavailable');
      return { stdout: Buffer.from(JSON.stringify({ OperatingSystem: 'Docker Desktop', OSType: 'linux' })) };
    }
    if (file === '/usr/bin/codesign') return { stdout: Buffer.from(''), stderr: 'TeamIdentifier=9BNSXJN65R' };
    expect(file).toBe('/usr/bin/open'); expect(args).toEqual(['-a', '/Applications/Docker.app']);
    return { stdout: Buffer.from('') };
  });
  const preparation = new DesktopPreparation('/unused', vi.fn());
  expect(await preparation.ensureRunning(new AbortController().signal)).toBe(true);
  expect(preparation.snapshot().stage).toBe('ready');
  expect(inspections).toBe(2);
});
it('refuses to start a replacement application with a different publisher', async () => {
  mocks.exists.mockReturnValue(true);
  mocks.commands.mockImplementation(async (file: string) => {
    if (file === 'docker') throw new Error('daemon unavailable');
    return { stdout: Buffer.from(''), stderr: 'TeamIdentifier=NOT_DOCKER' };
  });
  const preparation = new DesktopPreparation('/unused', vi.fn());
  await expect(preparation.ensureRunning(new AbortController().signal)).rejects.toThrow('publisher');
  expect(mocks.commands.mock.calls.some(([file]) => file === '/usr/bin/open')).toBe(false);
});
it('does not accept a non-Desktop engine as ready', async () => {
  mocks.exists.mockReturnValue(true);
  mocks.commands.mockResolvedValue({ stdout: Buffer.from('{"OperatingSystem":"Ubuntu","OSType":"linux"}') });
  expect((await new DesktopPreparation('/unused', vi.fn()).inspect()).stage).toBe('start-failed');
});
