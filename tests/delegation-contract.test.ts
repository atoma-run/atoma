import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { enforceDelegationReview } from '../src/atoms/delegationReview.js';
import type { RootPhaseCheckpoint } from '../src/contracts/runCheckpoint.js';
import { planSchema } from '../src/atoms/json.js';
import type { Plan, Result } from '../src/core/types.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function actors() {
  const db = openDb(':memory:'); databases.push(db);
  const registry = new AtomRegistry(db);
  const seed = { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' };
  const tissue = registry.create(3, seed), cell = registry.create(2, seed);
  for (let i = 0; i < 10; i++) registry.recordSuccess(cell.name);
  return { tissue: L3Atom.buildWithModel(tissue, registry, 'mock'), cell: L2Atom.fromType(registry.getByName(cell.name)!, registry) };
}
const suite = { requirement: 'signed addition', cwd: '.', source: "import {test,expect} from 'vitest';import {add} from './add.ts';test('signed sums',()=>{expect(add(2,3)).toBe(5);expect(add(-2,1)).toBe(-1)});" };
const result: Result = { output: { exports: ['add(a,b)'] }, summary: 'Observed add export', trace: [], producedBy: { name: 'cell', tier: 2, viaFallback: false } };
function review(kinds: ('vitest' | 'inspection' | 'other')[], independentWork = false, integration: 'vitest' | 'inspection' | 'other' = 'other') {
  return { approved: true, reasoning: 'scope reviewed', delegationReview: {
    subtasks: kinds.map((kind, index) => ({ index, kind, reason: 'actual assigned scope' })),
    integration: { kind: integration, reason: 'integration scope' }, independentWork, parallelReason: 'actual dependency analysis',
  } };
}
const runnable = () => makePlan({ subtasks: [{ description: 'Implement signed addition', outputs: ['add.ts'], acceptanceTests: suite }] });

