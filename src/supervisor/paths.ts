import { join, resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import { computeValidationLaunchSchema, type ComputeValidationLaunch } from '../contracts/computeValidation.js';

/**
 * WHERE THE SUPERVISOR WRITES, resolved once.
 *
 * The analyst's verdicts, backlog and alerts live under a git-ignored
 * `supervisor/` directory beside the store, overridable with
 * `ATOMA_SUPERVISOR_DIR`. The resident analyst (viz server), the analyst CLI
 * and the MCP verdict readers all have to agree on that directory, so the
 * resolution lives here rather than being spelled three times — the same
 * one-rule-one-home argument `runsDirPath` and `skillsDirPath` rest on.
 */
export function supervisorDirPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env['ATOMA_SUPERVISOR_DIR'] ?? './supervisor');
}

/** One verdict per run: `<supervisorDir>/verdicts/<runId>.json`. */
export function verdictsDirPath(supervisorDir: string): string {
  return join(supervisorDir, 'verdicts');
}

/** Automatic and explicit attempts share this layout; retries never overwrite their source. */
export function computeValidationDirPath(supervisorDir: string, launch: ComputeValidationLaunch): string {
  const scope = computeValidationLaunchSchema.parse({ sourceRunId: launch.sourceRunId, orgId: launch.orgId,
    projectId: launch.projectId, ...(launch.attemptId ? { attemptId: launch.attemptId } : {}) });
  const root = join(supervisorDir, 'compute-validation', scope.sourceRunId);
  return scope.attemptId ? join(root, 'attempts', scope.attemptId) : root;
}

/** Host-resolved evidence only. Refuse links at every level below the configured root. */
export function computeValidationEvidenceFile(supervisorDir: string, launch: ComputeValidationLaunch,
  validationRunId: string, section: 'trace' | 'log'): string | null {
  if (!computeValidationLaunchSchema.shape.sourceRunId.safeParse(validationRunId).success) return null;
  const directory = computeValidationDirPath(supervisorDir, launch);
  const file = section === 'log' ? join(directory, 'run.log') : join(directory, 'runs', `${validationRunId}.json`);
  const parts = ['compute-validation', launch.sourceRunId, ...(launch.attemptId ? ['attempts', launch.attemptId] : []),
    ...(section === 'log' ? ['run.log'] : ['runs', `${validationRunId}.json`])];
  let current = supervisorDir;
  try {
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return null;
    }
  } catch { return null; }
  return file;
}
