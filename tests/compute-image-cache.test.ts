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
