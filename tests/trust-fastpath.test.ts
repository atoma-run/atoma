import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { INTERNAL_VALIDATION_FAILED_PREFIX } from '../src/atoms/L1Atom.js';
import { withOwnFallbackLoopFacts, withoutExecutorLoopFacts } from '../src/atoms/resultGates.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import type { TrustFastPathInfo } from '../src/core/types.js';

const seed = {
  description: 'seed',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('trust fast-path in validators', () => {
  it.each([false, true])('L3 rejects a malformed real L2 fallback before trust (trusted=%s)', async (trusted) => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l2Type = reg.create(2, seed);
    if (trusted) {
      for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l2Type.name);
    }
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(l2Type, reg);
    l2.setFallbackMode(true);
    const events: TrustFastPathInfo[] = [];
    const ctx = { ...makeCtx(), recordTrust: (event: TrustFastPathInfo) => events.push(event) };
    const task = { description: 'verify the existing notes server' };
    ctx.llm.enqueueText(JSON.stringify({ reasoning: 'inspect', proposedAction: 'inspect', expectedOutput: 'proof' }));
    const plan = await l2.plan(task, ctx);
    ctx.llm.enqueueText('Now let me write the api/notes file with seed data:');
    const result = await l2.execute(task, plan, ctx);
    const callsBefore = ctx.llm.calls.length;
    const verdict = await l3.validateResult(l2, result, task, ctx);
    expect(verdict.approved).toBe(false);
    expect(verdict.reasoning).toContain('JSON envelope');
    expect(ctx.llm.calls).toHaveLength(callsBefore);
    expect(events).toHaveLength(0);
  });

  it('L3 rejects an explicit failed browser result even for a trusted cell', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l2Type = reg.create(2, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l2Type.name);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(l2Type, reg);
    const ctx = makeCtx();
    const verdict = await l3.validateResult(l2, {
      output: null,
      summary: `${INTERNAL_VALIDATION_FAILED_PREFIX}: API request failed`,
      trace: [],
      producedBy: { tier: 2, name: l2.name, viaFallback: true },
    }, { description: 'verify the page' }, ctx);
    expect(verdict.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('L3 leaves leaf-only action gates with L2 for successful delegated results', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l2Type = reg.create(2, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l2Type.name);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(l2Type, reg);
    const ctx = { ...makeCtx(), requireObservedToolAction: true };
    const verdict = await l3.validateResult(l2, {
      output: 'child completed the work', summary: 'verified', trace: [], toolCallResults: [],
      producedBy: { tier: 2, name: l2.name, viaFallback: false },
    }, { description: 'build an artefact' }, ctx);
    expect(verdict.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('L2.validatePlan skips the LLM call when the child type is trusted', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);                 // Tracheid (L2 itself)
    const l1Type = reg.create(1, seed);  // Water
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);

    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);

    const ctx = makeCtx();  // no queued responses — LLM must not be called

    const verdict = await l2.validatePlan(
      l1,
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      { description: 't' },
      ctx
    );
    expect(verdict.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('L2.validateResult also skips when trusted', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    const l1Type = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);

    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);
    const ctx = makeCtx();

    const v = await l2.validateResult(
      l1,
      {
        output: 'x',
        summary: 's',
        trace: [],
        producedBy: { tier: 1, name: 'Water', viaFallback: false },
      },
      { description: 't' },
      ctx
    );
    expect(v.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('trust is revoked after a single failure', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    const l1Type = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);
    reg.recordFailure(l1Type.name);

    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);
    const ctx = makeCtx();
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'real verdict' }));

    const v = await l2.validatePlan(
      l1,
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      { description: 't' },
      ctx
    );
    expect(v.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(1);  // LLM was called this time
  });

  it('invokes ctx.recordTrust on every fast-path approval (observability)', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    const l1Type = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);
    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);

    const trustEvents: TrustFastPathInfo[] = [];
    const ctx = { ...makeCtx(), recordTrust: (i: TrustFastPathInfo) => trustEvents.push(i) };

    await l2.validatePlan(
      l1,
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      { description: 't' },
      ctx
    );
    await l2.validateResult(
      l1,
      {
        output: 'x',
        summary: 's',
        trace: [],
        producedBy: { tier: 1, name: 'Water', viaFallback: false },
      },
      { description: 't' },
      ctx
    );

    expect(trustEvents).toHaveLength(2);
    expect(trustEvents[0]!.subject).toBe('PLAN');
    expect(trustEvents[0]!.supervisorName).toBe('Tracheid');
    expect(trustEvents[0]!.childName).toBe('Water');
    expect(trustEvents[0]!.successes).toBe(TRUST_THRESHOLD_SUCCESSES);
    expect(trustEvents[0]!.reasoning).toMatch(/trust fast-path/);
    expect(trustEvents[1]!.subject).toBe('RESULT');
  });

  it('does NOT invoke recordTrust when the LLM path is taken (not trusted)', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, seed); // zero successes, not trusted
    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);

    const trustEvents: TrustFastPathInfo[] = [];
    const ctx = { ...makeCtx(), recordTrust: (i: TrustFastPathInfo) => trustEvents.push(i) };
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'real verdict' }));

    await l2.validatePlan(
      l1,
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      { description: 't' },
      ctx
    );

    expect(trustEvents).toHaveLength(0);
    expect(ctx.llm.calls).toHaveLength(1);
  });

  // Production run dfa20873 (2026-10-03): a molecule the deadline had cut to
  // three tool iterations answered {"status":"incomplete"}, its cell's trust
  // fast path approved and credited it, then the tissue's trust fast path
  // approved the phase. The transport's finalization fact now takes such a
  // result off both fast paths at both tiers; the model decides.
  const exhausted = (tier: 1 | 2, name: string, viaFallback: boolean) => ({
    output: { entry: 'server.js', status: 'incomplete' },
    summary: 'Existing artifacts were inspected, but verification could not be completed because the tool budget was exhausted.',
    trace: [],
    toolCallResults: [{ name: 'list_files', args: {}, result: '[]' }],
    toolBudgetExhausted: true as const,
    producedBy: { tier, name, viaFallback },
  });
  const reject = JSON.stringify({ approved: false, reasoning: 'the result reports its HTTP probes were never run', scope: 'ephemeral' });

  it("L2 hands a trusted molecule's budget-exhausted result to the model instead of the trust fast path", async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    const l1Type = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);
    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);
    const events: TrustFastPathInfo[] = [];
    const ctx = { ...makeCtx(), recordTrust: (event: TrustFastPathInfo) => events.push(event) };
    ctx.llm.enqueueText(reject);
    const v = await l2.validateResult(l1, exhausted(1, 'Water', false), { description: 'build and probe the API' }, ctx);
    expect(v.approved).toBe(false);
    expect(events).toHaveLength(0);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toContain('[tool-budget-exhausted]');
    // The same result without the transport fact keeps the earned fast path,
    // once its summary no longer admits unfinished verification
    // (`declared-unverified` reads that admission on its own).
    const { toolBudgetExhausted: _fact, ...complete } = exhausted(1, 'Water', false);
    void _fact;
    const trusted = await l2.validateResult(l1, { ...complete, summary: 'Existing artifacts were inspected.' },
      { description: 'build and probe the API' }, ctx);
    expect(trusted.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it("L2 hands a trusted molecule's result that admits its verification did not happen to the model (run d162ee31)", async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    const l1Type = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);
    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);
    const events: TrustFastPathInfo[] = [];
    const ctx = { ...makeCtx(), recordTrust: (event: TrustFastPathInfo) => events.push(event) };
    ctx.llm.enqueueText(reject);
    const admitted = { output: {}, summary: 'Read the files and started the server; verification incomplete. Required fetch_url probes and validate_html browser verification were not completed.',
      trace: [], toolCallResults: [{ name: 'list_files', args: {}, result: '[]' }], producedBy: { tier: 1 as const, name: 'Water', viaFallback: false } };
    const v = await l2.validateResult(l1, admitted, { description: 'build and probe the notes app' }, ctx);
    expect(v.approved).toBe(false);
    expect(events).toHaveLength(0);
    expect(ctx.llm.calls[0]!.userContent).toContain('[declared-unverified]');
  });

  it("L3 hands a trusted cell's budget-exhausted fallback result to the model", async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l2Type = reg.create(2, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l2Type.name);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(l2Type, reg);
    const events: TrustFastPathInfo[] = [];
    const ctx = { ...makeCtx(), recordTrust: (event: TrustFastPathInfo) => events.push(event) };
    ctx.llm.enqueueText(reject);
    const v = await l3.validateResult(l2, exhausted(2, l2.name, true), { description: 'build and probe the API' }, ctx);
    expect(v.approved).toBe(false);
    expect(events).toHaveLength(0);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toContain('[tool-budget-exhausted]');
  });

  it("L3 no longer trusts past a reporting delegated gate: a read-only phase's failed validation reaches the model", async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l2Type = reg.create(2, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l2Type.name);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(l2Type, reg);
    const ctx = makeCtx();
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: "the finding is the phase's report", scope: 'ephemeral' }));
    const v = await l3.validateResult(l2, {
      output: null,
      summary: `${INTERNAL_VALIDATION_FAILED_PREFIX}: the button does not respond`,
      trace: [],
      producedBy: { tier: 2, name: l2.name, viaFallback: false },
    }, { description: 'verify the page', readOnly: true }, ctx);
    expect(v.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toContain('[read-only-validation-failed]');
  });

  it("an aggregate passing one result up drops the executor's loop fact its supervisor already judged", () => {
    const only = exhausted(1, 'Water', false);
    const passed = withoutExecutorLoopFacts(only);
    expect(passed.toolBudgetExhausted).toBeUndefined();
    expect(passed.summary).toBe(only.summary);
    expect(passed.toolCallResults).toBe(only.toolCallResults);
    const plain = { output: 1, summary: 's', trace: [], producedBy: { tier: 1 as const, name: 'Water', viaFallback: false } };
    expect(withoutExecutorLoopFacts(plain)).toBe(plain);
  });

  it("L3 reads a trusted cell's own fallback instead of trusting it (run 1d42ac2a)", async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l2Type = reg.create(2, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l2Type.name);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(l2Type, reg);
    const ctx = makeCtx();
    ctx.llm.enqueueText(reject);
    const v = await l3.validateResult(l2, {
      output: 'Unverified and incomplete; existing files preserved.',
      summary: 'fallback could not verify the API',
      trace: [],
      producedBy: { tier: 2, name: l2.name, viaFallback: true },
    }, { description: 'build and probe the API' }, ctx);
    expect(v.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toContain('[unvalidated-fallback]');
  });

  it("an aggregate keeps the loop fact of the aggregating atom's OWN fallback, which nobody below judged", () => {
    const own = exhausted(2, 'Tracheid', true);
    const passed = withOwnFallbackLoopFacts(withoutExecutorLoopFacts(own), [own], 'Tracheid');
    expect(passed.toolBudgetExhausted).toBe(true);
    // A molecule's exhausted loop was judged by this cell; a peer's fallback is not this atom's own.
    const molecule = exhausted(1, 'Water', false);
    expect(withOwnFallbackLoopFacts(withoutExecutorLoopFacts(molecule), [molecule], 'Tracheid').toolBudgetExhausted).toBeUndefined();
    const peer = exhausted(2, 'Xylem', true);
    expect(withOwnFallbackLoopFacts(withoutExecutorLoopFacts(peer), [peer], 'Tracheid').toolBudgetExhausted).toBeUndefined();
  });

  it('L3 validators skip LLM calls once the child L2 type is trusted', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l2Type = reg.create(2, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l2Type.name);

    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(l2Type, reg);

    const ctx = makeCtx();
    const vp = await l3.validatePlan(
      l2,
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      { description: 't' },
      ctx
    );
    const vr = await l3.validateResult(
      l2,
      {
        output: 'x',
        summary: 's',
        trace: [],
        producedBy: { tier: 2, name: l2.name, viaFallback: false },
      },
      { description: 't' },
      ctx
    );
    expect(vp.approved).toBe(true);
    expect(vr.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
  });
});
