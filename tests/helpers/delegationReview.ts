import type { LlmCompletionRequest, Plan } from '../../src/core/types.js';

/** Provider fixture for tests about non-Vitest proof paths (text files/browser probes).
 * Contract enforcement itself is covered with explicit classifications elsewhere.
 */
export function mockOtherProofReview(req: Pick<LlmCompletionRequest, 'userContent'>) {
  if (!req.userContent.includes('== REQUIRED DELEGATION CONTRACT REVIEW ==')) return {};
  const encoded = /^PLAN: (.*)$/m.exec(req.userContent)?.[1];
  if (!encoded) throw new Error('Fixture did not receive the delegation plan');
  const plan = JSON.parse(encoded) as Plan;
  return { delegationReview: {
    subtasks: plan.subtasks.map((_, index) => ({ index, kind: 'other', reason: 'Fixture uses file or browser proof' })),
    integration: { kind: 'other', reason: 'Fixture has dedicated final acceptance' },
    independentWork: false, parallelReason: 'Fixture preserves its explicitly tested dispatch shape',
  } };
}
