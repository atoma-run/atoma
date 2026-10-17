import { decodeProjectContext, PROJECT_CONTEXT_ENV } from '../contracts/projectContext.js';
import type { Task } from '../core/types.js';
import { decodePreviousLanding, PREVIOUS_LANDING_ENV } from '../contracts/runLanding.js';
import { decodePreviousResults, PREVIOUS_RESULTS_ENV } from '../contracts/previousRunResults.js';
import type { ConnectorLaunchSet } from '../contracts/mcpConnectors.js';
import { readRunsInput, type ReadRunsIndex } from '../contracts/readRuns.js';

/** Host-authored context crosses the process boundary as data, never goal text. */
export function withPreviousRunInputs(task: Task, env: NodeJS.ProcessEnv, connectors: ConnectorLaunchSet | null = null,
  readRuns: ReadRunsIndex | null = null): Task {
  const projectContext = decodeProjectContext(env[PROJECT_CONTEXT_ENV]);
  const inputs = { ...task.inputs };
  delete inputs['projectContext'];
  // A resumed root carries the inputs it saved; this run's servers replace them.
  delete inputs['availableMcpServers'];
  // So do the read-run copies: this run's own launch index lists them.
  delete inputs['readRuns'];
  // Identity and availability only: the URL and the credential stay in the run process.
  const availableMcpServers = connectors?.connectors.map(connector => ({
    server: connector.key, name: connector.name,
    ...(connector.status === 'ready' ? { available: true } : { available: false, reason: connector.reason }),
  }));
  const landing = decodePreviousLanding(env[PREVIOUS_LANDING_ENV]);
  const results = decodePreviousResults(env[PREVIOUS_RESULTS_ENV]);
  return { ...task, inputs: { ...inputs,
    ...(projectContext && (projectContext.brief || projectContext.decisions.length) ? { projectContext } : {}),
    ...(landing.length ? { previousRunLanding: landing } : {}),
    ...(results ? { previousRunResults: results } : {}),
    ...(availableMcpServers?.length ? { availableMcpServers } : {}),
    // Where each copy is and what it holds, never its files (src/contracts/readRuns.ts).
    ...(readRuns ? { readRuns: readRunsInput(readRuns) } : {}),
  } };
}
