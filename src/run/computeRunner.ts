import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectComputeBridge } from './computeBridge.js';
import { computeToolBackend } from './computeToolBackend.js';
import { localToolBackend } from './toolBackend.js';
import { remoteWorkspaceRuntime } from './workspaceRpc.js';
import { provisionWorkspaceSource } from './workspaceImport.js';
import { captureCheckpointExport } from './checkpointExport.js';
import { captureManifestExport } from './artifactTransfer.js';
import type { ReadRunsIndex } from '../contracts/readRuns.js';
import { consoleLogger } from './runner.js';

/** Host declarations come from this build. No device-authored catalogue is trusted. */
export async function computeRunnerOptions(address: unknown) {
  const bridge = await connectComputeBridge(address);
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), 'atoma-compute-catalogue-'));
    const catalogue = localToolBackend({ workspaceRoot: root, logger: consoleLogger });
    const declarations = catalogue.toolDecls;
    await catalogue.cleanup();
    const workspaceRuntime = remoteWorkspaceRuntime(command => bridge.send({ channel: 'workspace', command }));
    return { close: bridge.close, workspaceRuntime,
      prepareWorkspaceSources: async (input: { seedRoot?: string; readRuns?: ReadRunsIndex }) => {
        // Host paths never cross the remote boundary. The service resolves ids in its private source volume.
        await workspaceRuntime.bindSources!({ seed: Boolean(input.seedRoot),
          ...(input.readRuns ? { readRuns: { ...input.readRuns, readRuns: input.readRuns.readRuns.map(run => ({ ...run, workspacePath: 'remote-source' })) } } : {}) });
        if (input.seedRoot) await provisionWorkspaceSource(workspaceRuntime, { kind: 'seed' }, captureCheckpointExport(input.seedRoot));
        for (const run of input.readRuns?.readRuns ?? []) {
          await provisionWorkspaceSource(workspaceRuntime, { kind: 'read-run', runId: run.runId }, captureManifestExport(run.workspacePath, run.manifest));
        }
      },
      createToolBackend: async () => computeToolBackend({ declarations, send: command => bridge.send({ channel: 'tools', command }) }) };
  } catch (error) { bridge.close(); throw error; }
  finally { if (root) rmSync(root, { recursive: true, force: true }); }
}
