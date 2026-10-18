import type { WorkspaceRuntime, AsyncReadOnlyPhases } from '../contracts/workspaceRuntime.js';
import type { ReadRunsIndex } from '../contracts/readRuns.js';
import type { ReadOnlyPhases } from '../contracts/readOnlyPhase.js';
import { readOnlyPhasesFor } from './readOnlyPhase.js';
import { readRoutingRepository } from './routingRepository.js';
import { snapshotDeliveredWorkspace } from './workspace.js';
import { readInheritedWorkspaceState, rewriteManifest } from './inheritedChecks.js';
import { captureCheckpointExport } from './checkpointExport.js';
import { checkpointWorkspaceDigest } from './checkpointWorkspace.js';
import { captureReadRunCopies, checkReadRunCopies, compareReadRunFiles, type ReadRunCopyIdentities } from './readRuns.js';

/** The hosted implementation and the workspace service share these exact operations. */
export function localWorkspaceRuntime(options: {
  root: string;
  readRuns?: ReadRunsIndex;
  log: (line: string) => void;
}): WorkspaceRuntime {
  let identities: ReadRunCopyIdentities | undefined;
  return {
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
