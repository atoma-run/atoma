import { mockOtherProofReview } from './helpers/delegationReview.js';
import { describe, expect, it, beforeEach } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import type { LlmCompletionRequest, Plan, Result } from '../src/core/types.js';
import {
  PHASE_BUDGET_SPENT_PREFIX, ladderSpent, relayPeerLadder, spentPhaseResult, withSpentLadder,
} from '../src/core/phaseBudget.js';
import { buildResultGateEnv, runResultGates } from '../src/atoms/resultGates.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';

/**
 * Run bad74240 executed one molecule 13 times, 27 executions and 404 browser
 * checks in 4,222 s: a cell's retry ladder, run again whole by the tissue.
 * A root phase now gets one ladder: its cell's refused fallback goes up
 * unjudged for root acceptance to judge (owner decision 2026-10-10).
 *
 * Group G3 (review 2026-10-16): the ladder is recognised from a typed stamp
 * the supervise loop writes where it ends (`spentLadder`), so a plan `[C, A]`
 * without dependencies and a mutualized peer's fallback count too — and only
 * when a root acceptance will judge what goes up.
 */
const seed = { description: 'orchestrator', systemPrompt: 'You are an L2.', tools: [], params: {}, createdBy: 'test' };
const ok = (text: string) => ({ text, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } });
const refusal = (reasoning: string) => jsonText({ approved: false, reasoning, scope: 'ephemeral', modifications: { additionalContext: 'fix it' } });

function result(summary: string, producedBy: Result['producedBy'] = { tier: 1, name: 'Water', viaFallback: false }): Result {
  return { output: summary, summary, trace: [], producedBy };
}

describe('one ladder per root phase', () => {
  let reg: AtomRegistry;
  beforeEach(() => {
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
  });

  it('a tissue does not re-run a phase whose cell spent its ladder: the refused fallback goes up marked', async () => {
    reg.create(3, { ...seed, description: 'tissue', systemPrompt: 'You are an L3.' });
    const tissue = L3Atom.buildWithModel(reg.listByTier(3)[0]!, reg, FALLBACK_OPUS);
    const ctx = { ...makeCtx(), rootAcceptance: true as const };
    let executions = 0;
    const phase = { description: 'build the page', outputs: ['index.html'] };
    // Every plan approved, every result rejected, for ever: without the budget
    // the cell's ladder (retries, a branch, its fallback) runs again under
    // each of the tissue's retries.
    const respond = (req: LlmCompletionRequest) => {
      const tier = req.actor?.tier;
      if (req.role === 'prefilter') return ok(jsonText({ kind: 'escalate', reasoning: 'no match' }));
      if (req.role === 'plan' && tier === 3) return ok(jsonTextPair({ strategy: 'reuse', target: 'Tracheid', reasoning: 'r' },
        { reasoning: 'one phase', subtasks: [{ ...phase, preferredChild: 'Tracheid' }], aggregation: { mode: 'sequential' }, expectedOutput: 'page' }));
      if (req.role === 'plan' && tier === 2) return ok(jsonTextPair({ strategy: 'reuse', target: 'Water', reasoning: 'r' },
        { reasoning: 'one step', subtasks: [{ ...phase, preferredChild: 'Water' }], aggregation: { mode: 'sequential' }, expectedOutput: 'page' }));
      if (req.role === 'plan' || req.role === 'fallback-plan') return ok(jsonText({ reasoning: 'r', proposedAction: 'write it', expectedOutput: 'page' }));
      // A molecule's execution and a supervisor's fallback both count.
      if (req.role === 'execute' || req.role === 'fallback-execute') { executions++; return ok(jsonText({ output: `attempt ${executions}`, summary: `attempt ${executions}` })); }
      if (req.role === 'validate-plan') return ok(jsonText({ approved: true, reasoning: 'fine', ...mockOtherProofReview(req) }));
      return ok(refusal(`still missing ${executions}`));
    };
    for (let i = 0; i < 400; i++) ctx.llm.enqueue(respond);
    const result = await tissue.handle({ description: 'build the page' }, ctx);
    // Six molecule executions (three tries, a branch's three) and the cell's
    // fallback: one ladder, never a second.
    expect(executions).toBe(7);
    expect(result.phaseBudgetSpent).toBe(true);
    expect(result.summary).toContain(PHASE_BUDGET_SPENT_PREFIX);
    expect(result.summary).toContain('attempt 7');
    expect(result.summary).toContain('still missing 7');
  });

  it('forces review, never rejects', async () => {
    const env = buildResultGateEnv({ task: { description: 't' }, childName: 'Cell', childToolNames: [], ctx: makeCtx(),
      result: { output: null, summary: 's', trace: [], producedBy: { tier: 2, name: 'Cell', viaFallback: true }, phaseBudgetSpent: true } });
    const outcome = await runResultGates(env, new Set(), 'delegated');
    expect(outcome.rejection).toBeNull();
    expect(outcome.reviewFindings.map((f) => f.gateId)).toContain('phase-budget-spent');
  });
});

