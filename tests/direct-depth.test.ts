import { describe, expect, it, vi } from 'vitest';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import type { Plan, ToolExecutor } from '../src/core/types.js';
import { DirectAtom, DIRECT_ATOM_NAME, DIRECT_RETRY_INPUT, directRootHandle, renderDirectUserContent } from '../src/run/direct.js';
import { runDepthTask } from '../src/run/depth.js';
import { parseRunnerArgs, resolveSupervisionDepth, RunnerConfigError } from '../src/run/runner.js';
import { DEPTH_CONTRACT } from '../src/run/setup.js';
import { DEFAULT_DEPTH_MODE, STORED_DEPTH_WHEN_ABSENT } from '../src/contracts/depthRouting.js';
import { APPLICATION_TYPESCRIPT_GUIDANCE, TASK_CONTEXT_HEADER } from '../src/atoms/taskContext.js';
import { buildRunArgs, buildRunEnvOverrides } from '../src/mcp/run.js';
import { ASSAY_DEPTH } from '../src/supervisor/assayer.js';
import { makeCtx, jsonText } from './helpers.js';
import { makeTools } from './helpers/factories.js';

/**
 * DIRECT DEPTH (docs/decisions/direct-depth-2026-11-01.md): one executor
 * carries the whole task and the host judges it like any other topology. The
 * runner-level proof is in `depth-runner.test.ts`; these pin the pieces.
 */
const tools = makeTools(['write_file', 'read_file', 'run_shell']);

function fileTools(): ToolExecutor {
  return {
    has: (name) => ['write_file', 'read_file', 'run_shell'].includes(name),
    execute: async (name) => name === 'read_file' ? { content: 'export const x = 1;' } : name === 'run_shell' ? { exitCode: 0, stdout: 'ok' } : { ok: true },
  };
}

