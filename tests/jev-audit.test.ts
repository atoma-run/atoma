import { describe, expect, it } from 'vitest';
import { jevApproval } from '../src/atoms/cost.js';
import { auditReport, collectCorpus, decisionsOfTrace } from '../src/atoms/jevCalibration.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { JEV_AUDIT_RATE, createJevAudit } from '../src/core/jev.js';
import type { JevDecider, RunContext } from '../src/core/types.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { makePlan } from './helpers/factories.js';
import { makeCtx } from './helpers.js';
import { FALLBACK_OPUS } from './tier-pins.js';

/**
 * THE JEV AUDIT (docs/jev-decisions-2026-09-28.md): once Jev decides, the
 * model sees only what Jev hands it, so a share of Jev's approvals is also
 * judged by the model validator, off the run's path, to keep Jev's false
 * approvals measured. These pin that it measures and never decides: Jev's
 * approval stands whatever the model says, the audit is the model's verdict
 * under its own `jev-audit` role, it reaches every lane, a run waits for it
 * before closing its trace, and the calibration reads it apart from decisions.
 */

const seed = { description: 'seed', systemPrompt: 'sys', tools: [], params: {}, createdBy: 'test' };
const plan = makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' });
const result = { output: 'x', summary: 's', trace: [], producedBy: { tier: 1 as const, name: 'Water', viaFallback: false } };

function approving(): JevDecider {
  return {
    choose: async () => null,
    approve: async () => ({ approved: true, probability: 0.9 }),
    twin: async () => null,
  };
}

/** A registry whose audits run immediately and are kept, so a test can await them. */
function auditing(rate: number) {
  const runs: Promise<unknown>[] = [];
  const jevAudit: NonNullable<RunContext['jevAudit']> = { rate, defer: (work) => void runs.push(work()) };
  return { jevAudit, runs };
}

function untrustedL2() {
  const reg = new AtomRegistry(openDb(':memory:'));
  reg.create(2, seed);
  reg.create(1, seed); // zero successes: no trust fast path
  return { l2: L2Atom.fromType(reg.getByName('Tracheid')!, reg), l1: L1Atom.fromType(reg.getByName('Water')!) };
}

describe('the audit decides nothing', () => {
  it("keeps Jev's approval of a plan and a result though the model refuses both, and records the model's verdict as jev-audit", async () => {
    const { l2, l1 } = untrustedL2();
    const { jevAudit, runs } = auditing(1);
    const ctx = { ...makeCtx(), jev: approving(), jevAudit };
    ctx.llm.enqueueText(JSON.stringify({ approved: false, reasoning: 'the model would refuse the plan' }));
    ctx.llm.enqueueText(JSON.stringify({ approved: false, reasoning: 'the model would refuse the result' }));
    const vp = await l2.validatePlan(l1, plan, { description: 't' }, ctx);
    const vr = await l2.validateResult(l1, result, { description: 't' }, ctx);
    await Promise.all(runs);
    expect(vp).toMatchObject({ approved: true, reasoning: expect.stringMatching(/jev fast-path/), viaJev: true });
    expect(vr).toMatchObject({ approved: true, reasoning: expect.stringMatching(/jev fast-path/), viaJev: true });
    // The same verdict the model gives without Jev, under its own role, so no
    // reader counts it as the run's validation.
    expect(ctx.llm.calls.map((call) => [call.role, call.subject, call.child?.name])).toEqual([
      ['jev-audit', 'PLAN', 'Water'],
      ['jev-audit', 'RESULT', 'Water'],
    ]);
  });

  it('audits a cell approved at L3 too', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3 = L3Atom.buildWithModel(reg.create(3, seed), reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(reg.create(2, seed), reg);
    const { jevAudit, runs } = auditing(1);
    const ctx = { ...makeCtx(), jev: approving(), jevAudit };
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'agrees' }));
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'agrees' }));
    await l3.validatePlan(l2, plan, { description: 't' }, ctx);
    await l3.validateResult(
      l2,
      { output: 'x', summary: 's', trace: [], producedBy: { tier: 2, name: l2.name, viaFallback: false } },
      { description: 't' },
      ctx
    );
    await Promise.all(runs);
    expect(ctx.llm.calls.map((call) => call.role)).toEqual(['jev-audit', 'jev-audit']);
  });

  it('audits only what Jev approved, and only the sampled share', async () => {
    const child = { name: 'Water', tier: 1 as const, toolNames: () => [] };
    const ask = (jev: JevDecider, rate: number) => {
      let audited = 0;
      const ctx = { ...makeCtx(), jev, jevAudit: { rate, defer: () => void (audited += 1) } };
      return jevApproval({
        ctx,
        subject: 'PLAN',
        supervisorName: 'Tracheid',
        supervisorTier: 2,
        child,
        task: { description: 't' },
        payload: plan,
        audit: async () => undefined,
      }).then((approval) => ({ approval, audited }));
    };
    expect(await ask(approving(), 1)).toMatchObject({ approval: { approved: true }, audited: 1 });
    expect(await ask(approving(), 0)).toMatchObject({ approval: { approved: true }, audited: 0 });
    const declining: JevDecider = { ...approving(), approve: async () => ({ approved: false, probability: 0.2 }) };
    expect(await ask(declining, 1)).toMatchObject({ approval: null, audited: 0 });
    expect(JEV_AUDIT_RATE).toBe(0.1);
  });

  it('reaches every lane: a fork shares the run registry', () => {
    const { jevAudit } = auditing(1);
    const fork = forkBranch({ ...makeCtx(), jevAudit }, 'lane-1');
    expect(fork.jevAudit).toBe(jevAudit);
    expect(forkBranch(fork, 'lane-2').jevAudit).toBe(jevAudit);
  });
});