/**
 * One root phase whose cell plans `[C, A]` with no dependency: C is approved
 * at once, A's molecule is refused until the cell's own fallback answers it.
 * Counted by tier and actor, never by prose: C's molecule is the second L1,
 * A's is the first and the branch the cell makes of it.
 */
describe('a cell plan [C, A] without dependencies whose A ended in the cell fallback', () => {
  let reg: AtomRegistry;
  let cell: string;
  let a: string;
  let c: string;
  beforeEach(() => {
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(3, { ...seed, description: 'tissue', systemPrompt: 'You are an L3.' });
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
    reg.create(1, { ...seed, description: 'changelog writer', systemPrompt: 'You are an L1.' });
    cell = reg.listByTier(2)[0]!.name;
    [a, c] = reg.listByTier(1).map((type) => type.name) as [string, string];
  });

  const phase = 'build the adder and its changelog';
  const taskA = 'write add.ts';
  const taskC = 'write the changelog';

  /**
   * Every plan approved. The cell approves C (its result carries `OUT-C`) and
   * refuses anything carrying `OUT-A`: C runs first, so no validation of C
   * ever reads A's output. The tissue answers from `tissueVerdicts`.
   */
  function model(mode: Plan['aggregation']['mode'], tissueVerdicts: readonly boolean[]) {
    let molecule = 0;
    let tissue = 0;
    return (req: LlmCompletionRequest) => {
      const tier = req.actor?.tier;
      if (req.role === 'prefilter') return ok(jsonText({ kind: 'escalate', reasoning: 'no match' }));
      if (req.role === 'plan' && tier === 3) {
        return ok(jsonTextPair({ strategy: 'reuse', target: cell, reasoning: 'r' },
          { reasoning: 'one phase', subtasks: [{ description: phase, preferredChild: cell }], aggregation: { mode: 'sequential' }, expectedOutput: 'adder' }));
      }
      if (req.role === 'plan' && tier === 2) {
        return ok(jsonTextPair({ strategy: 'reuse', target: a, reasoning: 'r' }, {
          reasoning: 'two independent files',
          subtasks: [{ description: taskC, preferredChild: c }, { description: taskA, preferredChild: a }],
          aggregation: { mode }, expectedOutput: 'adder',
        }));
      }
      if (req.role === 'plan' || req.role === 'fallback-plan') return ok(jsonText({ reasoning: 'r', proposedAction: 'write it', expectedOutput: 'file' }));
      if (req.role === 'execute' && tier === 1) {
        molecule++;
        const marker = req.actor?.name === c ? `OUT-C-${molecule}` : `OUT-A-${molecule}`;
        return ok(jsonText({ output: marker, summary: marker }));
      }
      if (req.role === 'fallback-execute') return ok(jsonText({ output: 'OUT-FALLBACK', summary: 'OUT-FALLBACK' }));
      if (req.role === 'execute' && tier === 2) {
        const merged = [...new Set(req.userContent.match(/OUT-C-\d+|OUT-FALLBACK/g) ?? [])].join(' and ');
        return ok(jsonText({ output: 'merged', summary: `synthesis of ${merged}` }));
      }
      if (req.role === 'validate-plan') return ok(jsonText({ approved: true, reasoning: 'fine', ...mockOtherProofReview(req) }));
      if (req.role === 'validate-result' && tier === 2) {
        const approved = req.userContent.includes('OUT-C-') && !req.userContent.includes('OUT-A-');
        return ok(approved ? jsonText({ approved: true, reasoning: 'the changelog is there' }) : refusal(`add.ts still wrong ${molecule}`));
      }
      if (req.role === 'validate-result' && tier === 3) {
        const approved = tissueVerdicts[tissue] ?? tissueVerdicts[tissueVerdicts.length - 1]!;
        tissue++;
        return ok(approved ? jsonText({ approved: true, reasoning: 'phase complete' }) : refusal('the adder is not proven'));
      }
      throw new Error(`unexpected request: ${req.role} tier ${tier}`);
    };
  }

  function counts(calls: readonly LlmCompletionRequest[]) {
    return {
      cellPlans: calls.filter((req) => req.role === 'plan' && req.actor?.tier === 2).length,
      cellFallbackPlans: calls.filter((req) => req.role === 'fallback-plan' && req.actor?.tier === 2).length,
      executionsA: calls.filter((req) => req.role === 'execute' && req.actor?.tier === 1 && req.actor.name !== c).length,
      executionsC: calls.filter((req) => req.role === 'execute' && req.actor?.tier === 1 && req.actor.name === c).length,
      fallbackExecutions: calls.filter((req) => req.role === 'fallback-execute' && req.actor?.tier === 2).length,
      syntheses: calls.filter((req) => req.role === 'execute' && req.actor?.tier === 2).length,
      tissueVerdicts: calls.filter((req) => req.role === 'validate-result' && req.actor?.tier === 3).length,
    };
  }

  it.each(['sequential', 'concat', 'llm-synthesize'] as const)(
    '%s: the tissue refuses it and the whole phase goes up after one ladder', async (mode) => {
      const tissue = L3Atom.buildWithModel(reg.listByTier(3)[0]!, reg, FALLBACK_OPUS);
      const ctx = { ...makeCtx(), rootAcceptance: true as const };
      const respond = model(mode, [false]);
      for (let i = 0; i < 400; i++) ctx.llm.enqueue(respond);

      const handed = await tissue.handle({ description: phase }, ctx);

      const seen = counts(ctx.llm.calls);
      expect(seen.cellPlans).toBe(1);
      expect(seen.cellFallbackPlans).toBe(1);
      // Three tries, a branch's three, then the cell's own fallback: one ladder for A.
      expect(seen.executionsA).toBe(6);
      expect(seen.fallbackExecutions).toBe(1);
      expect(seen.executionsC).toBe(1);
      expect(seen.syntheses).toBe(mode === 'llm-synthesize' ? 1 : 0);
      expect(seen.tissueVerdicts).toBe(1);
      expect(handed.phaseBudgetSpent).toBe(true);
      expect(handed.summary).toContain(PHASE_BUDGET_SPENT_PREFIX);
      expect(handed.summary).toContain(`${cell}'s ladder ended in its last-resort fallback on "${taskA}"`);
      expect(handed.summary).toContain('OUT-C-1');
      expect(handed.summary).toContain('OUT-FALLBACK');
    });

  it('does not starve a healthy phase: approved subtasks, one tissue refusal, the phase runs again and is approved', async () => {
    const tissue = L3Atom.buildWithModel(reg.listByTier(3)[0]!, reg, FALLBACK_OPUS);
    const ctx = { ...makeCtx(), rootAcceptance: true as const };
    const base = model('concat', [false, true]);
    // Here the cell approves both subtasks: no ladder ends in a fallback.
    const respond = (req: LlmCompletionRequest) => req.role === 'validate-result' && req.actor?.tier === 2
      ? ok(jsonText({ approved: true, reasoning: 'file written' }))
      : base(req);
    for (let i = 0; i < 400; i++) ctx.llm.enqueue(respond);

    const approved = await tissue.handle({ description: phase }, ctx);

    const seen = counts(ctx.llm.calls);
    expect(seen.cellPlans).toBe(2);
    expect(seen.cellFallbackPlans).toBe(0);
    expect(seen.tissueVerdicts).toBe(2);
    expect(approved).not.toHaveProperty('phaseBudgetSpent');
    expect(approved.summary).not.toContain(PHASE_BUDGET_SPENT_PREFIX);
  });

  it('without a root acceptance the tissue retries a spent phase, as before the rule', async () => {
    const tissue = L3Atom.buildWithModel(reg.listByTier(3)[0]!, reg, FALLBACK_OPUS);
    const ctx = makeCtx();
    const respond = model('concat', [false, true]);
    for (let i = 0; i < 400; i++) ctx.llm.enqueue(respond);

    const retried = await tissue.handle({ description: phase }, ctx);

    const seen = counts(ctx.llm.calls);
    expect(seen.cellPlans).toBeGreaterThanOrEqual(2);
    expect(seen.cellFallbackPlans).toBe(2);
    expect(retried).not.toHaveProperty('phaseBudgetSpent');
  });
});

