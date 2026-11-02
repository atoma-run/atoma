import { Atom } from '../core/atom.js';
import { modelFacingExecutor } from '../core/attestation.js';
import { capToolIterations } from '../core/limits.js';
import { modelForTier } from '../core/models.js';
import type { Plan, Result, RunContext, Task, Tool } from '../core/types.js';
import type { DeliveryKind } from '../contracts/taskExecution.js';
import { compareStartingWorkspace } from '../contracts/startingWorkspace.js';
import { observedDelivery } from '../atoms/rootAcceptance.js';
import { executorEvidence } from '../atoms/executorEvidence.js';
import { withAutomaticLoopbackHttpRecording } from '../atoms/L1Atom.js';
import { withProbeExecutionHistory } from '../atoms/probeExecutionHistory.js';
import { TASK_CONTEXT_HEADER, taskContextLines } from '../atoms/taskContext.js';
import { toolInvocationSucceeded } from '../atoms/validationLedger.js';
import { BASELINE_MAX_TOKENS, BASELINE_MAX_TOOL_ITERATIONS } from './baseline.js';

/**
 * DIRECT DEPTH — the default topology since 2026-11-01
 * (docs/decisions/direct-depth-2026-11-01.md).
 *
 * ONE executor with the run's tools carries the whole task, and the HOST
 * judges the result at root acceptance exactly as it judges a tissue's: the
 * same acceptance checklist, attestation log, result gates, refusal and one
 * remediation pass, landing, declared manifest, preview and publication. What
 * it drops is what fifteen controlled rounds found buys no correctness on any
 * task family measured: planning, plan and result validators, peers, replans,
 * the prefilter, recipes and learning.
 *
 * WHY IT IS NOT THE BASELINE. `--baseline` is the control arm of a
 * measurement: it self-certifies, reads only the goal, writes nothing to the
 * store and records no root plan, so a project run on it could be neither
 * reviewed, previewed nor published. This executor runs the same tool loop on
 * the same budget, and is handed what the product owes every executor: the
 * task context (`taskContextLines`, the checklist and inputs a remediation
 * pass reads its refusal from), the loopback HTTP recording molecules use, and
 * a root plan the host can classify and persist.
 *
 * WHY TIER 1 ON THE L3 PIN. A molecule is the only rank that invokes
 * elements (src/tools/AGENTS.md). Root acceptance runs the DELEGATED gates
 * over its result, never the leaf ones a cell runs over a molecule: those read
 * a molecule's JSON envelope (`output.probes`) and its `record_probe`
 * manifest, which this plain-text report never carries, so they raised false
 * findings and refused correct passes (review 2026-11-01). Its MODEL is the organisation's top pin: the one agent
 * carrying a whole task is the frontier agent the rounds measured, never the
 * cheapest molecule model. That selector was authorised at launch as `l3`;
 * nothing here widens what the run may spend.
 */

export const DIRECT_ATOM_NAME = 'Direct';

/**
 * The control arm's measured prompt, plus one fact the product adds: who
 * judges the work and from what. Nothing atoma-specific is taught here
 * either; the run's own policies (the TypeScript rule, verification reuse)
 * reach it through the task context, as they reach every executor.
 */
export const DIRECT_SYSTEM_PROMPT = [
  'You are a senior software engineer working directly in a sandboxed project directory.',
  '',
  'Use the tools you are given: they read, write, edit and list files, run shell commands,',
  'start a static or Node HTTP server, fetch a URL, and may load a page in a headless browser.',
  'Your working directory is the project directory; write all deliverables there.',
  '',
  'Complete the task end to end:',
  '  - write the files the task asks for;',
  '  - actually run what you build and check it behaves as specified;',
  '  - fix what does not work and re-check.',
  '',
  'The host then judges your work against the task and its acceptance list from the tool calls',
  'it recorded, not from your report: a check you did not run is not evidence. When the task only',
  'asks a question, answer it in your report without changing files.',
  '',
  'Work until the task is genuinely done, then reply with a short plain-text report of',
  'what you built, how you verified it, and anything you could not complete.',
  'End the report with one line, exactly "DELIVERY: files" when the task asked you to create or',
  'change files in the project, or exactly "DELIVERY: text" when it only asked for an answer.',
].join('\n');

