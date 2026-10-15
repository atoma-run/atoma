import { consolidatePrompt } from '../atoms/promptLearning.js';
import { RecordingRegistry } from '../viz/recordingRegistry.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LearningQueue } from '../skills/learningQueue.js';
import { SkillLifecycle } from '../skills/lifecycle.js';
import { SkillRegistry } from '../skills/registry.js';
import { openDb } from '../registry/db.js';
import { setLedgerScope } from '../core/ledger.js';
import { DEFAULT_LIMITS } from '../core/limits.js';
import { MetricsLlmClient } from '../core/metrics.js';
import { BudgetGateLlmClient, RunBudgetMeter } from '../core/runBudget.js';
import { RoutingLlmClient } from '../core/llmRouting.js';
import { jevDeciderFromEnv } from '../core/jev.js';
import type { LlmClient, RunContext } from '../core/types.js';
import { buildTierClients, assertTransportHonoursCredentials } from './providers.js';
import { platformLimitsFor } from '../platform/settings.js';
import { TraceRecorder } from '../viz/trace.js';
import { RecordingLlmClient } from '../viz/recordingLlm.js';
import { deploymentPaused } from '../viz/deployment.js';
import { peekDeploymentPending } from '../mcp/runLock.js';

export const LEARNING_TIMEOUT_MS = 240_000;
export const LEARNING_QUEUE_WAIT_MS = 240_000;

