import { MIN_PHASE_LANDING_MS, MIN_TOOL_ITERATION_MS } from '../core/limits.js';
import type { RunContext, Task } from '../core/types.js';
import { proofObligationLines } from './L1Atom.js';
import { EXISTING_FILE_GUIDANCE, TEST_ONLY_ELEMENT_GUIDANCE } from './prompts.js';
import { anyUncovered, checkProofCoverage, type ProofCoverage } from './proofCoverage.js';

/**
 * A FALLBACK EXECUTOR'S PROOF OBLIGATIONS (owner decision 2026-10-01).
 *
 * A molecule hears its phase's declared obligation and its supervisor checks
 * it from the attestation log. A cell or tissue that executes the task itself
 * heard nothing of it and nobody checked it: its supervision loop has no
 * supervisor above the executor, and the tier that judges its result reads
 * another branch. So a fallback hears the obligation like a molecule; its own
 * calls are checked when it is done; an uncovered obligation earns it ONE
 * bounded turn that runs only the missing proof, when the run deadline leaves
 * room for it; and what its calls finally proved rides its result up
 * (`Result.proofCoverage`) to the tier that judges it, which withholds its
 * credit when the proof is still missing.
 */

/** Tool iterations of the proof turn: a server start, a few checks, a manifest write. */
export const FALLBACK_PROOF_TURN_ITERATIONS = 10;

/**
 * Below this much run time left, no proof turn: its iterations at their
 * measured floor, plus a landing reserve for the validation of this phase and
 * the one after it (review 2026-10-01: 180 s left the phase's own validation
 * under `MIN_PHASE_LANDING_MS`, a credit bought with a delivery).
 */
export const FALLBACK_PROOF_TURN_MIN_MS = 2 * MIN_PHASE_LANDING_MS + FALLBACK_PROOF_TURN_ITERATIONS * MIN_TOOL_ITERATION_MS;

/** The obligation lines a fallback executor reads, as a molecule reads them. */
export function fallbackObligationLines(task: Task, validatesPages: boolean): string[] {
  return proofObligationLines(task, validatesPages);
}

/** The user message of the proof turn: a fresh call, so it carries what it needs to act alone. */
export function fallbackProofTurnContent(args: {
  task: Task;
  coverage: readonly ProofCoverage[];
  previousSummary: string;
  servedUrl: string | null;
}): string {
  const { task } = args;
  return [
    `PROOF STILL MISSING. Your work on this task is done, but the calls you made did not cover`,
    `the proof obligation the phase declared:`,
    ...args.coverage.filter((item) => !item.covered).map((item) => `- ${item.reason}`),
    ``,
    `Task: ${task.description}`,
    task.inputs ? `Inputs: ${JSON.stringify(task.inputs).slice(0, 2_000)}` : '',
    `Your result: ${args.previousSummary.slice(0, 2_000)}`,
    args.servedUrl
      ? `You served the page at ${args.servedUrl}; use it if it still answers, or serve it again.`
      : `Serve the page with the tool you hold.`,
    ``,
    ...proofObligationLines(task, true),
    TEST_ONLY_ELEMENT_GUIDANCE,
    EXISTING_FILE_GUIDANCE,
    ``,
    `Run ONLY the missing proof now, on the files as they are: validate_html with real "interactions"`,
    `(click, type, keypress, select by selector) and a smoke that only READS the state they produced.`,
    task.readOnly
      ? `This phase is read-only: change no file; report a defect the check shows, for another phase to fix.`
      : `Change a file only if that check shows a defect, and then check it again.`,
    `Then return the final JSON {"output", "summary"}: the summary says what the check observed.`,
  ].join('\n');
}

/** The URL of the first page the fallback checked, from its own attested calls. */
function servedUrlOf(ctx: RunContext, since: number): string | null {
  for (const record of (ctx.attestations?.forBranch(ctx.currentBranchId) ?? []).slice(since)) {
    if (record.observation.kind === 'browser' && record.observation.url) return record.observation.url;
  }
  return null;
}

/**
 * Check what a fallback's own calls proved, from record `since` of its branch,
 * and run the proof turn once when they left an obligation uncovered.
 * `proofTurn` makes that call and returns its text. A cancellation or a
 * deepening during it propagates, as it would during the first turn.
 */
export async function proveFallback(args: {
  ctx: RunContext;
  task: Task;
  since: number;
  holdsTools: boolean;
  validatesPages: boolean;
  previousSummary: string;
  actorName: string;
  proofTurn: (userContent: string, maxToolIterations: number) => Promise<string>;
}): Promise<{ readonly coverage: ProofCoverage[]; readonly proofTurnText: string | null }> {
  const obligations = args.task.proofObligations ?? [];
  if (obligations.length === 0) return { coverage: [], proofTurnText: null };
  // A fallback with no tools proved nothing: it is not better placed than one that tried.
  if (!args.holdsTools) {
    return {
      coverage: obligations.map((obligation) => ({
        obligation, covered: false, reason: `${obligation} NOT covered: the fallback held no tools.`, eventIds: [],
      })),
      proofTurnText: null,
    };
  }
  const first = await checkProofCoverage({ ctx: args.ctx, obligations, since: args.since });
  if (!anyUncovered(first)) return { coverage: first, proofTurnText: null };
  const left = args.ctx.deadlineAt === undefined ? Infinity : args.ctx.deadlineAt - Date.now();
  if (!args.validatesPages || args.ctx.signal.aborted || left < FALLBACK_PROOF_TURN_MIN_MS) {
    args.ctx.logger.warn(
      `[${args.actorName}] fallback left a proof obligation uncovered and ${args.validatesPages ? 'too little run time remains' : 'cannot validate a page'} for a proof turn — its credit will be withheld`
    );
    return { coverage: first, proofTurnText: null };
  }
  args.ctx.logger.warn(`[${args.actorName}] fallback left a proof obligation uncovered — one proof turn`);
  let proofTurnText: string | null;
  try {
    proofTurnText = await args.proofTurn(
      fallbackProofTurnContent({ task: args.task, coverage: first, previousSummary: args.previousSummary, servedUrl: servedUrlOf(args.ctx, args.since) }),
      FALLBACK_PROOF_TURN_ITERATIONS
    );
  } catch (err) {
    if (args.ctx.signal.aborted) throw err;
    args.ctx.logger.warn(`[${args.actorName}] fallback proof turn failed: ${(err as Error).message}`);
    proofTurnText = null;
  }
  return { coverage: await checkProofCoverage({ ctx: args.ctx, obligations, since: args.since }), proofTurnText };
}
