import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pullComputeImage, type ImagePullLauncher } from '../src/launcher/computeImagePull.js';
import type { ComputeImageProgress } from '../src/contracts/computeSetup.js';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(source: string): ImagePullLauncher {
  const directory = mkdtempSync(join(tmpdir(), 'compute-pull-')); directories.push(directory);
  const file = join(directory, 'pull.cjs'); writeFileSync(file, source);
  return (_file, _args, options) => spawn(process.execPath, [file], options);
}
it('reports progress across a real child process without buffering its full output', async () => {
  const values: ComputeImageProgress[] = [];
  await pullComputeImage('unused', value => values.push(value), undefined, fixture("process.stdout.write('abcdef012345: Pulling fs layer\\nabcdef012345: Pull com'); setTimeout(()=>process.stdout.write('plete\\n123456abcdef: Already exists\\n'),20); setTimeout(()=>{},1100);"));
  expect(values.length).toBeGreaterThan(2);
  expect(values.at(-1)).toMatchObject({ layers: 2, readyLayers: 2 });
  expect(values.at(-1)!.elapsedSeconds).toBeGreaterThanOrEqual(1);
});
it('waits for actual process exit on cancellation and does not call it success', async () => {
  const abort = new AbortController();
  const running = pullComputeImage('unused', () => {}, abort.signal, fixture('setInterval(()=>{},1000)'));
  abort.abort(); await expect(running).rejects.toMatchObject({ name: 'AbortError' });
});
it('bounds noisy output and reports download failures separately from Docker installation', async () => {
  await expect(pullComputeImage('unused', () => {}, undefined, fixture("process.stderr.write('x'.repeat(2*1024*1024),()=>process.exit(1));"))).rejects.toThrow('Compute image download failed');
});