describe('an N=1 root phase without a root acceptance', () => {
  it('is retried by the tissue: the hand-up exists only for a run a root acceptance judges', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(3, { ...seed, description: 'tissue', systemPrompt: 'You are an L3.' });
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
    const tissue = L3Atom.buildWithModel(reg.listByTier(3)[0]!, reg, FALLBACK_OPUS);
    const ctx = makeCtx();
    const phase = { description: 'build the page', outputs: ['index.html'] };
    let tissueVerdicts = 0;
    const respond = (req: LlmCompletionRequest) => {
      const tier = req.actor?.tier;
      if (req.role === 'prefilter') return ok(jsonText({ kind: 'escalate', reasoning: 'no match' }));
      if (req.role === 'plan' && tier === 3) return ok(jsonTextPair({ strategy: 'reuse', target: 'Tracheid', reasoning: 'r' },
        { reasoning: 'one phase', subtasks: [{ ...phase, preferredChild: 'Tracheid' }], aggregation: { mode: 'sequential' }, expectedOutput: 'page' }));
      if (req.role === 'plan' && tier === 2) return ok(jsonTextPair({ strategy: 'reuse', target: 'Water', reasoning: 'r' },
        { reasoning: 'one step', subtasks: [{ ...phase, preferredChild: 'Water' }], aggregation: { mode: 'sequential' }, expectedOutput: 'page' }));
      if (req.role === 'plan' || req.role === 'fallback-plan') return ok(jsonText({ reasoning: 'r', proposedAction: 'write it', expectedOutput: 'page' }));
      if (req.role === 'execute' || req.role === 'fallback-execute') return ok(jsonText({ output: 'page', summary: 'page' }));
      if (req.role === 'validate-plan') return ok(jsonText({ approved: true, reasoning: 'fine', ...mockOtherProofReview(req) }));
      if (req.role === 'validate-result' && tier === 3) {
        tissueVerdicts++;
        return ok(tissueVerdicts === 1 ? refusal('not proven') : jsonText({ approved: true, reasoning: 'proven' }));
      }
      return ok(refusal(`still missing ${ctx.llm.calls.length}`));
    };
    for (let i = 0; i < 400; i++) ctx.llm.enqueue(respond);

    const retried = await tissue.handle({ description: 'build the page' }, ctx);

    expect(ctx.llm.calls.filter((req) => req.role === 'plan' && req.actor?.tier === 2).length).toBeGreaterThanOrEqual(2);
    expect(tissueVerdicts).toBe(2);
    expect(retried).not.toHaveProperty('phaseBudgetSpent');
  });
});

