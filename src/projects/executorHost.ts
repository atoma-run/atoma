import { realpathSync, lstatSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { RemotePreviewRuntime } from '../preview/computeController.js';
import { processFingerprint, recordedProcessLive, peekRunLeases } from '../mcp/runLock.js';
import { recoverOperatorExecutions } from '../mcp/operatorExecution.js';
import type { ProjectRunCoordinator } from './coordinator.js';
import { assertExecutorDirectory, executorSelected, serveExecutor } from './executorTransport.js';
import { ProjectRunBusy } from './coordinator.js';
import { startRun, pollOperatorControls, operatorExecutionIdle } from '../mcp/run.js';
import { EXECUTOR_COMPATIBILITY } from '../contracts/executorVersion.js';
import type { ProjectRun } from '../contracts/projects.js';

/** Bump for a change that cannot coexist with older writers. The activator drains on mismatch. */
export { EXECUTOR_COMPATIBILITY } from '../contracts/executorVersion.js';

export async function startExecutorHost(options: {
  socket: string; activeSocket: string; release: string; coordinator: ProjectRunCoordinator;
  onIdle?: () => void;
  retirementConfirmed?: () => boolean;
  preview?: () => RemotePreviewRuntime | undefined;
  onDemoted?: () => void;
  initialize?: () => Promise<void>;
  workIdle?: () => boolean;
  snapshot?: () => unknown;
  yieldBackground?: () => Promise<boolean>;
  operatorStart?: typeof startRun;
  onRunAdmitted?: (run: ProjectRun) => void;
}) {
  const { socket, activeSocket, coordinator } = options;
  assertExecutorDirectory(socket);
  recoverOperatorExecutions(new Set(peekRunLeases(undefined, true).map(owner => owner.runId)));
  const receiptPath = `${socket}.json`;
  try {
    const stat = lstatSync(socket);
    if (!stat.isSocket()) throw new Error('Executor path is not a Unix socket');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { pid: number; fingerprint: string };
    if (recordedProcessLive(receipt.pid, receipt.fingerprint)) throw new Error('Executor generation is already running');
    unlinkSync(socket);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let admittedRequests = 0;
  let selectedOnce = false;
  let ready = false;
  const previews = new Map<string, { orgId: string; runId: string; generation: number; streamId: string;
    connect: () => Promise<Duplex>; timer: ReturnType<typeof setTimeout> }>();
  const stopPreview = async (orgId: string, runId: string, generation: number) => {
    const key = `${orgId}:${runId}:${generation}`, preview = previews.get(key);
    if (!preview) return;
    try { await options.preview?.()?.stop(orgId, runId, generation); }
    finally { clearTimeout(preview.timer); previews.delete(key); }
  };
  const selected = () => executorSelected(activeSocket, socket);
  const server = await serveExecutor(socket, async command => {
    if (command.method === 'health') return { compatibility: EXECUTOR_COMPATIBILITY, ready,
      release: realpathSync(options.release), selected: selected(), idle: coordinator.executionIdle() && operatorExecutionIdle() && admittedRequests === 0 && previews.size === 0 && (options.workIdle?.() ?? true) };
    if (!ready || (!selected() && !['preview-start', 'preview-stop', 'yield-background', 'retire-previews'].includes(command.method))) throw new ProjectRunBusy('Run executor is switching versions; retry the same request');
    admittedRequests++;
    try {
      if (command.method === 'yield-background') return await options.yieldBackground?.() ?? false;
      if (command.method === 'retire-previews') {
        const retiring = [...previews.values()];
        // Web grants died with their frontend. Stop only those ephemeral
        // previews, asynchronously; build/device executions are untouched.
        void Promise.allSettled(retiring.map(preview => stopPreview(preview.orgId, preview.runId, preview.generation)));
        return { retiring: retiring.length };
      }
      if (command.method === 'start') {
        const result = await coordinator.startOutcome(command.input);
        try { if (result.created) options.onRunAdmitted?.(result.run); }
        catch (error) { console.error('[executor] run admission journal failed', error); }
        // A lost frontend connection cannot lose or duplicate this audit row.
        return { ...result, admissionJournaled: Boolean(options.onRunAdmitted) };
      }
      if (command.method === 'operator-start') return await (options.operatorStart ?? startRun)(command.input);
      if (command.method === 'compute-finalize') return await coordinator.retryComputeFinalization(command.orgId, command.runId, command.principalId);
      if (command.method === 'preview-start') {
        const runtime = options.preview?.();
        if (!runtime) throw new Error('Compute preview unavailable');
        const input = command.input;
        const started = await runtime.start(input);
        const streamId = randomUUID();
        const timer = setTimeout(() => { void stopPreview(input.orgId, input.runId, input.generation).catch(error => console.error(error)); }, input.hardMs + 30_000);
        timer.unref();
        previews.set(`${input.orgId}:${input.runId}:${input.generation}`, { orgId: input.orgId, runId: input.runId,
          generation: input.generation, streamId, connect: () => started.connect(), timer });
        return { streamId, imageDigest: started.imageDigest, runtime: started.runtime };
      }
      if (command.method === 'preview-stop') return await stopPreview(command.orgId, command.runId, command.generation);
      return await coordinator.retryPublication(command.orgId, command.runId);
    } finally { admittedRequests--; }
  }, async streamId => {
    const preview = [...previews.values()].find(preview => preview.streamId === streamId);
    if (!preview) throw new Error('Compute preview stream unavailable');
    return await preview.connect();
  });
  const fingerprint = processFingerprint(process.pid);
  if (!fingerprint) { server.close(); throw new Error('Executor process identity unavailable'); }
  writeFileSync(receiptPath, JSON.stringify({ pid: process.pid, fingerprint, release: realpathSync(options.release) }), { mode: 0o600 });
  await options.initialize?.();
  ready = true;
  let previousSnapshot = '';
  const tick = () => {
    coordinator.pollRunControls();
    pollOperatorControls();
    if (options.snapshot) {
      const encoded = JSON.stringify({ pid: process.pid, fingerprint, release: realpathSync(options.release), snapshot: options.snapshot() });
      if (encoded !== previousSnapshot) {
        writeFileSync(`${receiptPath}.tmp`, encoded, { mode: 0o600 });
        renameSync(`${receiptPath}.tmp`, receiptPath);
        previousSnapshot = encoded;
      }
    }
    if (selected()) {
      selectedOnce = true;
      coordinator.resumeQueuedRuns();
      return;
    }
    coordinator.stopQueue();
    if (selectedOnce) options.onDemoted?.();
    if ((selectedOnce || options.retirementConfirmed?.()) && (options.retirementConfirmed?.() ?? true) &&
        coordinator.executionIdle() && operatorExecutionIdle() && admittedRequests === 0 && previews.size === 0 && (options.workIdle?.() ?? true)) {
      clearInterval(timer);
      server.close(() => options.onIdle?.());
    }
  };
  const timer = setInterval(() => {
    try { tick(); } catch (error) { console.error('[executor] control poll failed', error); }
  }, 250);
  server.once('close', () => { clearInterval(timer); try { unlinkSync(receiptPath); } catch { /* A prior cleanup may already have removed it. */ } });
  tick();
  return { server, tick };
}