/** The report's last line, as the system prompt asks for it. Anything else declares nothing. */
const DELIVERY_LINE = /^DELIVERY:\s*(files|text)\s*$/i;

/** What each direct result's report declared, held by the host beside the result. */
const declarations = new WeakMap<Result, DeliveryKind>();

/**
 * The report without its declaration line, and the delivery that line
 * declared. Only the LAST non-empty line counts, matched whole against the
 * two values the prompt names; anywhere else, or anything else, is report.
 */
export function splitDeliveryDeclaration(text: string): { readonly report: string; readonly declared?: DeliveryKind } {
  const lines = text.trimEnd().split('\n');
  const match = DELIVERY_LINE.exec((lines.at(-1) ?? '').trim());
  if (!match) return { report: text.trim() };
  return { report: lines.slice(0, -1).join('\n').trim(), declared: match[1]!.toLowerCase() as DeliveryKind };
}

/** The task as the direct executor reads it: the goal, then the context every executor reads. */
export function renderDirectUserContent(task: Task, hasShell: boolean): string {
  const context = taskContextLines(task, { includeAcceptanceChecklist: true, executor: true, hasShell });
  return [`TASK:\n${task.description}`, ...(context.length > 0 ? ['', TASK_CONTEXT_HEADER, ...context] : [])].join('\n');
}

export class DirectAtom extends Atom {
  readonly tier = 1 as const;
  readonly model: string;

  constructor(tools: readonly Tool[], model: string = modelForTier(3)) {
    super({ name: DIRECT_ATOM_NAME, ordinal: 0, systemPrompt: DIRECT_SYSTEM_PROMPT, tools: [...tools],
      params: { maxTokens: BASELINE_MAX_TOKENS } });
    this.model = model;
  }

  /**
   * One phase, the whole task, and NO declared delivery. Recorded before the
   * first pass's first tool call, it is what the host persists as the declared
   * manifest, and what lets a pass the run budget cuts land `partial` with its
   * workspace kept (`landedBeforeAnyPhase`). The delivery is recorded after
   * the pass (`directDelivery`).
   */
  plan(task: Task): Promise<Plan> {
    return Promise.resolve({
      reasoning: 'Direct depth: one executor carries the whole task; the host judges the result at root acceptance.',
      subtasks: [{ description: task.description }],
      aggregation: { mode: 'concat' },
      expectedOutput: 'The task completed in the workspace, and a plain-text report of what was done and how it was checked.',
    });
  }

  async execute(task: Task, _plan: Plan, ctx: RunContext): Promise<Result> {
    const tools = this.tools;
    const observed: Array<{ name: string; ok: boolean }> = [];
    const resp = await ctx.llm.complete(this.toLlmRequest('execute', {
      userContent: renderDirectUserContent(task, tools.some((tool) => tool.name === 'run_shell')),
      tools: [...tools],
      params: this.params,
      // The attested executor of this pass: every call is the host's evidence.
      ...(ctx.tools ? { executor: modelFacingExecutor(withProbeExecutionHistory(withAutomaticLoopbackHttpRecording(ctx.tools))) } : {}),
      signal: ctx.signal,
      // The control arm's budget, for the reason `BASELINE_MAX_TOOL_ITERATIONS`
      // states: one loop does the whole job, so the run's wall clock is what
      // stops it, never an iteration count sized for one molecule's subtask.
      maxToolIterations: capToolIterations(BASELINE_MAX_TOOL_ITERATIONS, ctx.deadlineAt),
      onToolInvocation: (info) => {
        if (observed.length < 64) observed.push({ name: info.name, ok: toolInvocationSucceeded(info) });
      },
    }));
    const { report: text, declared } = splitDeliveryDeclaration(resp.text ?? '');
    const result: Result = {
      output: text,
      summary: text.split('\n').find((line) => line.trim().length > 0)?.slice(0, 300) ?? 'the direct executor produced no report',
      trace: [],
      producedBy: { tier: this.tier, name: this.name, viaFallback: false },
      toolCallResults: observed,
      ...(resp.toolBudgetExhausted ? { toolBudgetExhausted: true as const } : {}),
      evidence: executorEvidence(text, ctx),
    };
    if (declared) declarations.set(result, declared);
    return result;
  }
}

