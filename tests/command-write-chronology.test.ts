import { describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { llmVerdict, renderTransportEvidence } from '../src/atoms/verdict.js';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import { executorEvidence } from '../src/atoms/executorEvidence.js';
import { transportWitnesses } from '../src/contracts/witness.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';

describe('command evidence after subsequent source writes', () => {
  it('shows later writes beside an earlier passing command in the production review path', async () => {
    const ctx = makeCtx();
    const attestations = createAttestationLog();
    const child = new L1Atom({ name: 'Ammonia', ordinal: 3, systemPrompt: 'sys',
      tools: makeTools(['edit_file', 'record_probe']), params: {} });
    const executor = attestingExecutor({ has: () => true, execute: async (name, args) =>
      name === 'edit_file' ? { ok: true, path: args['path'], replacements: 1 } :
        { exitCode: 0, stdout: '1 test passed', recorded: true },
    }, attestations, 'repair', undefined, 1)!;
    ctx.llm.enqueue(async request => {
      await request.executor!.execute('record_probe', { cmd: 'npm run test:identity' });
      await request.executor!.execute('edit_file', { path: 'collector.ts', old_string: 'old', new_string: 'new' });
      await request.executor!.execute('edit_file', { path: 'tests/identity.test.ts', old_string: 'one test', new_string: 'five tests' });
      return { text: jsonText({ output: 'source and tests changed', summary: 'Final checks were not run after these edits.' }),
        stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const task = { description: 'Repair the collector and verify the final source.' };
    const result = await child.execute(task, makePlan(), { ...ctx, attestations, tools: executor,
      attempt: 1, currentBranchId: 'repair' });
    const selected = renderTransportEvidence(result.evidence, 1200);
    const receipt = selected.lines.find(line => line.includes('npm run test:identity'))!;
    expect(receipt).toContain('LATER FILE WRITES');
    expect(receipt).toContain('collector.ts');
    expect(receipt).toContain('tests/identity.test.ts');
    expect(receipt).toContain('observed exitCode=0');
    ctx.llm.enqueue({ text: jsonText({ approved: false, reasoning: 'Final-source execution is missing.' }),
      stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
    const verdict = await llmVerdict({ ctx, model: 'test', supervisorName: 'Parent', supervisorTier: 2,
      subject: 'RESULT', child, task, payload: result, evidence: result.evidence, groundTruthBlock: '' });
    expect(ctx.llm.calls.at(-1)!.userContent).toContain('LATER FILE WRITES');
    expect(verdict.approved).toBe(false);
    expect(attestations.forBranch('repair')).toHaveLength(3);
  });

  it('keeps a later successful command distinct from an earlier command followed by writes', async () => {
    const attestations = createAttestationLog();
    const executor = attestingExecutor({ has: () => true, execute: async (name, args) =>
      name === 'edit_file' ? { ok: true, path: args['path'] } : { exitCode: 0, stdout: 'passed' },
    }, attestations, 'repair', undefined, 1)!;
    await executor.execute('record_probe', { cmd: 'npm test' });
    await executor.execute('edit_file', { path: 'collector.ts' });
    await executor.execute('record_probe', { cmd: 'npm test' });
    const evidence = executorEvidence({}, { attestations, currentBranchId: 'repair', attempt: 1 });
    const commands = transportWitnesses(evidence).filter(witness => witness.tool === 'record_probe');
    expect(commands[0]!.writesAfter?.paths).toEqual(['collector.ts']);
    expect(commands[1]!.writesAfter).toBeUndefined();
    const lines = renderTransportEvidence(evidence).lines;
    expect(lines.find(line => line.startsWith(commands[0]!.eventId))).toContain('LATER FILE WRITES');
    expect(lines.find(line => line.startsWith(commands[1]!.eventId))).not.toContain('LATER FILE WRITES');
  });

  it('does not infer command dependencies or reject a command because an unrelated document changed', async () => {
    const attestations = createAttestationLog();
    const executor = attestingExecutor({ has: () => true, execute: async () => ({ ok: true, exitCode: 0 }) },
      attestations, 'repair', undefined, 1)!;
    await executor.execute('run_shell', { cmd: 'npm test' });
    await executor.execute('edit_file', { path: 'README.md' });
    const evidence = executorEvidence({}, { attestations, currentBranchId: 'repair', attempt: 1 });
    const command = transportWitnesses(evidence).find(witness => witness.tool === 'run_shell')!;
    expect(command.writesAfter?.paths).toEqual(['README.md']);
    expect(command.exitCode).toBe(0);
    expect(renderTransportEvidence(evidence).lines.join('\n')).toContain('relevance is not inferred');
  });

  it('does not mix branches or infer writes from later shell commands', async () => {
    const attestations = createAttestationLog();
    const inner = { has: () => true, execute: async () => ({ ok: true, exitCode: 0 }) };
    const own = attestingExecutor(inner, attestations, 'own', undefined, 1)!;
    const sibling = attestingExecutor(inner, attestations, 'sibling', undefined, 1)!;
    await own.execute('record_probe', { cmd: 'npm test' });
    await sibling.execute('edit_file', { path: 'collector.ts' });
    await own.execute('run_shell', { cmd: 'node mutate-or-inspect.cjs' });
    const evidence = executorEvidence({}, { attestations, currentBranchId: 'own', attempt: 1 });
    expect(transportWitnesses(evidence).every(witness => witness.writesAfter === undefined)).toBe(true);
    expect(renderTransportEvidence(evidence).lines.join('\n')).not.toContain('collector.ts');
  });

  it('excludes failed and no-op edit invocations from the write facts', async () => {
    const attestations = createAttestationLog();
    const executor = attestingExecutor({ has: () => true, execute: async (name, args) => {
      if (name === 'record_probe') return { exitCode: 0 };
      if (args['path'] === 'failed.ts') throw new Error('edit refused');
      return { ok: true, unchanged: true };
    } }, attestations, 'repair', undefined, 1)!;
    await executor.execute('record_probe', { cmd: 'npm test' });
    await expect(executor.execute('edit_file', { path: 'failed.ts' })).rejects.toThrow('edit refused');
    await executor.execute('edit_file', { path: 'unchanged.ts' });
    const evidence = executorEvidence({}, { attestations, currentBranchId: 'repair', attempt: 1 });
    expect(transportWitnesses(evidence)).toHaveLength(1);
    expect(transportWitnesses(evidence)[0]!.writesAfter).toBeUndefined();
  });

  it('bounds distinct paths and retains receipts and their outcomes under presentation pressure', async () => {
    const attestations = createAttestationLog();
    const executor = attestingExecutor({ has: () => true, execute: async () => ({ ok: true, exitCode: 0, stdout: 'x'.repeat(20_000) }) },
      attestations, 'repair', undefined, 1)!;
    await executor.execute('record_probe', { cmd: 'npm test' });
    for (let i = 0; i < 10; i++) await executor.execute('edit_file', { path: `tests/case-${i}.ts` });
    await executor.execute('edit_file', { path: './tests/../tests/case-9.ts' });
    const evidence = executorEvidence({}, { attestations, currentBranchId: 'repair', attempt: 1 });
    const command = transportWitnesses(evidence).find(witness => witness.tool === 'record_probe')!;
    expect(command.writesAfter?.paths).toHaveLength(6);
    expect(command.writesAfter?.omittedPaths).toBe(4);
    const shown = renderTransportEvidence(evidence, 1200);
    expect(shown.lines.reduce((total, line) => total + line.length, 0)).toBeLessThanOrEqual(1200);
    const receipt = shown.lines.find(line => line.startsWith(command.eventId))!;
    expect(receipt).toContain('observed exitCode=0');
    expect(receipt).toContain('LATER FILE WRITES');
    expect(attestations.forBranch('repair')).toHaveLength(12);
  });
});