/**
 * The root plan is sequential: P1 goes to cell #2, which approves it, so cell
 * #1 — built for P2 — holds cell #2 as a peer and mutualizes P2 to it. Cell
 * #2's molecule is refused on P2 until its own fallback answers, and the
 * tissue refuses that.
 */
describe('a phase its cell mutualized to a peer whose ladder ended in its fallback', () => {
  it('goes up once, naming the peer, instead of running the peer ladder again', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(3, { ...seed, description: 'tissue', systemPrompt: 'You are an L3.' });
    reg.create(2, seed);
    reg.create(2, { ...seed, description: 'api orchestrator' });
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
    const [first, second] = reg.listByTier(2).map((type) => type.name) as [string, string];
    const molecule = reg.listByTier(1)[0]!.name;
    const tissue = L3Atom.buildWithModel(reg.listByTier(3)[0]!, reg, FALLBACK_OPUS);
    const ctx = { ...makeCtx(), rootAcceptance: true as const };
    const p1 = 'build the page';
    const p2 = 'build the api';
    let tissueVerdicts = 0;
    const respond = (req: LlmCompletionRequest) => {
      const tier = req.actor?.tier;
      if (req.role === 'prefilter') return ok(jsonText({ kind: 'escalate', reasoning: 'no match' }));
      if (req.role === 'plan' && tier === 3) return ok(jsonTextPair({ strategy: 'reuse', target: second, reasoning: 'r' }, {
        reasoning: 'two phases',
        subtasks: [{ description: p1, preferredChild: second }, { description: p2, preferredChild: first }],
        aggregation: { mode: 'sequential' }, expectedOutput: 'app',
      }));
      if (req.role === 'plan' && req.actor?.name === first) return ok(jsonTextPair({ strategy: 'mutualize', target: second, reasoning: 'the peer fits' },
        { reasoning: 'delegate', subtasks: [{ description: p2 }], aggregation: { mode: 'sequential' }, expectedOutput: 'api' }));
      if (req.role === 'plan' && tier === 2) {
        const description = tissueVerdicts === 0 ? p1 : p2;
        return ok(jsonTextPair({ strategy: 'reuse', target: molecule, reasoning: 'r' },
          { reasoning: 'one step', subtasks: [{ description, preferredChild: molecule }], aggregation: { mode: 'sequential' }, expectedOutput: 'file' }));
      }
      if (req.role === 'plan' || req.role === 'fallback-plan') return ok(jsonText({ reasoning: 'r', proposedAction: 'write it', expectedOutput: 'file' }));
      if (req.role === 'execute' || req.role === 'fallback-execute') return ok(jsonText({ output: `${req.role} by ${req.actor?.name}`, summary: `${req.role} by ${req.actor?.name}` }));
      if (req.role === 'validate-plan') return ok(jsonText({ approved: true, reasoning: 'fine', ...mockOtherProofReview(req) }));
      if (req.role === 'validate-result' && tier === 3) {
        tissueVerdicts++;
        return ok(tissueVerdicts === 1 ? jsonText({ approved: true, reasoning: 'page proven' }) : refusal('the api is not proven'));
      }
      // The molecule: approved on P1, refused on P2.
      return ok(tissueVerdicts === 0 ? jsonText({ approved: true, reasoning: 'written' }) : refusal(`api still wrong ${ctx.llm.calls.length}`));
    };
    for (let i = 0; i < 400; i++) ctx.llm.enqueue(respond);

    const handed = await tissue.handle({ description: 'build the app' }, ctx);

    const calls = ctx.llm.calls;
    const firstTissueVerdict = calls.findIndex((req) => req.role === 'validate-result' && req.actor?.tier === 3);
    const firstMutualization = calls.findIndex((req) => req.role === 'plan' && req.actor?.name === first);
    // Sequential: cell #1 plans only once P1 was approved.
    expect(firstMutualization).toBeGreaterThan(firstTissueVerdict);
    // Without the relay the peer's ladder runs again under the tissue's retry.
    expect(calls.filter((req) => req.role === 'fallback-plan' && req.actor?.name === second)).toHaveLength(1);
    expect(calls.filter((req) => req.role === 'plan' && req.actor?.name === first)).toHaveLength(1);
    expect(tissueVerdicts).toBe(2);
    expect(handed.phaseBudgetSpent).toBe(true);
    expect(handed.summary).toContain(`${first}'s ladder ended in its last-resort fallback on "${p2}" (in ${second}, to which ${first} delegated this phase)`);
  });

  it('never relays a peer result that walked no ladder: a peer in fallback mode answers unsupervised', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(2, { ...seed, description: 'api orchestrator' });
    const [xType, peerType] = reg.listByTier(2) as [NonNullable<ReturnType<typeof reg.getByName>>, NonNullable<ReturnType<typeof reg.getByName>>];
    const x = L2Atom.fromType(xType, reg);
    const peer = L2Atom.fromType(peerType, reg);
    x.addPeer(peer);
    // Another root lane holds this peer in its own fallback.
    peer.setFallbackMode(true);
    const ctx = makeCtx();
    const task = { description: 'build the api' };
    ctx.llm.enqueue(ok(jsonTextPair({ strategy: 'mutualize', target: peer.name, reasoning: 'the peer fits' },
      { reasoning: 'delegate', subtasks: [{ description: task.description }], aggregation: { mode: 'sequential' }, expectedOutput: 'api' })));
    for (let i = 0; i < 10; i++) {
      ctx.llm.enqueue((req: LlmCompletionRequest) => req.role === 'fallback-plan'
        ? ok(jsonText({ reasoning: 'r', proposedAction: 'write it', expectedOutput: 'api' }))
        : ok(jsonText({ output: 'api', summary: 'api written by the peer' })));
    }

    const plan = await x.plan(task, ctx);
    const answered = await x.execute(task, plan, ctx);

    expect(answered.producedBy).toMatchObject({ name: peer.name, viaFallback: true });
    expect(answered).not.toHaveProperty('spentLadder');
    expect(ladderSpent(answered, x.name)).toBe(false);
  });
});

