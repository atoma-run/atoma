import type { Result, Task } from '../core/types.js';
import { renderParentTestsBlock } from './parentTestsBlock.js';
import { renderTransportEvidenceBlock } from './verdict.js';

/**
 * Synthesis used to read only model-authored reports. It could neither retain
 * the task's criterion identities nor distinguish omitted proof from no work.
 * Share the reviewers' bounded host renderers; do not replay or credit a check.
 */
export function synthesisContextLines(task: Task, results: readonly Result[]): string[] {
  const evidence = results.flatMap(result => result.evidence ?? []);
  const parentTests = results.flatMap(result => result.parentTests ?? []);
  return [
    ...(task.constraints?.length ? [`Task constraints: ${JSON.stringify(task.constraints)}`] : []),
    ...(task.criteria?.length ? [
      '== CRITERIA OF THIS TASK ==',
      'Keep these ids and words; never reconstruct or renumber a checklist from branch reports. Context-only and drafted items add no requirement to this phase.',
      ...task.criteria.map(item => `- ${item.id} [${item.source}${item.unassigned ? '; context only' : ''}]: ${JSON.stringify(item.behaviour)}`),
    ] : []),
    renderTransportEvidenceBlock(evidence),
    renderParentTestsBlock(parentTests, { tier: 'phase' }),
    'Branch summaries and outputs are fallible reports, not additional host observations. Preserve recorded failures and missing or invalidated proof; distinguish a check not shown here from a check never run. This synthesis grants no acceptance or new proof credit.',
    '== END SYNTHESIS CONTEXT ==',
  ].filter(Boolean);
}
