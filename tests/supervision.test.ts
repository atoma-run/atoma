import { describe, it, expect, vi } from 'vitest';
import { Atom, type Supervisor } from '../src/core/atom.js';
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  Plan,
  Result,
  RunContext,
  Task,
  Tier,
  Verdict,
} from '../src/core/types.js';
import {
  MAX_SAME_MARKER_REJECTS,
  MAX_SAME_REASON_REJECTS,
  detectPolicyMarker,
  normalizeReason,
  superviseLoop,
  type SupervisionHooks,
} from '../src/core/supervisor.js';
import { makeCtx } from './helpers.js';
import { PlanParseError } from '../src/core/errors.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { makePlan } from './helpers/factories.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetPrefilterCacheForTests } from '../src/atoms/prefilterCache.js';

class FakeChild extends Atom {
  readonly model = 'fake';
  public planCount = 0;
  public execCount = 0;

  constructor(public label: string, readonly tier: Tier = 1) {
    super({
      name: `child:${label}`,
      ordinal: 0,
      systemPrompt: 'x',
      tools: [],
      params: {},
    });
  }

  async plan(_task: Task, _ctx: RunContext): Promise<Plan> {
    this.planCount++;
    return makePlan({
      reasoning: 'r',
      proposedAction: `${this.label}#plan:${this.planCount}`,
      expectedOutput: 'out',
    });
  }

