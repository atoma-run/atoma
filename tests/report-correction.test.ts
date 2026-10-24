import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { Atom, type Supervisor } from '../src/core/atom.js';
import type { Result, Verdict } from '../src/core/types.js';
import { superviseLoop } from '../src/core/supervisor.js';
import { parseVerdict } from '../src/atoms/json.js';
import { recordProbeTool } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';

class Reviewer extends Atom implements Supervisor<L1Atom> {
  readonly tier = 2 as const;
  readonly model = 'unused';
  readonly seen: Result[] = [];
  constructor(readonly verdicts: Verdict[]) {
    super({ name: 'reviewer', ordinal: 1, systemPrompt: '', tools: [], params: {} });
  }
  async plan(): Promise<never> { throw new Error('No fallback plan permitted'); }
  async execute(): Promise<never> { throw new Error('No fallback execution permitted'); }
  async validatePlan() { return { approved: true as const, reasoning: 'Valid plan' }; }
  async validateResult(_child: L1Atom, result: Result) {
    this.seen.push(result);
    return this.verdicts.shift()!;
  }
}
const correction: Verdict = {
  approved: false, reportCorrection: true, scope: 'ephemeral',
  reasoning: 'Only the reported build exit is wrong; observed build succeeded.',
  modifications: { additionalContext: 'Report build exit 0; retain mutant 1 and restoration 0.' },
};

