import { PreviewRuntimeError } from './runtime.js';
import type { RemotePreviewRuntime } from './computeController.js';
import type { ComputeDeviceStore } from '../projects/computeDevices.js';
import type { ProjectStore } from '../projects/store.js';
import { callExecutor, openExecutorStream } from '../projects/executorTransport.js';
import { computeExecutor } from '../projects/computeExecutor.js';

/** The UI gateway owns grants; the device connection belongs to its independent executor. */
export class ExecutorComputePreview implements RemotePreviewRuntime {
  private readonly sockets = new Map<string, string>();
  constructor(private readonly dbPath: string, private readonly projects: ProjectStore, private readonly devices: ComputeDeviceStore) {}
  owns(orgId: string, projectId: string, runId: string): boolean {
    const run = this.projects.getProjectRun(orgId, runId);
    return run?.projectId === projectId && run.executionTarget.kind === 'customer-device';
  }
  async start(input: Parameters<RemotePreviewRuntime['start']>[0]) {
    const run = this.projects.getProjectRun(input.orgId, input.runId);
    const session = run?.executionTarget.kind === 'customer-device' && this.devices.currentSession(run.executionTarget.deviceId);
    const socket = session && computeExecutor(this.dbPath, session);
    if (!socket) throw new PreviewRuntimeError('compute-unavailable', 'Reconnect Atoma Compute on the computer that built this result, then retry the preview.');
    const result = await callExecutor<{ streamId: string; imageDigest: string; runtime: 'runc' }>(socket,
      { method: 'preview-start', input: { ...input, allowedHosts: [...input.allowedHosts] } });
    this.sockets.set(`${input.orgId}:${input.runId}:${input.generation}`, socket);
    return { imageDigest: result.imageDigest, runtime: result.runtime,
      connect: () => openExecutorStream(socket, result.streamId) };
  }
  async stop(orgId: string, runId: string, generation: number): Promise<void> {
    const key = `${orgId}:${runId}:${generation}`, socket = this.sockets.get(key);
    if (!socket) return;
    try { await callExecutor(socket, { method: 'preview-stop', orgId, runId, generation }); }
    finally { this.sockets.delete(key); }
  }
}