  async execute(_task: Task, _plan: Plan, _ctx: RunContext): Promise<Result> {
    this.execCount++;
    return {
      output: `${this.label}:output`,
      summary: `${this.label}:summary`,
      trace: [],
      producedBy: { tier: this.tier, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }
}

class FakeParent extends Atom implements Supervisor<FakeChild> {
  readonly model = 'fake-parent';
  private planVerdicts: Verdict[] = [];
  private resultVerdicts: Verdict[] = [];
  public selfPlans = 0;
  public selfExecs = 0;

  constructor(readonly tier: Tier = 2) {
    super({
      name: 'parent',
      ordinal: 0,
      systemPrompt: 'p',
      tools: [],
      params: {},
    });
  }

  queuePlanVerdict(v: Verdict): void {
    this.planVerdicts.push(v);
  }
  queueResultVerdict(v: Verdict): void {
    this.resultVerdicts.push(v);
  }

  async validatePlan(_c: FakeChild, _p: Plan, _t: Task, _ctx: RunContext): Promise<Verdict> {
    const v = this.planVerdicts.shift();
    if (!v) throw new Error('no planVerdict queued');
    return v;
  }

  async validateResult(_c: FakeChild, _r: Result, _t: Task, _ctx: RunContext): Promise<Verdict> {
    const v = this.resultVerdicts.shift();
    if (!v) throw new Error('no resultVerdict queued');
    return v;
  }

  async plan(_t: Task, _ctx: RunContext): Promise<Plan> {
    this.selfPlans++;
    return makePlan({ reasoning: 'parent', proposedAction: 'self', expectedOutput: 'o' });
  }

  async execute(_t: Task, _p: Plan, _ctx: RunContext): Promise<Result> {
    this.selfExecs++;
    return {
      output: 'parent-output',
      summary: 'self-exec',
      trace: [],
      producedBy: { tier: this.tier, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }
}

function makeHooks(
  opts?: Partial<SupervisionHooks<FakeChild>>
): SupervisionHooks<FakeChild> & { branchCalls: number; appliedCount: number } {
  const state = { branchCalls: 0, appliedCount: 0 };
  return {
    applyByScope:
      opts?.applyByScope ??
      (async (child, _v) => {
        state.appliedCount++;
        return child;
      }),
    branchOnEscalation:
      opts?.branchOnEscalation ??
      (async (_c, _t, _r) => {
        state.branchCalls++;
      }),
    ...state,
  };
}

describe('superviseLoop', () => {
  it('completes when plan then result are approved', async () => {
    const parent = new FakeParent();
    const child = new FakeChild('A');
    parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
    parent.queueResultVerdict({ approved: true, reasoning: 'ok' });

    const hooks = makeHooks();
    const ctx = makeCtx();

    const result = await superviseLoop(parent, child, { description: 'go' }, ctx, hooks);
    expect(result.output).toBe('A:output');
    expect(child.planCount).toBe(1);
    expect(child.execCount).toBe(1);
  });

  it('rejects plan, applies ephemeral mods, loops, then succeeds', async () => {
    const parent = new FakeParent();
    const child = new FakeChild('A');
    let appliedCount = 0;

    parent.queuePlanVerdict({
      approved: false,
      reasoning: 'needs more detail',
      modifications: { systemPromptAppend: 'try harder' },
      scope: 'ephemeral',
    });
    parent.queuePlanVerdict({ approved: true, reasoning: 'ok now' });
    parent.queueResultVerdict({ approved: true, reasoning: 'good' });

    const hooks: SupervisionHooks<FakeChild> = {
      applyByScope: async (c, _v) => {
        appliedCount++;
        return c;
      },
      branchOnEscalation: async () => {},
    };

    const result = await superviseLoop(parent, child, { description: 'go' }, makeCtx(), hooks);
    expect(child.planCount).toBe(2);
    expect(child.execCount).toBe(1);
    expect(appliedCount).toBe(1);
    expect(result.output).toBe('A:output');
  });

  it('escalates when maxPlanIterations is exhausted, parent self-execs, branch is created', async () => {
    const parent = new FakeParent();
    const child = new FakeChild('A');

    // queue 3 rejections for the 3 allowed plan iterations
    for (let i = 0; i < 3; i++) {
      parent.queuePlanVerdict({
        approved: false,
        reasoning: 'still no good',
        modifications: { systemPromptAppend: 'try' },
        scope: 'ephemeral',
      });
    }

    let branched = 0;
    let traceLength = 0;
    const hooks: SupervisionHooks<FakeChild> = {
      applyByScope: async (c) => c,
      branchOnEscalation: async (_c, trace, _r) => {
        branched++;
        traceLength = trace.length;
      },
    };

    const ctx = makeCtx({ limits: { maxPlanIterations: 3, maxExecIterations: 3 } });
    const result = await superviseLoop(parent, child, { description: 'go' }, ctx, hooks);

    expect(branched).toBe(1);
    expect(traceLength).toBeGreaterThan(0);
    expect(parent.selfPlans).toBe(1);
    expect(parent.selfExecs).toBe(1);
    expect(result.producedBy.viaFallback).toBe(true);
    expect(result.output).toBe('parent-output');
  });

  describe('an unparseable plan reply (run 12bdcf19, 2026-10-15)', () => {
    // The production reply: raw newlines AND unescaped quotes inside the
    // "reasoning" string. json.ts cannot repair it without guessing, and the
    // ValidationError used to leave the loop and end the whole run.
    const BROKEN = '```json\n{\n  "reasoning": "Plan:\n\n(d) Remove all \\"409 || 400\\" disjunctions.\n- Search and remove all "409 || 400" disjunctions.\n",\n  "proposedAction": "1. Read the tests.",\n  "expectedOutput": "green"\n}\n```'.replace(/\\\\"/g, '"');
    const GOOD = JSON.stringify({ reasoning: 'r', proposedAction: 'read then edit', expectedOutput: 'green' });

    class RealPlanL1 extends L1Atom {
      execCount = 0;
      override async execute(): Promise<Result> {
        this.execCount++;
        return { output: 'child-output', summary: 's', trace: [], producedBy: { tier: this.tier, name: this.name, viaFallback: false } };
      }
    }
    const makeChild = (): RealPlanL1 => new RealPlanL1({ name: 'Urea', ordinal: 1, systemPrompt: 's', tools: [], params: {} });
    const approve: Verdict = { approved: true, reasoning: 'ok' };

    it('asks the real L1 plan again, records the parser message, and neither blames nor branches', async () => {
      const ctx = makeCtx();
      ctx.llm.enqueueText(BROKEN);
      ctx.llm.enqueueText(GOOD);
      const parent = new FakeParent();
      parent.queuePlanVerdict(approve);
      parent.queueResultVerdict(approve);
      const child = makeChild();
      let branched = 0;
      let failed = 0;
      const hooks = {
        applyByScope: async (c: RealPlanL1) => c,
        branchOnEscalation: async () => { branched++; },
        onFailed: async () => { failed++; },
      };
      const result = await superviseLoop(parent as never, child as never, { description: 'go' }, ctx, hooks as never);
      expect(result.output).toBe('child-output');
      expect(result.producedBy.viaFallback).toBe(false);
      expect(branched).toBe(0);
      expect(failed).toBe(0);
      const unparseable = result.trace.filter((t) => t.kind === 'plan-unparseable');
      expect(unparseable).toHaveLength(1);
      expect(String((unparseable[0]!.payload as { error: string }).error)).toMatch(/JSON parse failed/);
    });

    // Group D, review 2026-10-16: an L2 plan pair threw SyntaxError or
    // ZodError, which the loop's ValidationError retry did not cover.
    it('asks a real L2 cell again after an unparseable plan pair', async () => {
      const db = openDb(':memory:');
      const registry = new AtomRegistry(db);
      const type = registry.create(2, { description: 'cell', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' });
      const cell = L2Atom.fromType(type, registry);
      let strategyAtExecute: unknown;
      cell.execute = async function (this: L2Atom) {
        strategyAtExecute = (this as unknown as { pendingStrategy: unknown }).pendingStrategy;
        return { output: 'cell-output', summary: 's', trace: [], producedBy: { tier: this.tier, name: this.name, viaFallback: false } };
      };
      const plan = { reasoning: 'r', subtasks: [{ description: 'Implement', acceptanceTests: { requirement: 'digits', cwd: '.',
        source: "import { test, expect } from 'vitest';\ntest('d', () => expect('4').toMatch(/\\d/));" } }], aggregation: { mode: 'sequential' }, expectedOutput: 'o' };
      const good = JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'parsed' }, plan]);
      const bad = JSON.stringify([{ strategy: 'create', reasoning: 'broken' }, plan]).replace('\\\\d', '\\d');
      expect(bad).not.toContain('\\\\d');
      const ctx = makeCtx();
      ctx.llm.enqueueText(bad);
      ctx.llm.enqueueText(good);
      const parent = new FakeParent();
      parent.queuePlanVerdict(approve);
      parent.queueResultVerdict(approve);
      const hooks = { applyByScope: async (c: L2Atom) => c, branchOnEscalation: async () => { throw new Error('must not escalate'); } };
      const result = await superviseLoop(parent as never, cell as never, { description: 'go' }, ctx, hooks as never);
      db.close();
      expect(result.output).toBe('cell-output');
      const unparseable = result.trace.filter((t) => t.kind === 'plan-unparseable');
      expect(unparseable).toHaveLength(1);
      expect(String((unparseable[0]!.payload as { error: string }).error)).toMatch(/plan reply unparseable: Bad escaped character/);
      expect(strategyAtExecute).toMatchObject({ strategy: 'reuse', target: 'Urea' });
    });

    // Second review 2026-10-16: the retry's plan overwrites whatever a failed
    // reply left, so only a check right after the failing call can see a leak.
    it('leaves the previous strategy in place when a reply\'s strategy parses and its plan does not', async () => {
      const db = openDb(':memory:');
      const registry = new AtomRegistry(db);
      const type = registry.create(2, { description: 'cell', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' });
      const cell = L2Atom.fromType(type, registry);
      const pending = () => (cell as unknown as { pendingStrategy: unknown }).pendingStrategy;
      const plan = { reasoning: 'r', subtasks: [{ description: 'Implement' }], aggregation: { mode: 'sequential' }, expectedOutput: 'o' };
      const ctx = makeCtx();
      ctx.llm.enqueueText(JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'parsed' }, plan]));
      ctx.llm.enqueueText(JSON.stringify([{ strategy: 'create', reasoning: 'its plan is broken' }, { ...plan, aggregation: { mode: 'bogus' } }]));
      try {
        await cell.plan({ description: 'go' }, ctx);
        expect(pending()).toMatchObject({ strategy: 'reuse', target: 'Urea' });
        await expect(cell.plan({ description: 'go' }, ctx)).rejects.toBeInstanceOf(PlanParseError);
        expect(pending()).toMatchObject({ strategy: 'reuse', target: 'Urea' });
      } finally {
        db.close();
      }
    });

    // Group G4, 2026-10-16: a cut L2 reply used to be asked again blind; the
    // feedback now reaches the next strategy prompt only, never the prefilter
    // (whose cache key hashes constraints) nor the task review and execution see.
    it('tells a real L2 cell why its cut reply was refused, on the planner channel only', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'atoma-g4-feedback-'));
      const cacheBefore = process.env['ATOMA_PREFILTER_CACHE'];
      process.env['ATOMA_PREFILTER_CACHE'] = join(dir, 'cache.db');
      resetPrefilterCacheForTests();
      const db = openDb(':memory:');
      try {
        const registry = new AtomRegistry(db);
        const seed = { description: 'module author', systemPrompt: 'write modules', tools: [], params: {}, createdBy: 'test' };
        registry.create(1, seed);
        const type = registry.create(2, { ...seed, description: 'cell', systemPrompt: 'delegate' });
        const cell = L2Atom.fromType(type, registry);
        cell.execute = async function (this: L2Atom) {
          return { output: 'cell-output', summary: 's', trace: [], producedBy: { tier: this.tier, name: this.name, viaFallback: false } };
        };
        const plan = { reasoning: 'r', subtasks: [{ description: 'Implement' }], aggregation: { mode: 'sequential' }, expectedOutput: 'o' };
        const good = JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'parsed' }, plan]);
        const cut = good.slice(0, good.indexOf('"aggregation"'));
        const plans = [{ text: cut, stopReason: 'max_tokens' }, { text: good, stopReason: 'end_turn' }];
        const ctx = makeCtx();
        const route = (req: LlmCompletionRequest): LlmCompletionResponse => {
          const next = req.role === 'prefilter'
            ? { text: JSON.stringify({ kind: 'escalate', reasoning: 'no molecule fits' }), stopReason: 'end_turn' }
            : req.role === 'plan' ? plans.shift() : undefined;
          if (!next) throw new Error(`Unexpected ${req.role} call`);
          return { ...next, usage: { inputTokens: 10, outputTokens: 10 } };
        };
        for (let i = 0; i < 6; i++) ctx.llm.enqueue(route);
        const task: Task = { description: 'go', constraints: ['keep the public API'] };
        const reviewed: Task[] = [];
        const parent = new FakeParent();
        parent.validatePlan = async (_c, _p, seen) => {
          reviewed.push(seen);
          return approve;
        };
        parent.queueResultVerdict(approve);
        const hooks = { applyByScope: async (c: L2Atom) => c, branchOnEscalation: async () => { throw new Error('must not escalate'); } };
        const result = await superviseLoop(parent as never, cell as never, task, ctx, hooks as never);
        expect(result.output).toBe('cell-output');
        const strategyPrompts = ctx.llm.calls.filter(call => call.role === 'plan');
        expect(strategyPrompts).toHaveLength(2);
        expect(strategyPrompts[0]?.userContent).not.toContain('PREVIOUS PLAN ATTEMPT:');
        expect(strategyPrompts[1]?.userContent).toContain('PREVIOUS PLAN ATTEMPT:');
        expect(strategyPrompts[1]?.userContent).toContain('plan reply hit the plan output cap and was cut');
        // One prefilter call: the retry was served from the cache under an unchanged key.
        const prefilters = ctx.llm.calls.filter(call => call.role === 'prefilter');
        expect(prefilters).toHaveLength(1);
        expect(prefilters[0]?.userContent).not.toContain('output cap');
        expect(reviewed).toHaveLength(1);
        expect(reviewed[0]?.constraints).toEqual(['keep the public API']);
        const unparseable = result.trace.filter((t) => t.kind === 'plan-unparseable');
        expect(unparseable).toHaveLength(1);
        expect(unparseable[0]?.payload).toMatchObject({ cause: 'truncated' });
        expect(result.trace.some((t) => t.kind === 'escalated')).toBe(false);
      } finally {
        db.close();
        if (cacheBefore === undefined) delete process.env['ATOMA_PREFILTER_CACHE'];
        else process.env['ATOMA_PREFILTER_CACHE'] = cacheBefore;
        resetPrefilterCacheForTests();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('asks an L1 again after its own ValidationError without planner feedback', async () => {
      const ctx = makeCtx();
      ctx.llm.enqueueText(BROKEN);
      ctx.llm.enqueueText(GOOD);
      const parent = new FakeParent();
      parent.queuePlanVerdict(approve);
      parent.queueResultVerdict(approve);
      const child = makeChild();
      const plan = vi.spyOn(child, 'plan');
      const hooks = { applyByScope: async (c: RealPlanL1) => c, branchOnEscalation: async () => {} };
      await superviseLoop(parent as never, child as never, { description: 'go' }, ctx, hooks as never);
      // The loop's third argument, past L1's own two-parameter signature.
      const feedbacks = plan.mock.calls.map(call => (call as unknown[])[2]);
      expect(feedbacks).toEqual([[], []]);
    });

    // Third review 2026-10-16: nothing judged the child, so the spent budget
    // records no trust failure and branches no type (AGENTS: "Never blames trust").
    it('hands the task to the parent once the plan budget is spent on unparseable replies, blaming and branching nothing', async () => {
      const ctx = makeCtx();
      for (let i = 0; i < ctx.limits.maxPlanIterations; i++) ctx.llm.enqueueText(BROKEN);
      const parent = new FakeParent();
      let branched = 0;
      let failed = 0;
      const hooks = { applyByScope: async (c: RealPlanL1) => c, branchOnEscalation: async () => { branched++; }, onFailed: async () => { failed++; } };
      const result = await superviseLoop(parent as never, makeChild() as never, { description: 'go' }, ctx, hooks as never);
      expect(branched).toBe(0);
      expect(failed).toBe(0);
      expect(result.producedBy.viaFallback).toBe(true);
      expect(result.output).toBe('parent-output');
      expect(result.trace.find(t => t.kind === 'escalated')?.payload).toMatchObject({ phase: 'plan', blameless: true });
    });

    it('still blames and branches when a plan was refused on its merits before the replies stopped parsing', async () => {
      const ctx = makeCtx();
      ctx.llm.enqueueText(GOOD);
      ctx.llm.enqueueText(BROKEN);
      ctx.llm.enqueueText(BROKEN);
      const parent = new FakeParent();
      parent.queuePlanVerdict({ approved: false, reasoning: 'names no outputs', scope: 'ephemeral', modifications: {} });
      let branched = 0;
      let failed = 0;
      const hooks = { applyByScope: async (c: RealPlanL1) => c, branchOnEscalation: async () => { branched++; }, onFailed: async () => { failed++; } };
      const result = await superviseLoop(parent as never, makeChild() as never, { description: 'go' }, ctx, hooks as never);
      expect(failed).toBe(1);
      expect(branched).toBe(1);
      expect(result.producedBy.viaFallback).toBe(true);
    });
  });

  it('a non-validation plan failure still ends the loop', async () => {
    const parent = new FakeParent();
    class BrokenChild extends FakeChild {
      override async plan(): Promise<Plan> { throw new Error('transport down'); }
    }
    await expect(superviseLoop(parent, new BrokenChild('A'), { description: 'go' }, makeCtx(), makeHooks())).rejects.toThrow(/transport down/);
  });

  it('escalates when maxExecIterations is exhausted on result rejections', async () => {
    const parent = new FakeParent();
    const child = new FakeChild('A');

    // each cycle: plan approved, result rejected, back to plan
    for (let i = 0; i < 2; i++) {
      parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
      parent.queueResultVerdict({
        approved: false,
        reasoning: 'bad result',
        modifications: { systemPromptAppend: 'do better' },
        scope: 'ephemeral',
      });
    }
    // third cycle: plan approved, then we hit execIter limit
    parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });

    let branched = 0;
    const hooks: SupervisionHooks<FakeChild> = {
      applyByScope: async (c) => c,
      branchOnEscalation: async () => {
        branched++;
      },
    };

    const ctx = makeCtx({ limits: { maxPlanIterations: 10, maxExecIterations: 2 } });
    const result = await superviseLoop(parent, child, { description: 'go' }, ctx, hooks);

    expect(branched).toBe(1);
    expect(result.producedBy.viaFallback).toBe(true);
  });

  it('fallbackMode flag is lowered after escalation completes', async () => {
    const parent = new FakeParent();
    const child = new FakeChild('A');

    // force escalation immediately (maxPlanIterations=0 → throws on first check)
    const ctx = makeCtx({ limits: { maxPlanIterations: 0, maxExecIterations: 0 } });
    const hooks: SupervisionHooks<FakeChild> = {
      applyByScope: async (c) => c,
      branchOnEscalation: async () => {},
    };

    expect(parent.isFallbackMode()).toBe(false);
    await superviseLoop(parent, child, { description: 'go' }, ctx, hooks);
    expect(parent.isFallbackMode()).toBe(false);
  });

  describe('repeat-rejection short-circuit', () => {
    it('escalates after N consecutive plan rejects with the same normalized reasoning', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      for (let i = 0; i < MAX_SAME_REASON_REJECTS; i++) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning: 'needs more detail — it really does',
          modifications: { systemPromptAppend: 'try harder' },
          scope: 'ephemeral',
        });
      }
      let branched = 0;
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          branched++;
        },
      };
      // Give a generous iteration budget so the early short-circuit is the
      // only path that can end the loop.
      const ctx = makeCtx({
        limits: { maxPlanIterations: 20, maxExecIterations: 20 },
      });
      const result = await superviseLoop(
        parent,
        child,
        { description: 'go' },
        ctx,
        hooks
      );
      // Should have escalated on the Nth identical reject, NOT eaten the
      // full maxPlanIterations budget.
      expect(child.planCount).toBe(MAX_SAME_REASON_REJECTS);
      expect(branched).toBe(1);
      expect(result.producedBy.viaFallback).toBe(true);
    });

    it('treats surface-level punctuation / casing differences as the same reasoning', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      const variants = [
        'Needs more detail.',
        'NEEDS MORE DETAIL!',
        'needs   more detail...',
      ];
      for (const reasoning of variants) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning,
          modifications: { systemPromptAppend: 'try' },
          scope: 'ephemeral',
        });
      }
      let branched = 0;
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          branched++;
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 20, maxExecIterations: 20 },
      });
      await superviseLoop(parent, child, { description: 'go' }, ctx, hooks);
      expect(child.planCount).toBe(3);
      expect(branched).toBe(1);
    });

    it('does NOT short-circuit when reasoning genuinely varies between rejects', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      const reasonings = [
        'missing a step',
        'wrong tool choice',
        'needs more specificity',
        'ok now',
      ];
      for (const r of reasonings.slice(0, 3)) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning: r,
          modifications: { systemPromptAppend: 'try' },
          scope: 'ephemeral',
        });
      }
      parent.queuePlanVerdict({ approved: true, reasoning: reasonings[3]! });
      parent.queueResultVerdict({ approved: true, reasoning: 'ok' });
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          throw new Error('should not have escalated');
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 10, maxExecIterations: 10 },
      });
      const result = await superviseLoop(
        parent,
        child,
        { description: 'go' },
        ctx,
        hooks
      );
      expect(result.producedBy.viaFallback).toBe(false);
    });

    it('an approved plan resets the repeat counter, letting later rejects accumulate fresh', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      // Two identical rejects, then approval → counter resets →
      // we can tolerate another full window of new identical rejects.
      const rej = (r: string): Verdict => ({
        approved: false,
        reasoning: r,
        modifications: { systemPromptAppend: 'try' },
        scope: 'ephemeral',
      });
      parent.queuePlanVerdict(rej('same gripe'));
      parent.queuePlanVerdict(rej('same gripe'));
      parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
      parent.queueResultVerdict(rej('r-bad'));
      parent.queuePlanVerdict(rej('same gripe'));
      parent.queuePlanVerdict(rej('same gripe'));
      parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
      parent.queueResultVerdict({ approved: true, reasoning: 'great' });
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          throw new Error('must not escalate');
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 20, maxExecIterations: 20 },
      });
      const result = await superviseLoop(
        parent,
        child,
        { description: 'go' },
        ctx,
        hooks
      );
      expect(result.producedBy.viaFallback).toBe(false);
    });

    it('same-gripe streak on RESULT also triggers short-circuit', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      for (let i = 0; i < MAX_SAME_REASON_REJECTS; i++) {
        parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
        parent.queueResultVerdict({
          approved: false,
          reasoning: 'deliverable missing the URL',
          modifications: { systemPromptAppend: 'add url' },
          scope: 'ephemeral',
        });
      }
      let branched = 0;
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          branched++;
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 20, maxExecIterations: 20 },
      });
      const result = await superviseLoop(
        parent,
        child,
        { description: 'go' },
        ctx,
        hooks
      );
      expect(child.execCount).toBe(MAX_SAME_REASON_REJECTS);
      expect(branched).toBe(1);
      expect(result.producedBy.viaFallback).toBe(true);
    });

    it('normalizeReason collapses punctuation, casing, and whitespace to a stable key', () => {
      expect(normalizeReason('Foo, BAR!')).toBe(normalizeReason('foo bar'));
      expect(normalizeReason('  foo\n\t bar  ')).toBe('foo bar');
      expect(normalizeReason('Résumé — OK.')).toBe('résumé ok');
      expect(normalizeReason('')).toBe('');
    });
  });

  describe('policy-marker repeat detection', () => {
    it('detectPolicyMarker picks up VISIBLE-DELIVERABLES regardless of punctuation / casing', () => {
      expect(detectPolicyMarker('The VISIBLE-DELIVERABLES checklist is incomplete.')).toBe(
        'visible-deliverables'
      );
      expect(detectPolicyMarker('visible deliverables are missing')).toBe('visible-deliverables');
      expect(detectPolicyMarker('something else entirely')).toBeNull();
    });

    it('groups all "no evidence" / "no ground-truth" phrasings under one canonical marker', () => {
      // Real reasonings from the LoL-SSR run: rotating specifics, same
      // meta-complaint. They must all collapse to the same marker id so
      // makeMarkerTracker treats them as a streak.
      const phrasings = [
        'RESULT claims 172 champions but provides no ground-truth evidence (validate_html output, fetch_url body)',
        'RESULT claims success but provides no ground-truth evidence. The child reports 200 but the task requires fetch_url body confirmation',
        'RESULT claims success but provides no evidence. Self-reported summary is unverifiable.',
      ];
      const ids = phrasings.map(detectPolicyMarker);
      expect(ids.every((id) => id === 'ground-truth-evidence')).toBe(true);
    });

    it('escalates on three rotating ground-truth-evidence rejections (LoL-SSR run regression)', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      // Phase-1 result rejects from the actual run, paraphrased to
      // exercise the synonym set: "no ground-truth evidence", "no
      // ground-truth", "provides no evidence". The verbatim tracker
      // can't see these as a streak; the marker tracker must.
      // We queue them as plan verdicts (FakeParent's plan-verdict path
      // is what the existing tests exercise) — same code path.
      const rotating = [
        'RESULT claims 172 champions fetched but provides no ground-truth evidence',
        'RESULT claims success but the task explicitly requires fetch_url body — no ground-truth shown',
        'RESULT claims completion but provides no evidence of the helper SQL queries',
      ];
      for (const r of rotating) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning: r,
          modifications: { systemPromptAppend: 'x' },
          scope: 'ephemeral',
        });
      }
      let branched = 0;
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          branched++;
        },
      };
      const ctx = makeCtx({ limits: { maxPlanIterations: 20, maxExecIterations: 20 } });
      const result = await superviseLoop(parent, child, { description: 'go' }, ctx, hooks);
      expect(child.planCount).toBe(MAX_SAME_MARKER_REJECTS);
      expect(branched).toBe(1);
      expect(result.producedBy.viaFallback).toBe(true);
    });

    it('escalates when the same policy marker recurs in N consecutive rejections — even if the surrounding prose differs', async () => {
      // This is the real-world failure mode post-mortem from the dashboard
      // run: five plan rejections, each one carrying a DIFFERENT specific
      // complaint but all anchored on the same "VISIBLE-DELIVERABLES"
      // category. The verbatim-equality tracker couldn't see those as
      // repeats; the marker tracker must.
      const parent = new FakeParent();
      const child = new FakeChild('A');
      const rotatingComplaints = [
        'VISIBLE-DELIVERABLES: missing FPS numeric readout format',
        'VISIBLE-DELIVERABLES: axis labels on FPS graph unspecified',
        'VISIBLE-DELIVERABLES: timestamp format for keystrokes not stated',
        'VISIBLE-DELIVERABLES: mouse delta display affordance absent',
      ];
      for (const r of rotatingComplaints) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning: r,
          modifications: { systemPromptAppend: 'x' },
          scope: 'ephemeral',
        });
      }
      let branched = 0;
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          branched++;
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 20, maxExecIterations: 20 },
      });
      const result = await superviseLoop(
        parent,
        child,
        { description: 'go' },
        ctx,
        hooks
      );
      // Should have escalated on the Nth marker repeat, NOT eaten the
      // full iter budget and NOT waited for a verbatim reasoning repeat.
      expect(child.planCount).toBe(MAX_SAME_MARKER_REJECTS);
      expect(branched).toBe(1);
      expect(result.producedBy.viaFallback).toBe(true);
    });

    it('does NOT escalate when marker rejections are interleaved with approvals', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      // One marker reject, plan approved, result approved → marker streak
      // must reset when the plan passes.
      parent.queuePlanVerdict({
        approved: false,
        reasoning: 'VISIBLE-DELIVERABLES: tweak #1',
        modifications: { systemPromptAppend: 'x' },
        scope: 'ephemeral',
      });
      parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
      parent.queueResultVerdict({ approved: true, reasoning: 'great' });
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          throw new Error('must not escalate');
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 20, maxExecIterations: 20 },
      });
      const result = await superviseLoop(
        parent,
        child,
        { description: 'go' },
        ctx,
        hooks
      );
      expect(result.producedBy.viaFallback).toBe(false);
    });
  });

  describe('branch-retry on escalation', () => {
    it('caps tissue-supervised cell replanning across a type branch when no execution opens', async () => {
      const parent = new FakeParent(3);
      const original = new FakeChild('orig', 2);
      const replacement = new FakeChild('branched', 2);
      for (let i = 0; i < MAX_SAME_REASON_REJECTS; i++) {
        parent.queuePlanVerdict({ approved: false, reasoning: 'same dead end', modifications: {}, scope: 'ephemeral' });
      }
      parent.queuePlanVerdict({ approved: false, reasoning: 'a different dead end', modifications: {}, scope: 'ephemeral' });
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async c => c,
        branchOnEscalation: async () => replacement,
      };

      const result = await superviseLoop(parent, original, { description: 'go' }, makeCtx(), hooks);

      expect(original.planCount + replacement.planCount).toBe(makeCtx().limits.maxPlanIterations + 1);
      expect(original.execCount + replacement.execCount).toBe(0);
      expect(result.producedBy.viaFallback).toBe(true);
    });

    it('allows the branched child to execute at the no-progress boundary', async () => {
      const parent = new FakeParent(3);
      const original = new FakeChild('orig', 2);
      const replacement = new FakeChild('branched', 2);
      for (let i = 0; i < MAX_SAME_REASON_REJECTS; i++) {
        parent.queuePlanVerdict({ approved: false, reasoning: 'same dead end', modifications: {}, scope: 'ephemeral' });
      }
      parent.queuePlanVerdict({ approved: true, reasoning: 'executable now' });
      parent.queueResultVerdict({ approved: true, reasoning: 'done' });
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async c => c,
        branchOnEscalation: async () => replacement,
      };

      const result = await superviseLoop(parent, original, { description: 'go' }, makeCtx(), hooks);

      expect(original.planCount + replacement.planCount).toBe(makeCtx().limits.maxPlanIterations + 1);
      expect(replacement.execCount).toBe(1);
      expect(result.producedBy.viaFallback).toBe(false);
    });

    it.each([1, 3, 5, 20])('reserves a replacement review with a configured plan budget of %i', async budget => {
      const parent = new FakeParent(3);
      const original = new FakeChild('orig', 2);
      const replacement = new FakeChild('branched', 2);
      for (let i = 0; i < budget; i++) {
        parent.queuePlanVerdict({ approved: false, reasoning: `distinct refusal ${i}`, modifications: {}, scope: 'ephemeral' });
      }
      parent.queuePlanVerdict({ approved: true, reasoning: 'recovered' });
      parent.queueResultVerdict({ approved: true, reasoning: 'done' });
      const result = await superviseLoop(parent, original, { description: 'go' },
        makeCtx({ limits: { maxPlanIterations: budget, maxExecIterations: 5 } }),
        { applyByScope: async c => c, branchOnEscalation: async () => replacement });
      expect(original.planCount).toBe(budget);
      expect(replacement.planCount).toBe(1);
      expect(replacement.execCount).toBe(1);
      expect(result.producedBy.viaFallback).toBe(false);
    });

    it.each(['original', 'replacement'])('does not spend the cross-branch budget on a %s reviewer fault', async faultAt => {
      const parent = new FakeParent(3);
      const original = new FakeChild('orig', 2);
      const replacement = new FakeChild('branched', 2);
      const fault: Verdict = { approved: false, reasoning: 'review failed', delegationRefusal: 'reviewer', modifications: {}, scope: 'ephemeral' };
      if (faultAt === 'original') parent.queuePlanVerdict(fault);
      for (let i = 0; i < 3; i++) {
        parent.queuePlanVerdict({ approved: false, reasoning: 'same dead end', modifications: {}, scope: 'ephemeral' });
      }
      if (faultAt === 'replacement') parent.queuePlanVerdict(fault);
      parent.queuePlanVerdict({ approved: true, reasoning: 'recovered' });
      parent.queueResultVerdict({ approved: true, reasoning: 'done' });
      const onFailed = vi.fn();
      const result = await superviseLoop(parent, original, { description: 'go' }, makeCtx(),
        { applyByScope: async c => c, branchOnEscalation: async () => replacement, onFailed });
      expect(original.planCount + replacement.planCount).toBe(5);
      expect(replacement.execCount).toBe(1);
      expect(onFailed).toHaveBeenCalledTimes(1);
      expect(result.producedBy.viaFallback).toBe(false);
    });

    it('resets the cross-branch budget when execution starts', async () => {
      const parent = new FakeParent(3);
      const original = new FakeChild('orig', 2);
      const replacement = new FakeChild('branched', 2);
      for (let cycle = 0; cycle < 2; cycle++) {
        for (let i = 0; i < 2; i++) {
          parent.queuePlanVerdict({ approved: false, reasoning: `refusal ${i}`, modifications: {}, scope: 'ephemeral' });
        }
        parent.queuePlanVerdict({ approved: true, reasoning: 'execute' });
      }
      parent.queueResultVerdict({ approved: false, reasoning: 'needs repair', modifications: {}, scope: 'ephemeral' });
      parent.queueResultVerdict({ approved: true, reasoning: 'done' });
      const result = await superviseLoop(parent, original, { description: 'go' }, makeCtx(),
        { applyByScope: async c => c, branchOnEscalation: async () => replacement });
      expect(original.planCount).toBe(3);
      expect(replacement.planCount).toBe(3);
      expect(original.execCount).toBe(1);
      expect(replacement.execCount).toBe(1);
      expect(result.producedBy.viaFallback).toBe(false);
    });

    it('installs a branched child returned by branchOnEscalation and runs one more cycle before parent fallback', async () => {
      const parent = new FakeParent();
      const original = new FakeChild('orig');
      const replacement = new FakeChild('branched');

      // First pass: three identical plan rejects → escalate via repeat.
      for (let i = 0; i < MAX_SAME_REASON_REJECTS; i++) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning: 'same gripe exactly',
          modifications: { systemPromptAppend: 'x' },
          scope: 'ephemeral',
        });
      }
      // Second pass on the replacement: plan+result both approved.
      parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
      parent.queueResultVerdict({ approved: true, reasoning: 'great' });

      let branchCalls = 0;
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          branchCalls++;
          return replacement;
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 10, maxExecIterations: 10 },
      });
      const result = await superviseLoop(
        parent,
        original,
        { description: 'go' },
        ctx,
        hooks
      );

      expect(branchCalls).toBe(1);
      expect(original.planCount).toBe(MAX_SAME_REASON_REJECTS);
      expect(replacement.planCount).toBe(1);
      expect(replacement.execCount).toBe(1);
      // Solved via the branched child, NOT via the parent fallback.
      expect(result.producedBy.viaFallback).toBe(false);
      expect(result.output).toBe('branched:output');
      expect(parent.selfPlans).toBe(0);
      expect(parent.selfExecs).toBe(0);
    });

    it('falls back to parent when the branched child ALSO escalates (only one retry)', async () => {
      const parent = new FakeParent();
      const original = new FakeChild('orig');
      const replacement = new FakeChild('branched');

      // First cycle: 3 identical rejects → escalate.
      for (let i = 0; i < MAX_SAME_REASON_REJECTS; i++) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning: 'same gripe exactly',
          modifications: { systemPromptAppend: 'x' },
          scope: 'ephemeral',
        });
      }
      // Second cycle on replacement: 3 identical rejects again → escalate.
      for (let i = 0; i < MAX_SAME_REASON_REJECTS; i++) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning: 'still the same gripe',
          modifications: { systemPromptAppend: 'x' },
          scope: 'ephemeral',
        });
      }

      let branchCalls = 0;
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          branchCalls++;
          // Return the replacement ONCE; on subsequent calls still return
          // it — the loop guard is what prevents the second retry, not
          // the hook itself. This asserts that contract holds.
          return replacement;
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 10, maxExecIterations: 10 },
      });
      const result = await superviseLoop(
        parent,
        original,
        { description: 'go' },
        ctx,
        hooks
      );

      // branchOnEscalation was called on BOTH escalations (original and
      // replacement), but the loop only honoured the first replacement —
      // the second escalation falls through to the parent fallback.
      expect(branchCalls).toBe(2);
      expect(original.planCount).toBe(MAX_SAME_REASON_REJECTS);
      expect(replacement.planCount).toBe(MAX_SAME_REASON_REJECTS);
      expect(parent.selfPlans).toBe(1);
      expect(parent.selfExecs).toBe(1);
      expect(result.producedBy.viaFallback).toBe(true);
    });

    it('falls back to parent when branchOnEscalation returns void (void hook contract preserved)', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      for (let i = 0; i < MAX_SAME_REASON_REJECTS; i++) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning: 'same gripe exactly',
          modifications: { systemPromptAppend: 'x' },
          scope: 'ephemeral',
        });
      }
      let branchCalls = 0;
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          branchCalls++;
          // Returning undefined (void) keeps pre-branch-retry behaviour:
          // register the lesson, then go straight to parent fallback.
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 10, maxExecIterations: 10 },
      });
      const result = await superviseLoop(
        parent,
        child,
        { description: 'go' },
        ctx,
        hooks
      );
      expect(branchCalls).toBe(1);
      expect(parent.selfPlans).toBe(1);
      expect(parent.selfExecs).toBe(1);
      expect(result.producedBy.viaFallback).toBe(true);
    });
  });
});
