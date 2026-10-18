import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { ComputeImageProgress } from '../contracts/computeSetup.js';
export type ImagePullLauncher = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
/** Stream bounded progress instead of buffering an entire large image pull. */
export async function pullComputeImage(reference: string, report: (progress: ComputeImageProgress) => void, signal?: AbortSignal, launch: ImagePullLauncher = spawn): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const started = performance.now(), layers = new Set<string>(), ready = new Set<string>();
    const child = launch('docker', ['pull', reference], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let failure: Error | undefined, force: NodeJS.Timeout | undefined;
    const publish = () => report({ elapsedSeconds: Math.floor((performance.now() - started) / 1000), layers: layers.size, readyLayers: ready.size });
    const line = (text: string) => {
      const match = /^([a-f0-9]{12,64}): (.+)$/.exec(text.trim());
      if (!match || layers.size >= 256 && !layers.has(match[1]!)) return;
      layers.add(match[1]!);
      if (/^(Already exists|Pull complete)/.test(match[2]!)) ready.add(match[1]!);
    };
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream?.on('data', (chunk: Buffer) => {
        const lines = (pending + chunk.toString('utf8')).split(/[\r\n]/);
        pending = lines.pop()!.slice(-4096);
        for (const text of lines) line(text);
      });
      stream?.on('end', () => line(pending));
    }
    const terminate = () => { child.kill(); if (!force) { force = setTimeout(() => child.kill('SIGKILL'), 5000); force.unref(); } };
    const abort = () => { failure = new DOMException('Preparation cancelled', 'AbortError'); terminate(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setInterval(publish, 1000);
    const deadline = setTimeout(() => { failure = new Error('Compute image download timed out'); terminate(); }, 60 * 60_000);
    const cleanup = () => { clearInterval(timer); clearTimeout(deadline); if (force) clearTimeout(force); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { failure = error; });
    child.once('close', code => { cleanup(); publish(); if (failure) reject(failure); else if (code !== 0) reject(new Error('Compute image download failed')); else resolve(); });
    publish();
  });
}
