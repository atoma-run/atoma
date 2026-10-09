import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { runDepthTask } from '../src/run/depth.js';
import { createAttestationLog } from '../src/core/attestation.js';
import { RUN_ACTORS } from '../src/contracts/runActors.js';
import type { DeliveryKind } from '../src/contracts/taskExecution.js';
import type { LlmCompletionRequest, Plan, RunContext, Task } from '../src/core/types.js';
import { persistDeclaredArtifactManifest } from '../src/run/runner.js';
import { buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';
import { declaredArtifactManifestSchema } from '../src/contracts/artifactManifest.js';
import { makeCtx, jsonText } from './helpers.js';
import { makeTools } from './helpers/factories.js';

afterEach(() => { vi.unstubAllEnvs(); });

const ANSWER = 'THE_DELIVERED_TEXT_ANSWER: the median of 40, 42, 44 is 42; the median is the middle value of the sorted list.';
const checklist = [
  { id: 'c1', behaviour: 'The answer states the median value.', check: { kind: 'review' as const } },
  { id: 'c2', behaviour: 'The answer defines the median.', check: { kind: 'review' as const } },
];

/**
 * Code review 2026-10-09, 1.2: in SHORT depth the cell's prefilter shortcut
 * builds its plan in code, with no `delivery`. Undeclared used to mean files,
 * so a text answer reached the report-blind criteria review, which never sees
 * it, and a correct answer was refused. The model here is honest: a reviewer
 * judges a criterion met only when the delivered answer is in its prompt.
 */
async function shortRun(options: { writes: boolean; userList?: false; onPlan?: (plan: Plan) => void }) {
  for (const [key, value] of Object.entries({
    ATOMA_MODEL_L1: 'api:anthropic:claude-haiku-4-5', ATOMA_MODEL_L2: 'api:anthropic:claude-haiku-4-5',
    ATOMA_MODEL_L3: 'api:anthropic:claude-haiku-4-5', ATOMA_PREFILTER_CACHE: '0',
  })) vi.stubEnv(key, value);
  const registry = new AtomRegistry(openDb(':memory:'));
  const leaf = registry.create(1, { description: 'analysis molecule', systemPrompt: 'Answer questions.',
    tools: makeTools(['list_files', 'read_file', 'write_file']), params: {}, createdBy: 'test' });
  const cellType = registry.create(2, { description: 'analysis cell', systemPrompt: 'Route.', tools: [], params: {}, createdBy: 'test' });
  const ctx = { ...makeCtx(), requireObservedToolAction: true, attempt: 1, attestations: createAttestationLog(),
    tools: { has: () => true, execute: async (name: string) => name === 'list_files' ? 'data.txt' : name === 'write_file' ? 'ok' : '40\n42\n44' },
  } as unknown as RunContext;
  const calls: string[] = [];
  const recorded: Array<DeliveryKind | undefined> = [];
  const passes: Plan[] = [];
  const acceptances: boolean[] = [];
  const task: Task = { description: 'Compute and define the median of 40, 42, 44.' };
  const respond = async (req: LlmCompletionRequest) => {
    const sees = req.userContent.includes('THE_DELIVERED_TEXT_ANSWER');
    calls.push(`${req.role}/${req.actor?.name ?? '?'}`);
    let reply: unknown;
    if (req.role === 'prefilter') reply = { kind: 'reuse', target: leaf.name, confidence: 'high', reasoning: 'one molecule answers it' };
    // A remediation pass: the prefilter target is excluded, so the cell plans itself.
    else if (req.role === 'plan' && req.actor?.tier === 2) reply = [
      { strategy: 'reuse', target: leaf.name, reasoning: 'same molecule, address the refusal' },
      { reasoning: 'answer in text', delivery: 'text', subtasks: [{ description: task.description, preferredChild: leaf.name }],
        aggregation: { mode: 'concat' }, expectedOutput: 'the answer' },
    ];
    else if (req.role === 'plan') reply = { reasoning: 'read then answer', proposedAction: 'list files, answer', expectedOutput: 'the answer' };
    else if (req.role === 'execute') {
      const steps: Array<[string, Record<string, unknown>]> = [['list_files', { path: '.' }],
        ...(options.writes ? [['write_file', { path: 'answer.md', content: ANSWER }] as [string, Record<string, unknown>]] : [])];
      for (const [name, args] of steps) {
        const startedAt = Date.now();
        const value = await req.executor!.execute(name, args);
        req.onToolInvocation?.({ name, args, result: value, startedAt, durationMs: 1 });
      }
      reply = { output: ANSWER, summary: 'Answered the question in text.' };
    } else if (req.role === 'validate-result' && req.actor?.name === 'run-text-reference') {
      return { text: 'Reference: the median is 42, the middle value.', stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } };
    } else if (req.role === 'validate-result' || req.role === 'validate-plan') {
      const asked = /Review ONLY these criteria: (\[.*\])/.exec(req.userContent);
      const ids = asked ? (JSON.parse(asked[1]!) as Array<{ id: string }>).map((item) => item.id)
        : req.actor?.name === RUN_ACTORS.root.name ? ['c1', 'c2'] : [];
      reply = { approved: sees || req.role === 'validate-plan', reasoning: sees ? 'answer seen' : 'answer text not in evidence: unverified',
        scope: 'ephemeral', modifications: {},
        ...(ids.length ? { criteria: ids.map((id) => ({ id, met: sees, reason: sees ? 'stated in the answer' : 'unverified: no answer text supplied' })) } : {}) };
    } else throw new Error(`unexpected role ${req.role}`);
    return { text: jsonText(reply), stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  for (let i = 0; i < 80; i++) (ctx.llm as unknown as { enqueue(fn: typeof respond): void }).enqueue(respond);
  const result = await runDepthTask({ mode: 'short', task, ctx: { ...ctx, recordRootPlan: (plan) => { recorded.push(plan.delivery); options.onPlan?.(plan); } },
    floor: [], ...(options.userList === false ? { checklist: [] } : { checklist, checklistOrigin: { source: 'user' as const, digest: 'd' } }),
    restart: async () => { throw new Error('no deepening expected'); }, onTopology: () => {},
    onAcceptance: (acceptance) => { acceptances.push(acceptance.approved); },
    createExecutor: () => {
      const cell = L2Atom.fromType(cellType, registry, [], null);
      // The exact short handle of `runner.ts`.
      return { actor: cell, handle: async (t: Task, c: RunContext) => {
        const plan = await cell.plan(t, c);
        passes.push(plan);
        c.recordRootPlan?.(plan);
        return cell.execute(t, plan, c);
      } };
    } });
  return { result, calls, recorded, passes, acceptances };
}

describe('short depth: an undeclared delivery is never judged blind', () => {
  it('delivers a correct text answer on its first pass and records it as text', async () => {
    const { result, calls, recorded, passes, acceptances } = await shortRun({ writes: false });
    expect(passes).toHaveLength(1);
    expect(passes[0]!.delivery).toBeUndefined();
    expect(result.refusal).toBeUndefined();
    expect(String(result.output)).toContain('THE_DELIVERED_TEXT_ANSWER');
    expect(acceptances).toEqual([true]);
    // The text path ran (its blinded reference), the report-blind criteria review did not.
    expect(calls).toContain('validate-result/run-text-reference');
    expect(calls.some((call) => call.endsWith(`/${RUN_ACTORS.criteria.name}`))).toBe(false);
    // The declared manifest learns the delivery the pass was judged as.
    expect(recorded).toEqual([undefined, 'text']);
  });

  it('keeps the report-blind criteria review for a pass that wrote files', async () => {
    const { calls, recorded } = await shortRun({ writes: true });
    const firstAcceptance = calls.slice(0, calls.indexOf(`validate-result/${RUN_ACTORS.criteria.name}`) + 1);
    expect(firstAcceptance.at(-1)).toBe(`validate-result/${RUN_ACTORS.criteria.name}`);
    expect(firstAcceptance).not.toContain('validate-result/run-text-reference');
    expect(recorded.slice(0, 2)).toEqual([undefined, 'files']);
  });

  it('publishes an approved text answer from an empty workspace as a text delivery', async () => {
    // The runner's own hook persists the declared manifest; the coordinator
    // then inventories the finished workspace with the delivery it declares.
    const root = mkdtempSync(join(tmpdir(), 'atoma-short-text-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const manifestPath = join(root, 'declared.json');
    try {
      const { result } = await shortRun({ writes: false, userList: false,
        onPlan: (plan) => persistDeclaredArtifactManifest(manifestPath, 'run-1', plan) });
      expect(result.refusal).toBeUndefined();
      const declarations = declaredArtifactManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
      const built = buildWorkspaceArtifactManifest({ workspaceRoot: workspace,
        ...(declarations.delivery ? { delivery: declarations.delivery } : {}) });
      expect(built.manifest).toMatchObject({ delivery: 'text', files: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
