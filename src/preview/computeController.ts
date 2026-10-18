import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { ProjectStore } from '../projects/store.js';
import type { ComputeDeviceStore } from '../projects/computeDevices.js';
import type { ComputeConnection } from '../projects/computeConnection.js';
import type { ComputeSession } from '../contracts/computeDevice.js';
import type { PreviewClassification } from '../contracts/preview.js';
import type { ComputePreviewIdentity } from '../contracts/computePreview.js';
import { openComputePreviewStream } from './computeStream.js';

export interface RemotePreviewRuntime {
  owns(orgId: string, projectId: string, runId: string): boolean;
  start(input: { orgId: string; projectId: string; runId: string; generation: number; source: 'delivered' | 'in-flight';
    classification?: PreviewClassification; mode: 'app' | 'terminal'; copyMaxBytes: number; allowedHosts: readonly string[]; attribution: boolean; hardMs: number }): Promise<{
      connect(): Promise<Duplex>; imageDigest: string; runtime: 'runc';
    }>;
  stop(orgId: string, runId: string, generation: number): Promise<void>;
}

/** Existing preview policy owns origins, grants, expiry and mode. This adapter
 * substitutes the destination only after checking the immutable run target. */
export class ComputePreviewController implements RemotePreviewRuntime {
  private readonly active = new Map<string, { identity: ComputePreviewIdentity; peer: ComputeConnection; disconnected: () => void }>();
  constructor(private readonly options: { projects: ProjectStore; devices: ComputeDeviceStore;
    connectionFor(session: ComputeSession): ComputeConnection | undefined;
    unavailable(orgId: string, runId: string, generation: number): void }) {}
  private key(orgId: string, runId: string, generation: number) { return `${orgId}:${runId}:${generation}`; }
  owns(orgId: string, projectId: string, runId: string): boolean {
    const run = this.options.projects.getProjectRun(orgId, runId);
    return run?.projectId === projectId && run.executionTarget.kind === 'customer-device';
  }
  async start(input: Parameters<RemotePreviewRuntime['start']>[0]) {
    const run = this.options.projects.getProjectRun(input.orgId, input.runId);
    if (!run || run.projectId !== input.projectId || run.executionTarget.kind !== 'customer-device' ||
      (input.source === 'in-flight' ? run.status !== 'running' : run.status !== 'delivered' || !run.artifactManifestHash)) throw new Error('Compute preview source unavailable');
    const session = this.options.devices.currentSession(run.executionTarget.deviceId);
    const peer = session && this.options.connectionFor(session);
    if (!peer || !session || !this.options.devices.supports(session, 'preview')) throw new Error('Compute preview device unavailable');
    this.options.devices.authorizePreview(session, input.runId);
    const identity = { runId: input.runId, generation: input.generation, instanceId: randomUUID() };
    const key = this.key(input.orgId, input.runId, input.generation);
    if (this.active.has(key)) throw new Error('Compute preview already active');
    const disconnected = () => { this.active.delete(key); this.options.unavailable(input.orgId, input.runId, input.generation); };
    this.active.set(key, { identity, peer, disconnected });
    peer.signal.addEventListener('abort', disconnected, { once: true });
    try {
      const result = await peer.requestPreview(identity, { method: 'start', source: input.source, mode: input.mode,
        copyMaxBytes: Math.min(input.copyMaxBytes, 512 * 1024 ** 2), allowedHosts: [...input.allowedHosts],
        attribution: input.attribution, hardMs: input.hardMs,
        ...(input.source === 'delivered' ? { artifactHash: run.artifactManifestHash!, delivery: run.artifactManifest?.delivery } : {}) });
      if (result.method !== 'start' || peer.signal.aborted) throw new Error('Compute preview start unconfirmed');
      if (input.mode === 'app' && input.source === 'delivered' && input.classification &&
        (result.value.kind !== input.classification.kind ||
          (result.value.kind === 'node' && result.value.entry !== input.classification.entry))) throw new Error('Compute preview differs from the delivery descriptor');
      return { imageDigest: result.value.imageDigest, runtime: 'runc' as const,
        connect: () => openComputePreviewStream(command => peer.requestPreview(identity, command)) };
    } catch (error) { this.options.unavailable(input.orgId, input.runId, input.generation); throw error; }
  }
  async stop(orgId: string, runId: string, generation: number): Promise<void> {
    const key = this.key(orgId, runId, generation), active = this.active.get(key);
    if (!active) throw new Error('Compute preview stop is unconfirmed');
    try { await active.peer.requestPreview(active.identity, { method: 'stop' }); }
    finally { active.peer.signal.removeEventListener('abort', active.disconnected); this.active.delete(key); }
  }
}
