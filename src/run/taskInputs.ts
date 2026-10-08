import { decodeProjectContext, PROJECT_CONTEXT_ENV } from '../contracts/projectContext.js';
import type { Task } from '../core/types.js';
import { decodePreviousLanding, PREVIOUS_LANDING_ENV } from '../contracts/runLanding.js';
import { decodePreviousResults, PREVIOUS_RESULTS_ENV } from '../contracts/previousRunResults.js';

/** Host-authored context crosses the process boundary as data, never goal text. */
export function withPreviousRunInputs(task: Task, env: NodeJS.ProcessEnv): Task {
  const projectContext = decodeProjectContext(env[PROJECT_CONTEXT_ENV]);
  const inputs = { ...task.inputs };
  delete inputs['projectContext'];
  const landing = decodePreviousLanding(env[PREVIOUS_LANDING_ENV]);
  const results = decodePreviousResults(env[PREVIOUS_RESULTS_ENV]);
  return { ...task, inputs: { ...inputs,
    ...(projectContext && (projectContext.brief || projectContext.decisions.length) ? { projectContext } : {}),
    ...(landing.length ? { previousRunLanding: landing } : {}),
    ...(results ? { previousRunResults: results } : {}),
  } };
}