describe('mandatory delegation contracts', () => {
  it('blocks the observed deferred-tests migration plan even when a reviewer says approved', async () => {
    const { tissue } = actors(); const ctx = makeCtx();
    const observed = makePlan({ aggregation: { mode: 'sequential' }, subtasks: [
      { description: 'Inspect and obtain parent approval later' },
      { description: 'Migrate all application modules after that review', outputs: ['server.ts', 'ui.ts'] },
      { description: 'Check the built app' },
    ] });
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValue(observed);
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    for (let i = 0; i < 3; i++) ctx.llm.enqueueText(JSON.stringify(review(['inspection', 'vitest', 'other'], true, 'vitest')));
    await expect(tissue.handle({ description: 'Migrate Attica to TypeScript' }, ctx)).rejects.toThrow('Missing parent-owned');
    expect(plan).toHaveBeenCalledTimes(3); expect(execute).not.toHaveBeenCalled();
    expect(ctx.llm.calls.every(c => c.role === 'validate-plan' && !c.tools && !c.executor)).toBe(true);
  });

  it('rejects linear or grouped plans when the review identifies independent work', () => {
    expect(enforceDelegationReview(runnable(), JSON.stringify(review(['vitest'], true)), false)?.approved).toBe(false);
    const chain = makePlan({ subtasks: [{ description: 'A', acceptanceTests: suite }, { description: 'B', acceptanceTests: suite, dependsOn: [0] }] });
    expect(enforceDelegationReview(chain, JSON.stringify(review(['vitest', 'vitest'], true)), false)?.approved).toBe(false);
    const parallel = { ...chain, subtasks: chain.subtasks.map(s => ({ ...s, dependsOn: undefined })) };
    expect(enforceDelegationReview(parallel, JSON.stringify(review(['vitest', 'vitest'], true)), false)).toBeUndefined();
  });

  it('permits a reviewed non-code task and does not invent Vitest requirements', async () => {
    const { tissue } = actors(); const ctx = makeCtx();
    vi.spyOn(tissue, 'plan').mockResolvedValue(makePlan({ subtasks: [{ description: 'Write usage documentation', outputs: ['README.md'] }] }));
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    ctx.llm.enqueueText(JSON.stringify(review(['other'])));
    await expect(tissue.handle({ description: 'Document the existing API' }, ctx)).resolves.toBe(result);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('executes only the repaired plan after rejecting missing tests', async () => {
    const { tissue } = actors(); const ctx = makeCtx();
    vi.spyOn(tissue, 'plan').mockResolvedValueOnce(makePlan({ subtasks: [{ description: 'Implement add' }] })).mockResolvedValueOnce(runnable());
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    ctx.llm.enqueueText(JSON.stringify(review(['vitest']))); ctx.llm.enqueueText(JSON.stringify(review(['vitest'])));
    await tissue.handle({ description: 'Implement signed addition' }, ctx);
    expect(execute).toHaveBeenCalledOnce(); expect(execute.mock.calls[0]?.[1].subtasks[0]?.acceptanceTests).toEqual(suite);
  });

  it('performs read-only discovery then replans from observed interfaces before implementation', async () => {
    const { tissue } = actors(); const ctx = { ...makeCtx(), rootCheckpoint: {
      restore: () => null, completed: [], planned: vi.fn<RootPhaseCheckpoint['planned']>(), beforePhase: vi.fn(), afterPhase: vi.fn(async () => {}), finalizing: vi.fn(),
    } };
    const discovery = planSchema.parse({ ...makePlan({ subtasks: [{ description: 'Inspect exports' }] }), replanAfter: true });
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValueOnce(discovery).mockResolvedValueOnce(runnable());
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    ctx.llm.enqueueText(JSON.stringify(review(['inspection'], false, 'inspection')));
    ctx.llm.enqueueText(JSON.stringify(review(['vitest'])));
    await tissue.handle({ description: 'Migrate the real application' }, ctx);
    expect(execute.mock.calls[0]?.[0].readOnly).toBe(true);
    expect(execute.mock.calls[0]?.[2].rootCheckpoint).toBeUndefined();
    expect(plan.mock.calls[1]?.[0].inputs?.['repositoryDiscovery']).toMatchObject({ summary: result.summary });
    expect(plan.mock.calls[1]?.[0].description).toBe('Migrate the real application');
    expect(execute.mock.calls[1]?.[0].readOnly).toBeUndefined();
    expect(execute.mock.calls[1]?.[1].subtasks[0]?.acceptanceTests).toEqual(suite);
    expect(ctx.rootCheckpoint.planned).toHaveBeenCalledOnce();
    expect(ctx.rootCheckpoint.planned.mock.calls[0]?.[1]).toMatchObject({ subtasks: [{ acceptanceTests: suite }] });
  });

  it('never turns a failed discovery into implementation', async () => {
    const { tissue } = actors(); const ctx = makeCtx();
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValue({ ...makePlan({ subtasks: [{ description: 'inspect' }] }), replanAfter: true });
    vi.spyOn(tissue, 'execute').mockResolvedValue({ ...result, refusal: 'inspection failed' });
    ctx.llm.enqueueText(JSON.stringify(review(['inspection'], false, 'inspection')));
    expect((await tissue.handle({ description: 'Migrate' }, ctx)).refusal).toBe('inspection failed');
    expect(plan).toHaveBeenCalledOnce();
  });

  it('does not accept missing, duplicate or out-of-range classifications', () => {
    const p = runnable();
    for (const r of [{ approved: true }, review([]), review(['vitest', 'vitest']), { ...review(['vitest']), delegationReview: { ...review(['vitest']).delegationReview, subtasks: [{ index: 1, kind: 'vitest', reason: 'wrong' }] } }]) {
      expect(enforceDelegationReview(p, JSON.stringify(r), false)?.approved).toBe(false);
    }
  });

  it('refuses discovery with writes, repeated discovery, and child-authored discovery', () => {
    const discovery: Plan = { ...runnable(), replanAfter: true };
    expect(enforceDelegationReview(discovery, JSON.stringify(review(['inspection'], false, 'inspection')), true)?.approved).toBe(false);
    const clean = { ...discovery, subtasks: [{ description: 'inspect' }] };
    expect(enforceDelegationReview(clean, JSON.stringify(review(['inspection'], false, 'inspection')), false)?.approved).toBe(false);
    expect(enforceDelegationReview(clean, JSON.stringify(review(['vitest'])), true)?.approved).toBe(false);
  });

  it('makes L3 reject a trusted L2 omitting L1 suites before leaf execution', async () => {
    const { tissue, cell } = actors(); const ctx = makeCtx();
    ctx.llm.enqueueText(JSON.stringify(review(['vitest'])));
    const verdict = await tissue.validatePlan(cell, makePlan({ subtasks: [{ description: 'Implement add' }] }), { description: 'add', acceptanceTests: suite }, ctx);
    expect(verdict.approved).toBe(false); expect(verdict.reasoning).toContain('Missing parent-owned');
    expect(ctx.llm.calls).toHaveLength(1);
  });
});
