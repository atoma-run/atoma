import type { WorkspaceRuntime, AsyncReadOnlyPhases } from '../contracts/workspaceRuntime.js';
import { READ_RUNS_DIRECTORY, READ_RUN_COPIES_DIRECTORY, type ReadRunsIndex } from '../contracts/readRuns.js';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadOnlyPhases } from '../contracts/readOnlyPhase.js';
import { readOnlyPhasesFor } from './readOnlyPhase.js';
import { readRoutingRepository } from './routingRepository.js';
import { snapshotDeliveredWorkspace, snapshotStartingWorkspace, prepareWorkspace, seedWorkspace, describeSeedManifest } from './workspace.js';
import { readInheritedWorkspaceState, rewriteManifest } from './inheritedChecks.js';
import { captureCheckpointExport } from './checkpointExport.js';
import { checkpointWorkspaceDigest } from './checkpointWorkspace.js';
import { WorkspaceImport } from './workspaceImport.js';
import { captureReadRunCopies, checkReadRunCopies, compareReadRunFiles, ensureReadRunMountPoint, legacyReadRunCopy,
  materialiseReadRuns, removeReadRunCopies, type ReadRunCopyIdentities } from './readRuns.js';

/** The hosted implementation and the workspace service share these exact operations. */
export function localWorkspaceRuntime(options: {
  root: string;
  seedRoot?: string;
  readRuns?: ReadRunsIndex;
  log: (line: string) => void;
}): WorkspaceRuntime {
  let identities: ReadRunCopyIdentities | undefined;
  const validateSources = async () => {
    if (options.seedRoot && !existsSync(options.seedRoot)) throw new Error(`--seed: no such directory: ${options.seedRoot}`);
  };
  const seed = () => {
    if (options.seedRoot) {
      const report = seedWorkspace(options.seedRoot, options.root);
      options.log(`workspace seeded from ${options.seedRoot} (${report.entries} entries)`);
      const manifest = describeSeedManifest(report);
      if (manifest) options.log(manifest);
    }
    if (options.readRuns) {
      const report = materialiseReadRuns(options.root, options.readRuns);
      options.log(`read runs copied: ${report.files} files (${report.bytes} bytes) of ${report.runs} run(s), with their saved modes, into ${READ_RUN_COPIES_DIRECTORY}/`);
    }
    mkdirSync(options.root, { recursive: true });
  };
  return {
    importWorkspace: async (header, archive) => new WorkspaceImport(options.root, header, archive),
    validateSources,
    prepare: async clean => { await validateSources(); prepareWorkspace(options.root, clean, options.log); seed(); },
    restart: async () => {
      // Archive first. A disappeared seed must leave the first attempt intact.
      const archived = prepareWorkspace(options.root, true, options.log);
      if (options.readRuns && archived) {
        const failure = await removeReadRunCopies(join(archived, READ_RUNS_DIRECTORY));
        if (failure) options.log(`read-run copies left in the archive ${archived}: ${failure}`);
      }
      seed();
      if (options.readRuns) ensureReadRunMountPoint(options.root);
      identities = undefined;
    },
    startingSnapshot: async () => options.seedRoot ? snapshotStartingWorkspace(options.seedRoot) : null,
    ensureReadRuns: async () => {
      if (!options.readRuns) return null;
      const legacy = legacyReadRunCopy(options.root, options.readRuns);
      if (legacy) return legacy;
      ensureReadRunMountPoint(options.root);
      return null;
    },
    canonicalPath: async () => realpathSync(options.root),
    checkpointDigest: async () => checkpointWorkspaceDigest(options.root),
    checkpointExport: async () => captureCheckpointExport(options.root),
    routingRepository: async () => readRoutingRepository(options.root),
    deliveredSnapshot: async start => snapshotDeliveredWorkspace(options.root, start),
    captureReadRuns: async () => {
      if (options.readRuns) identities = captureReadRunCopies(options.root, options.readRuns);
    },
    checkReadRuns: async () => options.readRuns ? checkReadRunCopies(options.root, options.readRuns, identities) : [],
    compareReadRuns: async criteria => options.readRuns
      ? compareReadRunFiles(options.root, options.readRuns, criteria) : { compared: [], omitted: 0 },
    readOnlyPhases: asyncReadOnlyPhases(readOnlyPhasesFor(options.root, options.log)),
    inheritedState: async () => readInheritedWorkspaceState(options.root),
    replaceManifest: async (text, expected) => rewriteManifest(options.root, text, expected),
  };
}

function asyncReadOnlyPhases(phases: ReadOnlyPhases): AsyncReadOnlyPhases {
  return {
    begin: async (phase, attempt) => {
      const guard = phases.begin(phase, attempt);
      return { end: async record => guard.end(record) };
    },
    restorations: () => phases.restorations(),
  };
}
