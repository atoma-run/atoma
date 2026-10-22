import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RuntimeTiming } from '../contracts/runtimeTiming.js';

export function observeTiming(observer: ((timing: RuntimeTiming) => void) | undefined,
  phase: RuntimeTiming['phase'], startedAt: number, endedAt = Date.now()): void {
  try { observer?.({ phase, startedAt, durationMs: Math.max(0, endedAt - startedAt) }); }
  catch { /* Observability never affects execution, approval or cleanup. */ }
}

export async function timed<T>(observer: ((timing: RuntimeTiming) => void) | undefined,
  phase: RuntimeTiming['phase'], work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try { return await work(); }
  finally { observeTiming(observer, phase, startedAt); }
}

/** Host-owned sidecar; late transfer/cleanup timings cannot rewrite a sealed trace. */
export function timingSidecar(tracePath: string): (timing: RuntimeTiming) => void {
  return timing => { try {
    mkdirSync(dirname(tracePath), { recursive: true });
    appendFileSync(tracePath + '.timings.jsonl', JSON.stringify(timing) + '\n', { mode: 0o600 });
  } catch { /* A timing write never changes the run disposition. */ } };
}