/**
 * What a direct pass delivered. A deep root plan DECLARES `text` for a
 * question; with no planner, the executor declares it on its report's last
 * line, and the host bounds what that declaration may say:
 *
 * 1. FILES whenever this attempt attested a write or an edit, whatever was
 *    declared: written files are never judged, recorded or published as a
 *    mere answer.
 * 2. Otherwise the DECLARATION. Checking an answer has side effects (an
 *    install writes a lockfile, a build writes `dist/`, a test runner its
 *    reports), and a seed over the snapshot's bounds can never compare equal,
 *    so observation alone sent most questions on a real repository to the
 *    report-blind criteria review (review 2026-11-01).
 * 3. With no declaration, OBSERVATION: a seeded workspace that no longer
 *    matches its start (or cannot be compared) is files, one that matches is
 *    text; a run with no seed falls back to `observedDelivery`.
 */
export async function directDelivery(ctx: RunContext, declared?: DeliveryKind): Promise<DeliveryKind> {
  const records = ctx.attestations?.forAttempt(ctx.attempt ?? 1) ?? [];
  if (records.some((record) => record.tool === 'write_file' || record.tool === 'edit_file')) return 'files';
  if (declared) return declared;
  const seeded = ctx.startingWorkspace;
  if (!seeded) return observedDelivery(ctx);
  try {
    const comparison = compareStartingWorkspace(seeded.start, await seeded.now());
    const changed = comparison.changes.length > 0 || comparison.added.length > 0 ||
      comparison.startTruncated || comparison.addedTruncated;
    return changed ? 'files' : 'text';
  } catch {
    return 'files';
  }
}

/** The input a direct executor's second execution reads after its first stopped on an error. */
export const DIRECT_RETRY_INPUT = 'directRetry';

/**
 * The root handle of a direct attempt: record the one-phase plan, run it, then
 * record what it delivered.
 *
 * AN EXECUTION THAT FAILS ON ITS OWN IS RUN ONCE MORE, on the same workspace.
 * A supervised run's cell retries a failed molecule; with no cell, one
 * transport error twenty minutes in would end the run `failed`, and a failed
 * run seeds nothing (`previousSeedRun`), which is production run 6ab0ae3b's
 * loss. The run budget and its deadline abort the context and are rethrown,
 * so the depth runner lands as it always has. A cancellation ends the run's
 * process group, a retry already started included. A second failure is the
 * run's.
 */
export function directRootHandle(atom: DirectAtom): (task: Task, context: RunContext) => Promise<Result> {
  return async (task, context) => {
    const plan = await atom.plan(task);
    // The delivery-less plan only before the FIRST pass: a remediation pass
    // re-recording it would leave a manifest with no delivery behind it if
    // that pass then failed and the run landed on the earlier, judged one.
    if (task.inputs?.['rootAcceptanceAttempt'] === undefined) context.recordRootPlan?.(plan);
    let result: Result;
    try {
      result = await atom.execute(task, plan, context);
    } catch (error) {
      if (context.signal.aborted) throw error;
      const why = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300);
      context.logger.warn(`[${atom.name}] the execution stopped on an error (${why}); one more execution on the same workspace`);
      result = await atom.execute({ ...task, inputs: { ...task.inputs, [DIRECT_RETRY_INPUT]:
        `The previous execution of this task stopped on an error before it reported (${why}). Its files and installed ` +
        'dependencies remain in the workspace, unverified. Inspect and complete that work instead of rebuilding it.' } }, plan, context);
    }
    // The same plan, now with the delivery the host observed: root acceptance
    // judges it, and the declared manifest records it (a text delivery after
    // a file one is kept files by the depth runner).
    context.recordRootPlan?.({ ...plan, delivery: await directDelivery(context, declarations.get(result)) });
    return result;
  };
}