describe('the spent-ladder stamp', () => {
  const stamped = (by: string, on: string[], via?: string): Result =>
    ({ ...result('fallback', { tier: 2, name: by, viaFallback: true }), spentLadder: { by, on, ...(via ? { via } : {}) } });
  const aggregate = result('aggregate', { tier: 2, name: 'Tracheid', viaFallback: false });

  it('is carried onto an aggregate only from its own atom\'s sub-results, as one union', () => {
    const carried = withSpentLadder(aggregate, [stamped('Tracheid', ['a']), result('c'), stamped('Tracheid', ['b', 'a'])], 'Tracheid');

    expect(carried.spentLadder).toEqual({ by: 'Tracheid', on: ['a', 'b'] });
    expect(withSpentLadder(aggregate, [stamped('Phloem', ['a'])], 'Tracheid')).toBe(aggregate);
    expect(withSpentLadder(aggregate, [result('c')], 'Tracheid')).toBe(aggregate);
  });

  it('is re-addressed through a mutualization, keeping the first peer across a chain', () => {
    const fromPeer = relayPeerLadder(stamped('Phloem', ['api']), 'Phloem', 'Tracheid');
    const chained = relayPeerLadder(fromPeer, 'Tracheid', 'Xylem');

    expect(fromPeer.spentLadder).toEqual({ by: 'Tracheid', on: ['api'], via: 'Phloem' });
    expect(chained.spentLadder).toEqual({ by: 'Xylem', on: ['api'], via: 'Phloem' });
    expect(fromPeer.producedBy.name).toBe('Phloem');
    const foreign = stamped('Sieve', ['api']);
    expect(relayPeerLadder(foreign, 'Phloem', 'Tracheid')).toBe(foreign);
    const none = result('api');
    expect(relayPeerLadder(none, 'Phloem', 'Tracheid')).toBe(none);
  });

  it('spends only the named cell\'s ladder', () => {
    expect(ladderSpent(stamped('Tracheid', ['a']), 'Tracheid')).toBe(true);
    expect(ladderSpent(stamped('Phloem', ['a']), 'Tracheid')).toBe(false);
    expect(ladderSpent(result('fallback', { tier: 2, name: 'Tracheid', viaFallback: true }), 'Tracheid')).toBe(false);
  });

  it('renders the hand-up clause from the stamp, bounded', () => {
    const many = ['x'.repeat(200), 'b', 'c', 'd', 'e'];

    const own = spentPhaseResult(stamped('Tracheid', ['write add.ts']), 'the adder is not proven');
    const relayed = spentPhaseResult(stamped('Tracheid', ['build the api'], 'Phloem'), 'no');
    const long = spentPhaseResult(stamped('Tracheid', many), 'no');

    expect(own.summary).toBe(
      `${PHASE_BUDGET_SPENT_PREFIX}: Tracheid's ladder ended in its last-resort fallback on "write add.ts", ` +
      'and the tissue still refused this result (the adder is not proven); it is handed up unjudged]\nfallback');
    expect(relayed.summary).toContain('on "build the api" (in Phloem, to which Tracheid delegated this phase), and the tissue');
    expect(long.summary).toContain(`"${'x'.repeat(119)}…", "b", "c" and 2 more,`);
    expect(own.phaseBudgetSpent).toBe(true);
  });
});

