import { describe, expect, it } from 'vitest';
import { decodePreviousResults, encodePreviousResults, PREVIOUS_RESULTS_ENV, PREVIOUS_RESULTS_MAX_CHARS } from '../src/contracts/previousRunResults.js';
import { withPreviousRunInputs } from '../src/run/taskInputs.js';
import { delegatedTaskContext } from '../src/atoms/taskContext.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import type { Task } from '../src/core/types.js';
import { jsonText, makeCtx } from './helpers.js';
import { makeTools } from './helpers/factories.js';
import { REPOSITORY_PREPARATION_ENV, decodeRepositoryPreparation } from '../src/contracts/repositorySync.js';
import { taskContextLines } from '../src/atoms/taskContext.js';

describe('bounded historical text context', () => {
  it.each(['synced', 'unavailable', 'no_anchor'] as const)('preserves the actual host outcome across two delegations: %s', status => {
    const receipt = { mode: 'synchronize', status, head: 'a'.repeat(40), baseSha: null, taken: 2,
      conflicts: status === 'synced' ? 1 : 0, paths: ['source.ts'] };
    const root = withPreviousRunInputs({ description: 'Repair the existing app', inputs: { repositoryPreparation: 'stale' } },
      { [REPOSITORY_PREPARATION_ENV]: JSON.stringify(receipt) });
    const phase = { description: 'Repair', ...delegatedTaskContext(root, { description: 'Repair', inputs: { repositoryPreparation: 'forged' } }) };
    const leaf = { description: 'Check', ...delegatedTaskContext(phase, { description: 'Check' }) };
    expect(leaf.inputs?.['repositoryPreparation']).toEqual(receipt);
    expect(taskContextLines(leaf).join('\n')).toContain('conflicts do not establish successful synchronization');
    expect(withPreviousRunInputs(root, {}).inputs).not.toHaveProperty('repositoryPreparation');
    expect(() => decodeRepositoryPreparation(JSON.stringify({ ...receipt, status: 'approved' }))).toThrow();
  });
  it('keeps structured-result text, status and explicit omissions without changing the goal', () => {
    const history = { historyTruncated: true, runs: [{ runId: '00000000-0000-4000-8000-000000000001',
      status: 'delivered' as const, goal: 'Earlier request', output: '{"answer":4}', truncated: true, unavailable: false }] };
    const task = withPreviousRunInputs({ description: 'Current task', inputs: { other: 'kept' } },
      { [PREVIOUS_RESULTS_ENV]: encodePreviousResults(history) });
    expect(task.description).toBe('Current task');
    expect(task.inputs).toEqual({ other: 'kept', previousRunResults: history });
  });
  it('bounds escaped Unicode/control data and marks dropped history and shortened output', () => {
    const runs = [1, 2, 3].map(i => ({ runId: `00000000-0000-4000-8000-00000000000${i}`,
      status: 'partial' as const, goal: '\u0001'.repeat(4000), output: '\u0000'.repeat(8000), truncated: false, unavailable: false }));
    const encoded = encodePreviousResults({ runs, historyTruncated: false });
    expect(encoded.length).toBeLessThanOrEqual(PREVIOUS_RESULTS_MAX_CHARS);
    expect(decodePreviousResults(encoded)).toMatchObject({ historyTruncated: true, runs: [{ runId: runs[2]!.runId, truncated: true }] });
  });
  it('does not silently accept malformed host context or add history where none was supplied', () => {
    expect(() => decodePreviousResults('{')).toThrow();
    expect(() => decodePreviousResults('x'.repeat(PREVIOUS_RESULTS_MAX_CHARS + 1))).toThrow();
    expect(decodePreviousResults(undefined)).toBeUndefined();
    expect(withPreviousRunInputs({ description: 'First task' }, {}).inputs?.['previousRunResults']).toBeUndefined();
  });
  // Code review 2026-10-09 2.7: delegation carried the history at top level
  // AND inside originalTask.inputs, so every L2 and L1 prompt paid it twice.
  it('renders the run history once in a delegated prompt, and a plan cannot replace it', async () => {
    const marker = 'HISTORY_MARKER_7f3a';
    const previousRunResults = { historyTruncated: false, runs: [{ runId: '11111111-1111-4111-8111-111111111111', status: 'delivered' as const,
      goal: `${marker} earlier goal`, output: 'o'.repeat(2000), truncated: false, unavailable: false }] };
    const root: Task = { description: 'Build the thing', inputs: { previousRunResults } };
    const phase: Task = { description: 'phase 1', ...delegatedTaskContext(root, { description: 'phase 1', inputs: { previousRunResults: 'FORGED' } }) };
    const leaf: Task = { description: 'write index.html', ...delegatedTaskContext(phase, { description: 'write index.html' }) };
    expect(leaf.inputs?.['previousRunResults']).toEqual(previousRunResults);
    const type = new AtomRegistry(openDb(':memory:')).create(1, { description: 'web', systemPrompt: 'Build.', tools: makeTools(['write_file']), params: {}, createdBy: 'test' });
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    await L1Atom.fromType(type).plan(leaf, ctx);
    const sent = ctx.llm.calls.at(-1)!.userContent;
    expect(sent.split(marker).length - 1).toBe(1);
    expect(sent).not.toContain('FORGED');
  });
});
