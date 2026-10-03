import { describe, expect, it } from 'vitest';
import { decodePreviousResults, encodePreviousResults, PREVIOUS_RESULTS_ENV, PREVIOUS_RESULTS_MAX_CHARS } from '../src/contracts/previousRunResults.js';
import { withPreviousRunInputs } from '../src/run/taskInputs.js';

describe('bounded historical text context', () => {
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
});
