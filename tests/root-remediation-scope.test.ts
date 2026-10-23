import { describe, expect, it } from 'vitest';
import type { AcceptanceInfo } from '../src/contracts/depthRouting.js';
import type { Task } from '../src/core/types.js';
import { remediationTask } from '../src/run/depth.js';

const task: Task = { description: 'Build the interactive page and document how to run it' };

function refusal(criteria: Array<{ id: string; behaviour: string; met: boolean; reason?: string }>): AcceptanceInfo {
  return {
    attempt: 1,
    approved: false,
    reasoning: 'Delivery rejected',
    acceptor: { name: 'run-root', tier: 3, role: 'root-acceptor' },
    executor: { name: 'worker', tier: 2, viaFallback: false },
    gates: [],
    probe: { requiresReview: true, contradiction: false },
    floorCoverage: [],
    phaseCoverage: [],
    checklist: criteria.map(({ id, behaviour, met, reason }) => ({
      id,
      behaviour,
      kind: 'review' as const,
      status: 'review' as const,
      observationRefs: [],
      judgement: { met, ...(reason ? { reason } : {}) },
    })),
    checklistSource: 'drafted',
    basis: 'validation-call',
  };
}

describe('root remediation scope', () => {
  it('keeps a compound criterion and the host receipts when only its temporal proof is missing', () => {
    const repositoryPreparation = { mode: 'synchronize', status: 'synced', conflicts: 0 };
    const original: Task = { description: 'Keep fresh rows, errors and stale-response protection',
      inputs: { repositoryPreparation, previousPhaseObservations: 'Focused check ran; temporal coverage disputed' },
      criteria: [{ id: 'c1', behaviour: 'Refresh rows and preserve errors without transient stale overwrite', source: 'user' }] };
    const next = remediationTask(original, refusal([{ id: 'c1', behaviour: original.criteria![0]!.behaviour,
      met: false, reason: 'Assert after old response consumption before releasing fresh response' }]));
    expect(next.criteria).toEqual(original.criteria);
    expect(next.inputs?.['repositoryPreparation']).toEqual(repositoryPreparation);
    expect(next.inputs?.['rootRemediationScope']).toMatchObject({ metCriteria: [], criterion: { id: 'c1' } });
    expect(JSON.stringify(next.inputs?.['rootRemediationScope'])).toContain('without refactoring working source');
  });
  it('focuses a single rejected criterion while preserving the original task identity', () => {
    const remediated = remediationTask(task, refusal([
      { id: 'c1', behaviour: 'The page remains interactive', met: true },
      { id: 'c2', behaviour: 'README uses a durable loopback URL', met: false, reason: 'It contains the observed numeric port' },
    ]));

    expect(remediated.description).toBe(task.description);
    expect(remediated.inputs?.['rootRemediationScope']).toMatchObject({
      mode: 'single-criterion',
      criterion: {
        id: 'c2',
        behaviour: 'README uses a durable loopback URL',
        reason: 'It contains the observed numeric port',
      },
      metCriteria: ['c1'],
    });
    // The fact rides beside the full refusal and never narrows it.
    expect(JSON.stringify(remediated.inputs?.['rootRemediationScope'])).toContain('answer the whole refusal in rootAcceptanceRefusal');
  });

  // A refusal can hold more than its one unmet criterion. Scoped to that
  // criterion, the pass would leave the rest standing and the second
  // acceptance would refuse again, landing a partial (review of PR #6).
  it.each([
    ['a gate finding', (info: AcceptanceInfo): AcceptanceInfo => ({ ...info, gates: [{ id: 'unverified-claim', disposition: 'requires-review' }] })],
    ['a probe contradiction', (info: AcceptanceInfo): AcceptanceInfo => ({ ...info, probe: { requiresReview: true, contradiction: true } })],
    ['an unproven floor item', (info: AcceptanceInfo): AcceptanceInfo => ({ ...info, floorCoverage: [{ kind: 'dom-interaction', deliverable: 'index.html', status: 'uncovered', observationRefs: [] }] })],
    ['another criterion no observation covered', (info: AcceptanceInfo): AcceptanceInfo => ({ ...info, checklist: [...info.checklist!, { id: 'c3', behaviour: 'GET /health 200', kind: 'http', status: 'uncovered', observationRefs: [] }] })],
    ['another criterion without a resolved judgement', (info: AcceptanceInfo): AcceptanceInfo => ({ ...info, checklist: [...info.checklist!, { id: 'c3', behaviour: 'Preserved coverage', kind: 'review', status: 'review', observationRefs: [] }] })],
    ['another criterion whose width was never laid out', (info: AcceptanceInfo): AcceptanceInfo => ({ ...info, checklist: [...info.checklist!, { id: 'c4', behaviour: 'No scroll at 375 px', kind: 'review', status: 'review', observationRefs: [], layouts: [{ width: 375, status: 'not-laid-out', observationRefs: [] }] }] })],
  ])('keeps the broad pass when the refusal also holds %s', (_label, widen) => {
    const remediated = remediationTask(task, widen(refusal([
      { id: 'c1', behaviour: 'The page remains interactive', met: true },
      { id: 'c2', behaviour: 'README uses a durable loopback URL', met: false },
    ])));
    expect(remediated.inputs).not.toHaveProperty('rootRemediationScope');
    expect(remediated.inputs?.['rootAcceptanceRefusal']).toBe('Delivery rejected');
  });

  it('does not guess a focused scope when several criteria were rejected', () => {
    const remediated = remediationTask({ ...task, inputs: { rootRemediationScope: { mode: 'single-criterion', criterion: { id: 'old' } } } }, refusal([
      { id: 'c1', behaviour: 'The page remains interactive', met: false },
      { id: 'c2', behaviour: 'README uses a durable loopback URL', met: false },
    ]));

    expect(remediated.inputs).not.toHaveProperty('rootRemediationScope');
    expect(remediated.inputs?.['rootAcceptanceRefusal']).toBe('Delivery rejected');
  });
});