/** Runs in its own process: the ledger scope and lifecycle environment are process state. */
export async function executeApprovedLearning(dbPath: string, runId: string, env: NodeJS.ProcessEnv,
  options: { client?: LlmClient; signal?: AbortSignal; onClaim?: () => void } = {}): Promise<void> {
  const queue = new LearningQueue(dbPath);
  const job = queue.get(runId);
  if (!job) throw new Error('Approved learning job is unavailable');
  if (job.model !== env['ATOMA_MODEL_L2'] || job.lessons.some(lesson => lesson.host.model !== job.model || (lesson.kind === 'atom' && lesson.reviewerModel !== env['ATOMA_MODEL_L1']))) {
    throw new Error('Learning must retain its original model and payer');
  }
  // Same credential gate as the run; only the host resolver may authorize a resumed subscription.
  assertTransportHonoursCredentials(env);
  if (deploymentPaused(env) || peekDeploymentPending()) return;
  queue.recover();
  if ((job.budget.tokens !== null && job.budget.tokens <= 0) || (job.budget.costUsd !== null && job.budget.costUsd <= 0)) {
    queue.block(runId, 'The approved run has no remaining learning budget.');
    return;
  }
  const waiting = AbortSignal.any([AbortSignal.timeout(LEARNING_QUEUE_WAIT_MS), ...(options.signal ? [options.signal] : [])]);
  while (!queue.claim(runId)) {
    // Tenant work returns to the resident host for fresh authorization.
    // Operator children must survive their parent's exit while the slot is busy.
    if (job.scope || queue.receipt(runId)?.status !== 'pending') return;
    await delay(1000, undefined, { signal: waiting });
    if (deploymentPaused(env) || peekDeploymentPending()) return;
    queue.recover();
  }
  options.onClaim?.();
  // Admission may close between the first check and the claim. Publish the
  // claim before rechecking: deployment either sees it or this worker yields.
  if (deploymentPaused(env) || peekDeploymentPending()) {
    queue.finish(runId, 'pending');
    return;
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(LEARNING_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  const recorder = new TraceRecorder(join(job.runsPath, 'learning'));
  const trace = recorder.beginRun({ description: `Consolidate lessons from approved run ${runId}` }, `Learning ${runId}`, { runId: randomUUID() });
  const db = openDb(dbPath);
  try {
    const scope = job.scope ? { orgId: job.scope.orgId, projectId: job.scope.projectId,
      actorType: 'principal' as const, actorId: job.scope.principalId } : { actorType: 'cli' as const };
    setLedgerScope({ ...scope, runId });
    process.env['ATOMA_SKILL_PROMOTE'] = job.policy.promote ?? '0';
    // The run's own switch, carried by the job like promotion: the learner's
    // environment is the coordinator's, not the run's.
    process.env['ATOMA_SKILL_TRIGGER_EVAL'] = job.policy.triggerEval === '0' ? '0' : '1';
    if (job.policy.threshold === undefined) delete process.env['ATOMA_PROMOTE_THRESHOLD'];
    else process.env['ATOMA_PROMOTE_THRESHOLD'] = job.policy.threshold;
    const registry = new RecordingRegistry(db, recorder);
    const skills = new SkillRegistry(job.skillsPath, { db });
    const meter = new RunBudgetMeter({ record: call => queue.recordCall(runId, call) }, job.budget,
      error => controller.abort(error), undefined, queue.consumed(runId));
    const raw = options.client ?? new RoutingLlmClient(buildTierClients(env, { allowOwn: true, limits: platformLimitsFor(dbPath) }));
    const observed = new BudgetGateLlmClient(new MetricsLlmClient(new RecordingLlmClient(raw, recorder), meter), meter);
    const done = new Set(queue.completed(runId));
    const errors: string[] = [];
    const jev = jevDeciderFromEnv(env, info => recorder.recordJevDecision(info));
    const groups = new Map<string, number[]>();
    job.lessons.forEach((lesson, index) => {
      if (!done.has(index)) groups.set(lesson.owner, [...(groups.get(lesson.owner) ?? []), index]);
    });
    const outcomes = await Promise.allSettled([...groups.values()].map(async indices => {
      for (const index of indices) {
        signal.throwIfAborted();
        queue.startLesson(runId, index);
        const lesson = job.lessons[index]!;
        let failed = false;
        const ctx: RunContext = {
          signal, limits: DEFAULT_LIMITS,
          learningSource: { runId, lessonIndex: index },
          logger: { debug: message => console.log(message), info: message => console.log(message), warn: message => console.warn(message), error: message => console.error(message) },
          ...(jev ? { jev } : {}),
          recordSkill: info => recorder.recordSkillEvent({ ...info, ...(lesson.branchId ? { branchId: lesson.branchId } : {}) }),
          llm: {
            honoursEffort: model => observed.honoursEffort?.(model) ?? false,
            complete: async request => {
              signal.throwIfAborted();
              queue.callStarted(runId);
              try {
                const response = await observed.complete({ ...request, ...(lesson.branchId ? { branchId: lesson.branchId } : {}),
                  signal: AbortSignal.any([signal, ...(request.signal ? [request.signal] : [])]) });
                signal.throwIfAborted();
                return response;
              } catch (error) { failed = true; throw error; }
              finally { queue.callEnded(runId); }
            },
          },
        };
        if (lesson.kind === 'atom') {
          try { await consolidatePrompt(registry, lesson, ctx, { runId, index }); }
          catch (error) { failed = true; console.error(error); }
          if (failed) errors.push(`Prompt lesson ${index + 1} could not finish; see learning trace ${trace.id}`);
          else queue.completeLesson(runId, index);
          continue;
        }
        const lifecycle = new SkillLifecycle({ ...lesson.host,
          toLlmRequest: (role, args) => ({ model: lesson.host.model, role, userContent: args.userContent,
            systemPrompt: lesson.host.systemPrompt, actor: { name: lesson.host.name, tier: 2 },
            ...(lesson.host.context ? { context: lesson.host.context } : {}),
            ...(args.params ? { params: args.params } : {}), ...(args.signal ? { signal: args.signal } : {}) }),
        }, skills, ns => (db.prepare('SELECT name FROM atom_types WHERE atom_id = ?').get(ns) as { name: string } | undefined)?.name ?? ns);
        try { await lifecycle.learnLesson(lesson, ctx); }
        catch (error) { failed = true; console.error(error); }
        if (failed) errors.push(`Lesson ${index + 1} could not finish; see learning trace ${trace.id}`);
        else queue.completeLesson(runId, index);
      }
    }));
    for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(String(outcome.reason));
    if (errors.length) throw new Error(errors.join('; '));
    signal.throwIfAborted();
    recorder.endRun({ result: { summary: 'Approved lessons processed', output: { sourceRunId: runId },
      producedBy: { tier: 2, name: 'Skill learning', viaFallback: false } } });
    queue.finish(runId, 'completed');
  } catch (error) {
    // Model prose, credentials and host paths stay in the private trace, never the public receipt.
    recorder.endRun({ error: String(error) });
    queue.finish(runId, 'failed', `Learning did not finish; see learning trace ${trace.id}`);
  } finally { db.close(); setLedgerScope(null); }
}