it.each(['approved', 'nested-marker', 'large-context', 'refused', 'malformed-reformatted', 'cut-completed', 'malformed', 'cut', 'transport-error'] as const)('repairs the report without repeating a real mutant/restoration: %s', async mode => {
  const refusedAgain = mode === 'refused';
  // A cut or unreadable correction gets ONE tool-free second chance; only a
  // second slip, or a transport failure, leaves the correction unavailable.
  const secondChance = mode === 'malformed-reformatted' || mode === 'cut-completed';
  const unavailable = mode === 'malformed' || mode === 'cut' || mode === 'transport-error';
  const root = mkdtempSync(join(tmpdir(), 'report-correction-'));
  const sandbox = new ToolSandbox(root);
  try {
    const tool = recordProbeTool({ sandbox });
    writeFileSync(join(root, 'check.cjs'), "require('node:assert/strict').equal(require('./built.cjs').value, 1, 'temporal boundary');");
    const executeTool = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      JSON.parse(JSON.stringify(await tool.execute(args))) as unknown);
    const recordRunStat = vi.fn();
    const ctx = { ...makeCtx(), tools: { has: () => true, execute: executeTool }, recordRunStat };
    const execution = async (request: { executor?: { execute(name: string, args: Record<string, unknown>): Promise<unknown> } }) => {
      writeFileSync(join(root, 'built.cjs'), 'exports.value = 2;');
      expect(await request.executor!.execute('record_probe', { cmd: 'node check.cjs' })).toMatchObject({ exitCode: 1 });
      writeFileSync(join(root, 'built.cjs'), 'exports.value = 1;');
      expect(await request.executor!.execute('record_probe', { cmd: 'node check.cjs' })).toMatchObject({ exitCode: 0 });
      return { text: jsonText({ output: { build: 1, mutant: 1, restored: 0 }, summary: 'Observed mutant failure then restored success.' }), stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    ctx.llm.enqueue(execution);
    const correctedText = jsonText({ output: { build: 0, mutant: 1, restored: 0 }, summary: 'Build succeeded; mutant failed; restoration passed.', evidence: [], toolCallResults: [] });
    const toolFree = (request: { executor?: unknown; tools?: unknown }) => {
      expect(request.executor).toBeUndefined();
      expect(request.tools).toBeUndefined();
    };
    ctx.llm.enqueue(async request => {
      toolFree(request);
      expect(request.userContent.length).toBeLessThan(48_000);
      expect(request.userContent).toContain('Exactly one mutant/restoration cycle.');
      expect(request.params?.maxTokens).toBe(8000);
      if (mode === 'transport-error') throw new Error('provider unavailable');
      const malformed = mode === 'malformed' || mode === 'malformed-reformatted';
      const cut = mode === 'cut' || mode === 'cut-completed';
      return { text: malformed ? 'not a result envelope' : correctedText, stopReason: cut ? 'max_tokens' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    if (mode === 'malformed' || mode === 'malformed-reformatted') ctx.llm.enqueue(async request => {
      // The unreadable reply is reformatted, never re-asked from scratch.
      toolFree(request);
      expect(request.userContent).toContain('Reformat this result without repeating any work');
      expect(request.userContent).toContain(JSON.stringify('not a result envelope'));
      return { text: mode === 'malformed' ? 'still not an envelope' : correctedText, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    if (mode === 'cut' || mode === 'cut-completed') ctx.llm.enqueue(async request => {
      // The cut reply is asked again once, under a larger cap, with the same report.
      toolFree(request);
      expect(request.params?.maxTokens).toBe(16_000);
      expect(request.userContent).toContain('cut before its end');
      expect(request.userContent).toContain('Exactly one mutant/restoration cycle.');
      return { text: correctedText, stopReason: mode === 'cut' ? 'max_tokens' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    // An unavailable correction is not a judged defect: the refusal takes the
    // ordinary ladder and the ephemeral retry re-executes, as before the path.
    if (unavailable) ctx.llm.enqueue(execution);
    const child = new L1Atom({ name: 'Water', ordinal: 1, systemPrompt: '', tools: [tool.declaration], params: {} });
    const plan = vi.spyOn(child, 'plan').mockResolvedValue(makePlan());
    const parsedVerdict = mode === 'nested-marker' ? parseVerdict(JSON.stringify({
      ...correction, reportCorrection: undefined,
      modifications: { ...correction.modifications, reportCorrection: true },
    })) : correction;
    if (parsedVerdict.approved) throw new Error('The correction must remain a refusal');
    const firstVerdict: Verdict = { ...correction, reportCorrection: parsedVerdict.reportCorrection };
    const parent = new Reviewer([firstVerdict, refusedAgain ? correction : { approved: true, reasoning: 'Report now matches observed evidence.' }]);
    const aroundExecute = vi.fn(async (run: () => Promise<Result>) => {
      const result = await run();
      return { ...result, summary: '[HOST ANNOTATION] ' + result.summary };
    });
    const onApproved = vi.fn();
    const applyByScope = vi.fn(async (current: L1Atom) => {
      if (!unavailable) throw new Error('No replan for report correction');
      return current;
    });
    const run = superviseLoop(parent, child, { description: 'Exactly one mutant/restoration cycle.',
      ...(mode === 'large-context' ? { inputs: { repositoryDiscovery: 'historical observation '.repeat(4000) } } : {}),
    }, ctx, {
      aroundExecute, onApproved, applyByScope,
      branchOnEscalation: async () => { throw new Error('No branch for report correction'); },
    });
    if (refusedAgain) await expect(run).rejects.toThrow('Report-only correction remained refused');
    else if (unavailable) {
      const outcome = await run;
      expect(outcome.output).toEqual({ build: 1, mutant: 1, restored: 0 });
      // One refusal, one retry, one approval: nothing counted or traced twice.
      expect(outcome.trace.filter(entry => entry.kind === 'verdict-result')).toHaveLength(2);
      expect(outcome.trace.filter(entry => entry.kind === 'execute')).toHaveLength(2);
      expect(recordRunStat.mock.calls.filter(([stat]) => stat === 'result-refusal')).toHaveLength(1);
    } else expect((await run).output).toEqual({ build: 0, mutant: 1, restored: 0 });
    // Every reply the mock holds was consumed: the second chance happened
    // exactly where it was expected, and nothing was asked a third time.
    expect(ctx.llm.calls).toHaveLength(1 + (mode === 'transport-error' ? 1 : secondChance || unavailable ? 2 : 1) + (unavailable ? 1 : 0));
    expect(plan).toHaveBeenCalledTimes(unavailable ? 2 : 1);
    expect(aroundExecute).toHaveBeenCalledTimes(unavailable ? 2 : 1);
    expect(executeTool).toHaveBeenCalledTimes(unavailable ? 4 : 2);
    expect(applyByScope).toHaveBeenCalledTimes(unavailable ? 1 : 0);
    expect(parent.seen).toHaveLength(2);
    if (!unavailable) {
      expect(parent.seen[1]!.toolCallResults).toBe(parent.seen[0]!.toolCallResults);
      expect(parent.seen[1]!.evidence).toBe(parent.seen[0]!.evidence);
      expect(parent.seen[1]!.summary).toMatch(/^\[HOST ANNOTATION\]/);
    } else {
      expect(parent.seen[1]).not.toHaveProperty('reportCorrected');
      expect(parent.seen[1]!.toolCallResults).not.toBe(parent.seen[0]!.toolCallResults);
    }
    expect(onApproved).toHaveBeenCalledTimes(refusedAgain ? 0 : 1);
  } finally {
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

it('requires explicit structured report correction; arbitrary report prose does not enable it', () => {
  expect(parseVerdict(JSON.stringify(correction))).toMatchObject({ reportCorrection: true });
  expect(parseVerdict(JSON.stringify({ ...correction, reportCorrection: undefined }))).not.toHaveProperty('reportCorrection');
  expect(() => parseVerdict(JSON.stringify({ ...correction, reportCorrection: 'true' }))).toThrow();
});

it('only relocates an exact nested marker on an explicitly ephemeral refusal', () => {
  const nested = { ...correction, reportCorrection: undefined, modifications: { additionalContext: 'Correct the report.', reportCorrection: true } };
  expect(parseVerdict(JSON.stringify(nested))).toMatchObject({ approved: false, reportCorrection: true });
  for (const value of ['true', false, 1, null]) {
    expect(parseVerdict(JSON.stringify({ ...nested, modifications: { ...nested.modifications, reportCorrection: value } }))).not.toHaveProperty('reportCorrection');
  }
  for (const scope of ['patch', 'branch', undefined]) {
    expect(parseVerdict(JSON.stringify({ ...nested, scope }))).not.toHaveProperty('reportCorrection');
  }
  expect(parseVerdict(JSON.stringify({ ...nested, approved: true }))).not.toHaveProperty('reportCorrection');
  expect(() => parseVerdict(JSON.stringify({ ...nested, reportCorrection: false }))).toThrow();
});
