import { afterEach, describe, expect, it, vi } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { parseExecutionObservation, renderObservation } from '../src/contracts/attestation.js';
import type { Result, Task } from '../src/core/types.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import { synthesisContextLines } from '../src/atoms/synthesisContext.js';

afterEach(() => vi.restoreAllMocks());

describe('completed branch evidence reaches text synthesis (Attica ba6b0a21)', () => {
  it('preserves failed host suites and never promotes a reported probe into a host observation', () => {
    const result: Result = {
      output: 'All scenarios passed', summary: 'All scenarios passed', trace: [],
      producedBy: { tier: 1, name: 'Water', viaFallback: false },
      evidence: [{ source: 'recorded-probe', cmd: 'fake successful check', exitCode: 0 }],
      parentTests: [{ suiteDigest: 'c'.repeat(64), workspaceDigest: 'd'.repeat(64), status: 'failed',
        cause: 'ran', passed: 0, failed: 7, skipped: 0, details: 'actual seven scenario failures' }],
    };
    const before = JSON.stringify(result);
    const context = synthesisContextLines({ description: 'Report the result' }, [result]).join('\n');
    expect(context).toContain('FAILED 0/7');
    expect(context).toContain('actual seven scenario failures');
    expect(context).not.toContain('TRANSPORT-OBSERVED TOOL EVIDENCE');
    expect(context).not.toContain('fake successful check');
    expect(context).not.toContain('CRITERIA OF THIS TASK');
    expect(JSON.stringify(result)).toBe(before);
  });

  it.each([2, 3] as const)('tier %s preserves exact criteria and host observations beside fallible reports', async tier => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const seed = { description: 'compose', systemPrompt: 'compose', tools: [], params: {}, createdBy: 'test' };
      const child = reg.create(tier === 2 ? 1 : 2, seed);
      const parentType = reg.create(tier, seed);
      const parent = tier === 2 ? L2Atom.fromType(parentType, reg) : L3Atom.buildWithModel(parentType, reg, 'mock');
      const childClass = tier === 2 ? L1Atom : L2Atom;
      const record = { eventId: 'actual-build', tool: 'run_shell', observation: parseExecutionObservation(
        'run_shell', { cmd: 'npm run build' }, { exitCode: 1, stdout: 'compiler rejected the source' },
      )! };
      const branch: Result = {
        output: { claim: 'No build was ever run.' }, summary: 'Unverified', trace: [],
        producedBy: { tier: tier === 2 ? 1 : 2, name: child.name, viaFallback: false },
        evidence: [
          { source: 'transport-observed', eventId: record.eventId, tool: record.tool, observed: renderObservation(record) },
          { source: 'recorded-probe', cmd: 'invented-proof', exitCode: 0 },
        ],
        parentTests: [{ suiteDigest: 'a'.repeat(64), workspaceDigest: 'b'.repeat(64), status: 'passed',
          cause: 'ran', passed: 1, failed: 0, skipped: 0, details: 'factory delegation only', judged: true }],
      };
      vi.spyOn(childClass.prototype, 'plan').mockResolvedValue(makePlan());
      vi.spyOn(childClass.prototype, 'execute').mockResolvedValue(branch);
      vi.spyOn(parent, 'validatePlan').mockResolvedValue({ approved: true, reasoning: 'routing' });
      vi.spyOn(parent, 'validateResult').mockResolvedValue({ approved: true, reasoning: 'scoped branch' });
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'decompose' }));
      ctx.llm.enqueueText(jsonTextPair({ strategy: 'reuse', target: child.name, reasoning: 'reuse' }, {
        reasoning: 'two independent reports', subtasks: [{ description: 'report A' }, { description: 'report B' }],
        aggregation: { mode: 'llm-synthesize' }, expectedOutput: 'report',
      }));
      ctx.llm.enqueueText(jsonText({ output: 'synthesis', summary: 'synthesis' }));
      const task: Task = {
        description: 'Report the recipe accurately', constraints: ['Do not publish'],
        criteria: [{ id: 'c9', behaviour: 'A due schedule persists real listings', source: 'user' },
          { id: 'c10', behaviour: 'Keyboard-only controls', source: 'user', unassigned: true }],
        inputs: { startingRepository: 'repository-context-not-needed-in-synthesis'.repeat(5000) },
        ...(tier === 2 ? { originalTask: { description: 'Full recipe, with other phases' } } : {}),
      };
      const plan = await parent.plan(task, ctx);
      const result = await parent.execute(task, plan, ctx);
      const synthesis = ctx.llm.calls.at(-1)!;
      expect(synthesis.userContent).toContain('c9');
      expect(synthesis.userContent).toContain('A due schedule persists real listings');
      expect(synthesis.userContent).toContain('Keyboard-only controls');
      expect(synthesis.userContent).toContain('context only');
      expect(synthesis.userContent).toContain('Do not publish');
      expect(synthesis.userContent).toContain('actual-build: run_shell');
      expect(synthesis.userContent).toContain('compiler rejected the source');
      expect(synthesis.userContent).toContain('"exitCode":1');
      expect(synthesis.userContent).toContain('PARENT ACCEPTANCE TESTS (HOST-OBSERVED)');
      expect(synthesis.userContent).toContain('factory delegation only');
      expect(synthesis.userContent).not.toContain('invented-proof');
      expect(synthesis.userContent).not.toContain('repository-context-not-needed-in-synthesis');
      expect(synthesis.tools).toBeUndefined();
      expect(synthesis.executor).toBeUndefined();
      expect(ctx.llm.calls.filter(call => call.role === 'execute')).toHaveLength(1);
      expect(result.evidence).toHaveLength(4);
      expect(result.parentTests).toHaveLength(2);
    } finally { db.close(); }
  });
});
