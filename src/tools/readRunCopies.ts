import { relative, sep } from 'node:path';
import { READ_RUNS_DIRECTORY } from '../contracts/readRuns.js';
import type { ToolSandbox } from './sandbox.js';

/**
 * NOTHING A MODEL-FACING TOOL WRITES LANDS IN A READ-RUN COPY (second review
 * 2026-10-17). The copies of other runs' saved files (`.atoma-runs/<run id>/…`,
 * src/contracts/readRuns.ts) keep their saved modes, so a file restored FROM
 * them with `cp` is writable and executable as saved; that made them
 * writable to `write_file` and `edit_file` too, and `blindOverwrite` exempts
 * every `.atoma*` path. A molecule told to make a whole-tree lint pass would
 * "fix" errors inside a copy, or a restore would write in the wrong
 * direction, and the copy would be worthless for the rest of the run.
 *
 * Keyed on where the write LANDS, links followed, and case-blind on the
 * directory, as the probe manifest's refusal is: a refusal, never an
 * admission. A shell is not refused: the host's check at root acceptance
 * reports any change it makes, and `cp` restores must keep working.
 */
export function writesIntoReadRunCopies(sandbox: ToolSandbox, path: string): boolean {
  try {
    const rel = relative(sandbox.realPath('.'), sandbox.realPath(path));
    return rel.split(sep)[0]!.toLowerCase() === READ_RUNS_DIRECTORY;
  } catch {
    // A path the sandbox refuses to resolve is not a copy; the tool itself
    // surfaces the real containment error.
    return false;
  }
}

export function readRunCopyWriteRefusal(tool: string): string {
  return `${tool}: refuse to write into ${READ_RUNS_DIRECTORY}/, the copies of other runs' saved files, which stay unchanged. ` +
    `To restore a file, copy it FROM its copy (run_shell cp ${READ_RUNS_DIRECTORY}/<run id>/<path> <path>), or read it and ` +
    'write the workspace path. Nothing was written.';
}