describe('the unvalidated-fallback gate', () => {
  async function findings(subject: Result, childName: string) {
    const env = buildResultGateEnv({ task: { description: 't' }, childName, childToolNames: [], ctx: makeCtx(), result: subject });
    const outcome = await runResultGates(env, new Set(), 'delegated');
    return outcome.reviewFindings.filter((finding) => finding.gateId === 'unvalidated-fallback');
  }

  it('reviews a result only part of which is the child\'s own fallback, and says which part', async () => {
    const partial: Result = { ...result('two parts', { tier: 2, name: 'Tracheid', viaFallback: false }),
      spentLadder: { by: 'Tracheid', on: ['write add.ts'], via: 'Phloem' } };

    const [finding] = await findings(partial, 'Tracheid');

    expect(finding?.reasoning).toBe(
      'part of this result ("write add.ts") is Tracheid\'s own last-resort fallback, run in Phloem, which no supervisor has validated');
    expect(finding?.disposition).toBe('requires-review');
  });

  it('ignores another atom\'s stamp and still reviews a whole fallback', async () => {
    const foreign: Result = { ...result('two parts', { tier: 2, name: 'Tracheid', viaFallback: false }),
      spentLadder: { by: 'Phloem', on: ['write add.ts'] } };
    const whole = result('fallback', { tier: 2, name: 'Tracheid', viaFallback: true });

    expect(await findings(foreign, 'Tracheid')).toHaveLength(0);
    const [finding] = await findings(whole, 'Tracheid');
    expect(finding?.reasoning).toContain("this is Tracheid's own last-resort fallback");
  });
});
