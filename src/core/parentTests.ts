import { createHash } from 'node:crypto';
import { parentTestObservationSchema, type ParentTestObservation } from '../contracts/parentTests.js';
import { abortedForLanding } from './limits.js';
import { baseExecutorOf } from './attestation.js';
import type { NegativeVerdict, Result, RunContext, Task } from './types.js';

/** Canonical bytes stay on the control plane. Only disposable copies cross into the worker. */
export async function verifyParentTests(task: Task, result: Result, ctx: RunContext): Promise<Result> {
  const suite = task.acceptanceTests;
  if (!suite) return result;
  if (!abortedForLanding(ctx)) ctx.signal.throwIfAborted();
  const suiteDigest = createHash('sha256').update(JSON.stringify(suite)).digest('hex');
  let observation: ParentTestObservation = {
    suiteDigest, suite, workspaceDigest: '', status: 'unavailable', passed: 0, failed: 0, skipped: 0,
    details: 'No shell executor is available for the parent-owned suite.',
  };
  if (result.unfinishedPhases?.length || abortedForLanding(ctx)) {
    observation = { ...observation, details: 'Not run: the plan landed with unfinished work or exhausted its run budget.' };
  } else if (ctx.tools?.has('run_shell')) {
    try {
      const timeoutMs = Math.max(1, Math.min(120_000, (ctx.deadlineAt ?? Date.now() + 120_000) - Date.now()));
      const raw = await baseExecutorOf(ctx.tools).execute('run_shell', {
        command: 'atoma-verify', args: [JSON.stringify(suite)], timeoutMs,
      });
      const parsed = parentTestObservationSchema.safeParse(raw);
      observation = parsed.success && parsed.data.suiteDigest === suiteDigest ? { ...parsed.data, suite }
        : { ...observation, details: 'The verification worker returned no valid observation for this suite.' };
    } catch (error) {
      if (!abortedForLanding(ctx)) ctx.signal.throwIfAborted();
      observation = { ...observation, details: `Verification unavailable: ${String(error).slice(0, 1000)}` };
    }
  }
  if (!abortedForLanding(ctx)) ctx.signal.throwIfAborted();
  const summary = `PARENT ACCEPTANCE TESTS (observed on the named snapshot; later edits are not covered): ${JSON.stringify(observation)}`;
  return { ...result, parentTests: [...(result.parentTests ?? []), observation],
    summary: `${summary}\n${result.summary}`,
    ...(abortedForLanding(ctx) && observation.status !== 'passed'
      ? { unfinishedPhases: [...(result.unfinishedPhases ?? []), `acceptance tests: ${task.description}`] } : {}),
    ...(observation.status !== 'passed' ? { refusal: `Parent-owned acceptance suite ${observation.status}: ${observation.details}` } : {}),
  };
}

export function parentTestRefusal(result: Result): NegativeVerdict | undefined {
  const failed = result.parentTests?.filter(check => check.status !== 'passed');
  if (!failed?.length) return undefined;
  const reasoning = `Parent-owned acceptance checks did not pass: ${JSON.stringify(failed.map(check => ({ suiteDigest: check.suiteDigest, status: check.status, details: check.details }))).slice(0, 12000)}. Repair the implementation; if a test contradicts the assigned requirement, explain the conflict to the parent for a reviewed revision. Do not edit or bypass its suite.`;
  return { approved: false, reasoning, scope: 'ephemeral', modifications: { additionalContext: reasoning } };
}
