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
  it('focuses a single rejected criterion while preserving the original task identity', () => {
    const remediated = remediationTask(task, refusal([
      { id: 'c1', behaviour: 'The page remains interactive', met: true },
      { id: 'c2', behaviour: 'README uses a durable loopback URL', met: false, reason: 'It contains the observed numeric port' },
    ]));

    expect(remediated.description).toBe(task.description);
    expect(remediated.inputs?.['rootRemediationScope']).toEqual({
      mode: 'single-criterion',
      criterion: {
        id: 'c2',
        behaviour: 'README uses a durable loopback URL',
        reason: 'It contains the observed numeric port',
      },
      instruction: 'Preserve already validated deliverables. Diagnose and remediate only this rejected criterion, then re-run its relevant checks.',
    });
  });

  it('does not guess a focused scope when several criteria were rejected', () => {
    const remediated = remediationTask(task, refusal([
      { id: 'c1', behaviour: 'The page remains interactive', met: false },
      { id: 'c2', behaviour: 'README uses a durable loopback URL', met: false },
    ]));

    expect(remediated.inputs).not.toHaveProperty('rootRemediationScope');
    expect(remediated.inputs?.['rootAcceptanceRefusal']).toBe('Delivery rejected');
  });
});
