import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { SkillLifecycle } from '../src/skills/lifecycle.js';
import { asStoredNamespace } from '../src/skills/namespace.js';
import { projectCounters, readLedger, setLedgerScope } from '../src/core/ledger.js';
import { withRecoveryEffects, setRecoveryEffectHandler } from '../src/core/recoveryEffects.js';
import { withheldComputeKnowledge } from '../src/contracts/executionTarget.js';
import { superviseLoop, type SupervisionHooks } from '../src/core/supervisor.js';
import type { RunContext, Result } from '../src/core/types.js';
import { makeCtx, jsonText, saveCompiledScript } from './helpers.js';
import { makePlan } from './helpers/factories.js';

const seed = { description: 'Reusable worker', systemPrompt: 'Do the requested work.', tools: [], params: {}, createdBy: 'test' };
const body = 'STEP 1: inspect. STEP 2: repair. STEP 3: verify.';

describe('Compute observations remain visible without changing shared knowledge', () => {
  let db: ReturnType<typeof openDb>;
  let registry: AtomRegistry;
  let skills: SkillRegistry;
  let directory: string;
  let cell: L2Atom;
  let owner: string;

  beforeEach(() => {
    db = openDb(':memory:');
    registry = new AtomRegistry(db);
    directory = mkdtempSync(join(tmpdir(), 'compute-ledger-'));
    skills = new SkillRegistry(directory, { db });
    const cellType = registry.create(2, seed);
    owner = registry.create(1, seed).atomId;
    skills.save(owner, { id: 'the-recipe', kind: 'llm', description: 'Repair', whenToUse: 'Repair a file', body });
    cell = L2Atom.fromType(cellType, registry, [], skills);
    setLedgerScope({ orgId: 'org', projectId: 'project', runId: 'run', actorType: 'principal', actorId: 'person' });
  });
  afterEach(() => {
    setLedgerScope(null);
    db.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function queueAttempt(ctx: ReturnType<typeof makeCtx>, approved: boolean): void {
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'inspect and repair', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
    ctx.llm.enqueueText(jsonText({ output: approved ? 'done' : 'wrong', summary: approved ? 'ok' : 'nope' }));
    ctx.llm.enqueueText(jsonText(approved ? { approved: true, reasoning: 'ok', activeSkillFollowed: true } :
      { approved: false, reasoning: 'deliverable is wrong', scope: 'ephemeral', activeSkillFollowed: true }));
  }

  it.each(['customer-device', 'hosted'] as const)('journals the actual L2 recovery path on %s', async provenance => {
    const ctx = { ...makeCtx(), executionProvenance: provenance };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'type' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'the-recipe', confidence: 'high', reasoning: 'recipe' }));
    for (let i = 0; i < 3; i++) queueAttempt(ctx, false);
    if (provenance === 'hosted') ctx.llm.enqueueText('STEP 1: revised repair. STEP 2: verify.');
    queueAttempt(ctx, true);

    const result = await cell.handleDirect({ description: 'Repair the file' }, ctx);
    expect(result.summary).toBe('ok');
    const recipe = skills.loadFor(owner)[0]!;
    const events = readLedger(db);
    if (provenance === 'customer-device') {
      expect(registry.getByName('Water')).toMatchObject({ successes: 0, failures: 0, consecutiveSuccesses: 0 });
      expect(recipe).toMatchObject({ body, successes: 0, failures: 0 });
      expect(recipe.directFailures ?? 0).toBe(0);
      expect(ctx.llm.calls.some(call => call.userContent.includes('IMPROVED body'))).toBe(false);
      expect(events.filter(event => event.kind === 'type-credit-withheld').map(event => event.detail?.['operation'])).toEqual(['failure', 'success']);
      expect(events.filter(event => event.kind === 'skill-credit-withheld').map(event => event.detail?.['operation'])).toEqual(['failure', 'revision']);
      expect(events.filter(event => event.kind.endsWith('credit-withheld')).every(event =>
        event.scope?.runId === 'run' && event.detail?.['provenance'] === 'customer-device')).toBe(true);
      expect(projectCounters(events).get(owner)).toEqual({ successes: 0, failures: 0 });
      expect(events.filter(event => event.kind === 'skill-save')).toHaveLength(1);
    } else {
      expect(recipe.failures).toBe(1);
      expect(recipe.body).toContain('revised repair');
      expect(events.some(event => event.kind.endsWith('credit-withheld'))).toBe(false);
      expect(registry.getByName('Water')!.failures).toBe(1);
    }
  });

  it('records an approved recipe under its stable owner, without increasing counters', async () => {
    const ctx = { ...makeCtx(), executionProvenance: 'customer-device' as const };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'type' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'the-recipe', confidence: 'high', reasoning: 'recipe' }));
    queueAttempt(ctx, true);
    await cell.handleDirect({ description: 'Repair the file' }, ctx);
    expect(readLedger(db).find(event => event.kind === 'skill-credit-withheld')).toMatchObject({
      entity: `${owner}/the-recipe`, entityId: `${owner}/the-recipe`,
      detail: { operation: 'success', by: cell.name, via: 'Water' }, scope: { runId: 'run' },
    });
    expect(skills.loadFor(owner)[0]).toMatchObject({ successes: 0, failures: 0 });
  });

  it.each(['customer-device', 'hosted'] as const)('preserves the L3 supervision result and attributes %s outcomes', async provenance => {
    const tissue = L3Atom.buildWithModel(registry.create(3, seed), registry, 'mock');
    const ctx = { ...makeCtx(), executionProvenance: provenance };
    const result: Result = { output: 'done', summary: 'phase done', trace: [], producedBy: { name: cell.name, tier: 2, viaFallback: false } };
    vi.spyOn(cell, 'plan').mockResolvedValue(makePlan());
    vi.spyOn(cell, 'execute').mockResolvedValue(result);
    vi.spyOn(tissue, 'validatePlan').mockResolvedValue({ approved: true, reasoning: 'reviewed' });
    vi.spyOn(tissue, 'validateResult').mockResolvedValue({ approved: true, reasoning: 'reviewed' });
    const hooks = (tissue as unknown as { makeL2Hooks(ctx: RunContext, description: string): SupervisionHooks<L2Atom> }).makeL2Hooks(ctx, 'phase');
    await hooks.onFailed!(cell, 'rejected');
    await superviseLoop(tissue, cell, { description: 'phase' }, ctx, hooks);
    expect(registry.getByName(cell.name)).toMatchObject(provenance === 'customer-device'
      ? { successes: 0, failures: 0 } : { successes: 1, failures: 1 });
    if (provenance === 'customer-device') {
      expect(readLedger(db).filter(event => event.kind === 'type-credit-withheld').map(event => event.detail?.['operation'])).toEqual(['failure', 'success']);
    }
  });

  it('preserves a donor script and its failure streak on Compute contract failure and accepted dispatch', () => {
    saveCompiledScript(skills, owner, { id: 'compiled-repair', description: 'Repair', whenToUse: 'Repair',
      language: 'node', body: 'console.log(JSON.stringify({output:"ok",summary:"ok"}))', fallback: body });
    skills.markDirectFailure(owner, 'compiled-repair');
    const recipe = skills.loadFor(owner).find(skill => skill.id === 'compiled-repair')!;
    const executor = registry.create(1, seed);
    const lifecycle = new SkillLifecycle({ name: cell.name, model: 'mock', params: {},
      toLlmRequest: (_role, args) => ({ ...args, model: 'mock', systemPrompt: 'test' }) }, skills);
    const ctx = { ...makeCtx(), executionProvenance: 'customer-device' as const };
    lifecycle.noteDirectFailure(asStoredNamespace(owner), recipe, ctx, executor);
    lifecycle.commitScriptSkillDirect(recipe, asStoredNamespace(owner), ctx, executor);
    expect(skills.loadFor(owner).find(skill => skill.id === recipe.id)).toMatchObject({
      kind: 'script', body: recipe.body, successes: 0, failures: 0, directFailures: 1,
    });
    const held = readLedger(db).filter(event => event.kind === 'skill-credit-withheld');
    expect(held.map(event => event.detail?.['operation'])).toEqual(['direct-failure', 'success']);
    expect(held.every(event => event.entityId === `${owner}/${recipe.id}` && event.detail?.['via'] === executor.name)).toBe(true);
  });

  it('does not turn a withheld observation into an irreversible checkpoint effect', () => {
    const effect = vi.fn();
    withRecoveryEffects(() => {
      setRecoveryEffectHandler(effect);
      registry.recordWithheld('Water', withheldComputeKnowledge('failure', cell.name));
      skills.recordWithheld(owner, 'the-recipe', withheldComputeKnowledge('revision', cell.name, 'Water'));
    });
    expect(effect).not.toHaveBeenCalled();
    expect(readLedger(db).filter(event => event.kind.endsWith('credit-withheld'))).toHaveLength(2);
  });
});