describe('the direct executor', () => {
  it('is a molecule on the L3 pin with the run tools, and reads the task context every executor reads', () => {
    const atom = new DirectAtom(tools, 'api:test:frontier');
    expect(atom).toMatchObject({ name: DIRECT_ATOM_NAME, tier: 1, model: 'api:test:frontier' });
    expect(atom.toolNames()).toEqual(['write_file', 'read_file', 'run_shell']);
    const text = renderDirectUserContent({ description: 'Fix the parser', inputs: { rootAcceptanceRefusal: 'Empty input still crashes.' } }, true);
    expect(text.startsWith('TASK:\nFix the parser')).toBe(true);
    expect(text).toContain(TASK_CONTEXT_HEADER);
    // The run's own policy, as a molecule reads it, and the refusal a remediation pass answers.
    expect(text).toContain(APPLICATION_TYPESCRIPT_GUIDANCE.split('\n')[0]);
    expect(text).toContain('Empty input still crashes.');
  });

  it('records a one-phase root plan with NO declared delivery before its first tool call', async () => {
    const atom = new DirectAtom(tools, 'api:test:frontier');
    const recorded: Plan[] = [];
    const attestations = createAttestationLog();
    // The attested executor `runDepthTask` hands every pass.
    const ctx = { ...makeCtx(), tools: attestingExecutor(fileTools(), attestations, undefined)!, attempt: 1, attestations,
      recordRootPlan: (plan: Plan) => recorded.push(plan) };
    ctx.llm.enqueue(async (req) => {
      expect(recorded).toHaveLength(1);
      await req.executor!.execute('write_file', { path: 'a.ts', content: 'export const x = 1;' });
      return { text: 'Wrote a.ts.\nRan nothing else.', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const out = await directRootHandle(atom)({ description: 'Write a.ts' }, ctx);
    expect(recorded[0]!.subtasks).toEqual([{ description: 'Write a.ts' }]);
    expect(recorded[0]!.delivery).toBeUndefined();
    expect(out).toMatchObject({ output: 'Wrote a.ts.\nRan nothing else.', summary: 'Wrote a.ts.',
      producedBy: { tier: 1, name: DIRECT_ATOM_NAME, viaFallback: false } });
    // The host's own record of the call travels as evidence, not the report's claim.
    expect(out.evidence?.some((witness) => witness.source === 'transport-observed' && witness.tool === 'write_file')).toBe(true);
  });

  it('lands a pass the run budget cut, with its one phase unfinished, instead of failing', async () => {
    const atom = new DirectAtom(tools, 'api:test:frontier');
    const ctx = { ...makeCtx(), tools: fileTools(), attempt: 1, attestations: createAttestationLog() };
    const controller = new AbortController();
    ctx.llm.enqueue(async (req) => {
      await req.executor!.execute('write_file', { path: 'a.ts', content: 'partial' });
      controller.abort(new DOMException('Execution deadline', 'TimeoutError'));
      req.signal!.throwIfAborted();
      throw new Error('unreachable');
    });
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Nothing was verified.' }));
    const out = await runDepthTask({ mode: 'direct', task: { description: 'Write a.ts' }, floor: [],
      ctx: { ...ctx, signal: controller.signal, deadlineAt: Date.now() + 90_000 }, restart: vi.fn(), onTopology: vi.fn(),
      onAcceptance: vi.fn(), createExecutor: () => ({ actor: atom, handle: directRootHandle(atom) }) });
    expect(out.unfinishedPhases).toEqual(['Write a.ts']);
    expect(out.refusal).toContain('Nothing was verified.');
  });

  it('runs a failed execution once more on the same workspace, telling it what remains', async () => {
    const atom = new DirectAtom(tools, 'api:test:frontier');
    const ctx = { ...makeCtx(), tools: fileTools(), attempt: 1, attestations: createAttestationLog() };
    ctx.llm.enqueue(async (req) => {
      await req.executor!.execute('write_file', { path: 'a.ts', content: 'half' });
      throw new Error('transport lost');
    });
    ctx.llm.enqueue(async (req) => {
      expect(req.userContent).toContain(DIRECT_RETRY_INPUT);
      expect(req.userContent).toContain('transport lost');
      await req.executor!.execute('write_file', { path: 'a.ts', content: 'whole' });
      return { text: 'Completed a.ts.', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Done.' }));
    const out = await runDepthTask({ mode: 'direct', task: { description: 'Write a.ts' }, floor: [], ctx, restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(), createExecutor: () => ({ actor: atom, handle: directRootHandle(atom) }) });
    expect(out.summary).toBe('Completed a.ts.');
    expect(out.refusal).toBeUndefined();
  });

  it('never deepens: a second failure fails the attempt, and nothing restarts it through L3', async () => {
    const atom = new DirectAtom(tools, 'api:test:frontier');
    const ctx = { ...makeCtx(), tools: fileTools(), attempt: 1, attestations: createAttestationLog() };
    ctx.llm.enqueue(async () => { throw new Error('transport lost'); });
    ctx.llm.enqueue(async () => { throw new Error('transport lost again'); });
    const restart = vi.fn();
    const topology = vi.fn();
    await expect(runDepthTask({ mode: 'direct', task: { description: 'Write a.ts' }, floor: [], ctx, restart,
      onTopology: topology, onAcceptance: vi.fn(), createExecutor: () => ({ actor: atom, handle: directRootHandle(atom) }) }))
      .rejects.toThrow('transport lost again');
    expect(restart).not.toHaveBeenCalled();
    expect(topology).toHaveBeenCalledExactlyOnceWith({ at: 'entry', mode: 'direct', reason: 'arm', attempt: 1 });
  });
});

describe('which depth a run takes', () => {
  it('defaults to direct, and keeps every explicit depth and both measurement arms', () => {
    expect(DEFAULT_DEPTH_MODE).toBe('direct');
    expect(DEPTH_CONTRACT.defaultMode).toBe(DEFAULT_DEPTH_MODE);
    expect(resolveSupervisionDepth(parseRunnerArgs(['g']), DEPTH_CONTRACT.defaultMode)).toBe('direct');
    for (const mode of ['direct', 'short', 'deep'] as const) {
      expect(resolveSupervisionDepth(parseRunnerArgs(['--depth', mode, 'g']), DEPTH_CONTRACT.defaultMode)).toBe(mode);
    }
    expect(resolveSupervisionDepth(parseRunnerArgs(['--baseline', 'g']), DEPTH_CONTRACT.defaultMode)).toBeUndefined();
    expect(resolveSupervisionDepth(parseRunnerArgs(['--comparison', 'g']), DEPTH_CONTRACT.defaultMode)).toBeUndefined();
    expect(() => parseRunnerArgs(['--depth', 'direct', '--baseline', 'g'])).toThrow(RunnerConfigError);
    expect(() => parseRunnerArgs(['--depth', 'shallow', 'g'])).toThrow(RunnerConfigError);
  });

  it('reads a stored run without a depth as the deep run it was launched as', () => {
    // Every such row predates the change; the current default must never re-topologise it.
    expect(STORED_DEPTH_WHEN_ABSENT).toBe('deep');
    expect(STORED_DEPTH_WHEN_ABSENT).not.toBe(DEFAULT_DEPTH_MODE);
  });

  it('keeps a recipe assay on the topology that can use a recipe', () => {
    expect(ASSAY_DEPTH).toBe('deep');
  });

  it('lets an operator MCP run name its depth and opt into learning', () => {
    expect(buildRunArgs({ goal: 'x', depth: 'deep' })).toEqual(['--depth', 'deep']);
    expect(buildRunArgs({ goal: 'x' })).toEqual([]);
    expect(buildRunEnvOverrides({ goal: 'x', learnSkills: true }, {})).toEqual({ ATOMA_SKILL_LEARN: '1' });
    expect(buildRunEnvOverrides({ goal: 'x', learnSkills: false }, {})).toEqual({});
    expect(buildRunArgs({ goal: 'x', learnSkills: false })).toEqual(['--no-learn-skills']);
  });
});

describe('a stored run answering a retried request', () => {
  it('matches an absent depth to the default or an older row without one, and a named depth to what the row ran at', async () => {
    const { requestedDepthMatches } = await import('../src/projects/store.js');
    expect(requestedDepthMatches('direct', undefined)).toBe(true);
    expect(requestedDepthMatches(null, undefined)).toBe(true);
    expect(requestedDepthMatches('deep', undefined)).toBe(false);
    expect(requestedDepthMatches(null, 'deep')).toBe(true);
    expect(requestedDepthMatches(null, 'direct')).toBe(false);
    expect(requestedDepthMatches('short', 'short')).toBe(true);
  });
});
