import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), pull: vi.fn() }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }) };
});
vi.mock('../src/launcher/computeImagePull.js', () => ({ pullComputeImage: mocks.pull }));
import { DesktopCompute } from '../src/launcher/desktopCompute.js';
const refs = ['a', 'b', 'c', 'd'].map(letter => 'ghcr.io/atoma-run/atoma/image@sha256:' + letter.repeat(64));
const config = { workspaceImage: refs[0]!, workerImage: refs[1]!, retrievalImage: refs[2]!, previewImage: refs[3]! };
beforeEach(() => { mocks.exec.mockReset().mockResolvedValue({ stdout: '{}' }); mocks.pull.mockReset().mockResolvedValue(undefined); });
it('reuses all locally installed immutable images without contacting the registry', async () => {
  const progress = vi.fn(); await DesktopCompute.pullImages(config, progress);
  expect(mocks.pull).not.toHaveBeenCalled();
  expect(progress).toHaveBeenLastCalledWith(4, 4);
});
it('downloads only a missing image and forwards its live progress', async () => {
  mocks.exec.mockImplementation(async (_command: string, args: string[]) => {
    if (args.includes(refs[2]!)) throw new Error('not installed');
    return { stdout: '{}' };
  });
  const detail = vi.fn();
  mocks.pull.mockImplementation(async (_reference, callback) => { callback({ elapsedSeconds: 2, layers: 12, readyLayers: 3 }); });
  await DesktopCompute.pullImages(config, undefined, undefined, detail);
  expect(mocks.pull).toHaveBeenCalledOnce();
  expect(mocks.pull.mock.calls[0]![0]).toBe(refs[2]);
  expect(detail).toHaveBeenCalledWith({ elapsedSeconds: 2, layers: 12, readyLayers: 3 });
});

// Each release pins new digests; the old ones filled a Mac (2026-10-30).
it('removes earlier releases of the pinned repositories, never a pin, a foreign image or one in use', async () => {
  const id = (letter: string) => 'sha256:' + letter.repeat(64);
  const pins = { workspaceImage: 'ghcr.io/atoma-run/atoma/compute-workspace@sha256:' + 'a'.repeat(64),
    workerImage: 'ghcr.io/atoma-run/atoma/compute-worker@sha256:' + 'b'.repeat(64) };
  const removed: string[] = [];
  mocks.exec.mockImplementation(async (_command: string, args: string[]) => {
    if (args[1] === 'inspect') return { stdout: args.at(-1) === pins.workspaceImage ? id('1') : id('2') };
    if (args[1] === 'ls') return { stdout: [
      `ghcr.io/atoma-run/atoma/compute-workspace\t${id('1')}`,
      `ghcr.io/atoma-run/atoma/compute-workspace\t${id('3')}`,
      `ghcr.io/atoma-run/atoma/compute-worker\t${id('2')}`,
      `ghcr.io/atoma-run/atoma/compute-worker\t${id('4')}`,
      `ghcr.io/atoma-run/atoma/compute-worker\t${id('5')}`,
      `atoma-worker\t${id('6')}`,
      `ghcr.io/atoma-run/atoma/compute-preview\t${id('7')}`,
    ].join('\n') };
    if (args[1] === 'rm') {
      if (args[2] === id('5')) throw new Error('image is being used by stopped container');
      removed.push(args[2]!); return { stdout: '' };
    }
    throw new Error('unexpected ' + args.join(' '));
  });
  await expect(DesktopCompute.removeSupersededImages(pins)).resolves.toBe(1 + 1);
  expect(removed).toEqual([id('3'), id('4')]);
  // Never forced: the engine is the one that knows what a container still uses.
  expect(mocks.exec.mock.calls.every(([, args]) => !(args as string[]).includes('-f') && !(args as string[]).includes('--force'))).toBe(true);
});

it('leaves local image-id pins alone: they name no repository', async () => {
  await expect(DesktopCompute.removeSupersededImages({ workspaceImage: 'sha256:' + 'a'.repeat(64), workerImage: 'sha256:' + 'b'.repeat(64) })).resolves.toBe(0);
  expect(mocks.exec).not.toHaveBeenCalled();
});