describe("the run's audit registry", () => {
  it('runs audits off the path, drops one that fails, and waits for the rest before the trace closes', async () => {
    const { audit, settle } = createJevAudit(1);
    const done: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    audit.defer(async () => {
      await gate;
      done.push('slow');
    });
    audit.defer(async () => {
      throw new Error('transport down');
    });
    expect(done).toEqual([]);
    const settled = settle(5_000);
    release();
    await settled;
    expect(done).toEqual(['slow']);
  });

  it('never holds a run past its bound', async () => {
    const { audit, settle } = createJevAudit(1);
    audit.defer(() => new Promise(() => {}));
    const started = Date.now();
    await settle(30);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('reading the audit sample', () => {
  const llm = (id: string, role: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: 'llm',
    role,
    subject: 'RESULT',
    actor: { name: 'Tracheid', tier: 2 },
    child: { name: 'Water', tier: 1 },
    systemPrompt: 'sys',
    userContent: 'prompt',
    response: JSON.stringify({ approved: true, reasoning: 'ok' }),
    ...extra,
  });

  it('reads audits apart from the model decisions, in runs Jev decided in as well', () => {
    const trace = {
      startedAt: '2026-10-01T10:00:00.000Z',
      events: [
        { id: 'j1', kind: 'jev', role: 'validate-result' },
        llm('a1', 'jev-audit', { response: JSON.stringify({ approved: false, reasoning: 'no proof' }) }),
        llm('a2', 'jev-audit', { subject: 'PLAN' }),
        llm('a3', 'jev-audit', { error: 'timeout', response: '' }),
        llm('v1', 'validate-result'),
      ],
    };
    const found = decisionsOfTrace(trace, { runId: 'r', orgId: 'o' });
    expect(found.decisions.map((decision) => decision.eventId)).toEqual(['v1']);
    expect(found.audits.map((audit) => [audit.eventId, audit.subject, audit.approvedByModel])).toEqual([
      ['a1', 'RESULT', false],
      ['a2', 'PLAN', true],
      ['a3', 'RESULT', null],
    ]);
    // A Jev run's decisions are left out of the corpus by default; its audits never are.
    const corpus = collectCorpus({ traces: [{ runId: 'r', orgId: 'o', read: () => trace }], since: '2026-10-01' });
    expect(corpus.decisions).toEqual([]);
    expect(corpus.audits).toHaveLength(3);
    expect(auditReport(corpus.audits)).toEqual({
      subjects: [
        { subject: 'PLAN', audited: 1, judged: 1, refusedByModel: 0, falseApprovalShare: 0, refusals: [] },
        {
          subject: 'RESULT',
          audited: 2,
          judged: 1,
          refusedByModel: 1,
          falseApprovalShare: 1,
          refusals: [{ runId: 'r', eventId: 'a1', child: 'Water' }],
        },
      ],
    });
  });
});
