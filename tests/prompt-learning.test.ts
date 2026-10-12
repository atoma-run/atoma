import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { consolidatePrompt, deferPromptLearning } from '../src/atoms/promptLearning.js';
import { ensureCanonicalFullStack, ensureCanonicalL1, ensureCanonicalL2 } from '../src/atoms/capability.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import type { AtomLesson } from '../src/contracts/skillLearning.js';
import { withRecoveryEffects, setRecoveryEffectHandler } from '../src/core/recoveryEffects.js';
import { createAttestationLog } from '../src/core/attestation.js';
import { OLLAMA_PINS } from './tier-pins.js';
import { makeCtx } from './helpers.js';
import { makeTools } from './helpers/factories.js';

const seed = { description: 'General execution', systemPrompt: 'Keep the existing protocol.', tools: [], params: {}, createdBy: 'test' };
const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const db of databases.splice(0)) db.close(); });
function fixture(tier: 1 | 2 | 3 = 1) {
  const db = openDb(':memory:'); databases.push(db);
  const registry = new AtomRegistry(db);
  const atom = registry.createTemplate(tier, seed);
  const lesson: AtomLesson = { kind: 'atom', owner: atom.atomId, tier, name: atom.name, version: atom.version, prompt: atom.systemPrompt,
    host: { name: 'test', model: 'author', params: {}, systemPrompt: 'This must not become SYSTEM.' }, reviewerModel: 'reviewer',
    task: 'Private task', summary: 'Untrusted report', feedback: ['Initial verification failed.'],
    observations: [{ id: 'observed', text: 'Host observed a successful recorded probe after the correction.' }] };
  const ctx = makeCtx();
  return { db, registry, atom, lesson, ctx };
}
const proposal = { amendment: 'After changing the implementation, repeat the previously failing probe before reporting success.',
  evidenceIds: ['observed'], reason: 'A corrected probe was observed.' };

describe('prompt consolidation', () => {
  it.each([1, 2, 3] as const)('reviews and applies exactly once on rank %s, then survives a template refresh', async tier => {
    const { registry, atom, lesson, ctx, db } = fixture(tier);
    ctx.llm.enqueueText(JSON.stringify(proposal)); ctx.llm.enqueueText(JSON.stringify({ approved: true, reason: 'Supported and reusable.' }));
    registry.recordSuccess(atom.name);
    await consolidatePrompt(registry, lesson, ctx, { runId: 'source', index: 0 });
    expect(registry.getByName(atom.name)).toMatchObject({ version: 2, consecutiveSuccesses: 0, successes: 1 });
    expect(registry.getByName(atom.name)!.systemPrompt).toContain(proposal.amendment);
    expect(registry.learningOutcome('source', 0)).toBe('applied');
    await consolidatePrompt(registry, lesson, ctx, { runId: 'source', index: 0 });
    expect(ctx.llm.calls).toHaveLength(2);
    expect(ctx.llm.calls.map(call => call.model)).toEqual(['author', 'reviewer']);
    expect(ctx.llm.calls.every(call => !call.tools?.length)).toBe(true);
    expect(ctx.llm.calls[0]!.systemPrompt).not.toContain(lesson.host.systemPrompt);
    const updated = registry.refreshTemplate(atom.name, { systemPromptReplace: 'New host protocol.' }, 'bootstrap', 'template update');
    expect(updated.systemPrompt).toBe('New host protocol.\n\nLearned discipline:\n' + proposal.amendment);
    expect(db.prepare("SELECT kind FROM lifecycle_events WHERE kind IN ('prompt-learning', 'type-patch')").all()).toHaveLength(3);
  });

  it('does not spend on a stale executed version and CAS refuses a concurrent update during review', async () => {
    const { registry, atom, lesson, ctx } = fixture();
    registry.patch(atom.name, { systemPromptAppend: 'Concurrent rule' }, 'other');
    await consolidatePrompt(registry, lesson, ctx, { runId: 'stale', index: 0 });
    expect(ctx.llm.calls).toHaveLength(0);
    expect(registry.learningOutcome('stale', 0)).toBe('stale');
    const latest = registry.getByName(atom.name)!;
    ctx.llm.enqueueText(JSON.stringify(proposal));
    ctx.llm.enqueue(() => {
      registry.patch(atom.name, { systemPromptAppend: 'Another rule' }, 'other');
      return { text: JSON.stringify({ approved: true, reason: 'Okay' }), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    await consolidatePrompt(registry, { ...lesson, version: latest.version, prompt: latest.systemPrompt }, ctx, { runId: 'race', index: 0 });
    expect(registry.learningOutcome('race', 0)).toBe('stale');
    expect(registry.getByName(atom.name)!.systemPrompt).not.toContain(proposal.amendment);
  });

  it.each(['uncited', 'rejected', 'unchanged', 'malformed'])('does not mutate for a %s proposal', async outcome => {
    const { registry, atom, lesson, ctx } = fixture();
    ctx.llm.enqueueText(outcome === 'malformed' ? 'bad JSON' : JSON.stringify({ ...proposal,
      ...(outcome === 'uncited' ? { evidenceIds: ['invented'] } : {}), ...(outcome === 'unchanged' ? { amendment: null } : {}) }));
    if (outcome === 'rejected') ctx.llm.enqueueText(JSON.stringify({ approved: false, reason: 'Task-specific instruction; reject.' }));
    const run = consolidatePrompt(registry, lesson, ctx, { runId: 'source', index: 0 });
    if (outcome === 'malformed') await expect(run).rejects.toThrow(); else await run;
    expect(registry.getByName(atom.name)!.version).toBe(1);
  });

  it('caps learned content on an authored non-template atom', async () => {
    const { registry, lesson, ctx } = fixture();
    const atom = registry.create(3, { ...seed, systemPrompt: 'Authored method\n\nLearned discipline:\n' + 'x'.repeat(6000) });
    await consolidatePrompt(registry, { ...lesson, name: atom.name, owner: atom.atomId, tier: 3, prompt: atom.systemPrompt }, ctx, { runId: 'full', index: 0 });
    expect(ctx.llm.calls).toHaveLength(0); expect(registry.learningOutcome('full', 0)).toBe('full');
  });

  it('does not infer a current version after local behavior changes', () => {
    vi.stubEnv('ATOMA_SKILL_LEARN', '1');
    const { registry, atom, ctx } = fixture();
    const loaded = L1Atom.fromType(atom); loaded.applyModifications({ systemPromptAppend: 'Local recovery' });
    const defer = vi.fn();
    deferPromptLearning(registry, loaded, { description: 'Task' }, { summary: 'Claim', output: {}, trace: [], producedBy: { tier: 1, name: atom.name, viaFallback: false } },
      { ...ctx, deferredLearning: { defer } });
    expect(defer).not.toHaveBeenCalled();
  });
});

it('preserves learned suffixes through real canonical bootstrap paths, and custom legacy prompts byte-for-byte', () => {
  const { registry } = fixture();
  const tools = makeTools(['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'start_node_server', 'fetch_url', 'validate_html', 'start_static_server']);
  const bootstraps = [() => ensureCanonicalL1(registry, tools, 'smoke'), () => ensureCanonicalL2(registry, tools),
    () => ensureCanonicalFullStack(registry, tools, 1)!, () => ensureCanonicalFullStack(registry, tools, 2)!];
  for (const bootstrap of bootstraps) {
    const atom = bootstrap(); registry.patch(atom.name, { systemPromptAppend: 'Learned method.' }, 'validator');
    const before = registry.getByName(atom.name)!;
    expect(bootstrap().systemPrompt).toBe(before.systemPrompt);
    expect(bootstrap().version).toBe(before.version);
  }
  const custom = registry.create(2, { ...seed, systemPrompt: 'Legacy custom replacement.' });
  expect(registry.refreshTemplate(custom.name, { systemPromptReplace: 'Fresh seed' }, 'bootstrap', 'refresh').systemPrompt).toBe(custom.systemPrompt);
});


it('captures collective stale-read evidence and keeps observed results when requests are long', () => {
  for (const [key, value] of Object.entries({ ...OLLAMA_PINS, ATOMA_SKILL_LEARN: '1' })) vi.stubEnv(key, value);
  const { registry, atom, ctx } = fixture();
  const attestations = createAttestationLog();
  attestations.append({ eventId: 'old-read', tool: 'read_file', observation: { kind: 'execution', filePath: 'a.txt', request: '{}', response: 'OLD SECRET CONTENT' } });
  attestations.append({ eventId: 'rewrite', tool: 'write_file', observation: { kind: 'execution', filePath: 'a.txt', request: '{}', response: 'written' } });
  attestations.append({ eventId: 'probe', tool: 'run_shell', observation: { kind: 'execution', request: 'x'.repeat(4000), response: 'OBSERVED PASS' } });
  const defer = vi.fn();
  deferPromptLearning(registry, L1Atom.fromType(atom), { description: 'Task' }, { summary: 'Claim', output: {}, trace: [],
    producedBy: { tier: 1, name: atom.name, viaFallback: false }, evidence: [
      { source: 'transport-observed', eventId: 'old-read', tool: 'read_file', observed: 'Untrusted projection ignored' },
      { source: 'transport-observed', eventId: 'probe', tool: 'run_shell', observed: 'Untrusted projection ignored' },
    ] }, { ...ctx, attestations, deferredLearning: { defer } });
  const lesson = defer.mock.calls[0]![2] as AtomLesson;
  expect(lesson.observations[0]!.text).toContain('STALE');
  expect(lesson.observations[0]!.text).not.toContain('OLD SECRET CONTENT');
  expect(lesson.observations[1]!.text).toContain('observed result=OBSERVED PASS');
  expect(lesson.observations.every(item => item.text.length <= 2000)).toBe(true);
});

it('captures reviewed reasoning-only lessons without tool observations', () => {
  for (const [key, value] of Object.entries({ ...OLLAMA_PINS, ATOMA_SKILL_LEARN: '1' })) vi.stubEnv(key, value);
  const { registry, atom, ctx } = fixture();
  const defer = vi.fn();
  deferPromptLearning(registry, L1Atom.fromType(atom), { description: 'Reason about the supplied text' },
    { summary: 'Revised reasoning', output: {}, trace: [], producedBy: { tier: 1, name: atom.name, viaFallback: false } },
    { ...ctx, deferredLearning: { defer } }, ['The initial argument conflated two assumptions.'], 'Revised argument separates assumptions and justifies each implication.');
  const lesson = defer.mock.calls[0]![2] as AtomLesson;
  expect(lesson.observations).toEqual([expect.objectContaining({ id: 'supervisor-approval' })]);
  expect(lesson.feedback).toHaveLength(1);
});

it('does not reuse a template identity whose prompt was wholly replaced', () => {
  const { registry, atom } = fixture();
  registry.patch(atom.name, { systemPromptReplace: 'Specialized custom scope.' }, 'validator');
  const next = registry.createOrRefresh(1, seed, text => text === seed.systemPrompt);
  expect(next.atomId).not.toBe(atom.atomId);
  expect(registry.getByAtomId(atom.atomId)!.systemPrompt).toBe('Specialized custom scope.');
});


it('keeps a no-op template refresh read-only for checkpoint recovery', () => {
  const { registry, atom } = fixture();
  const mutation = vi.fn();
  withRecoveryEffects(() => {
    setRecoveryEffectHandler(mutation);
    expect(registry.refreshTemplate(atom.name, { systemPromptReplace: seed.systemPrompt }, 'bootstrap', 'refresh').version).toBe(atom.version);
    expect(registry.createOrRefresh(1, seed, text => text === seed.systemPrompt).atomId).toBe(atom.atomId);
    expect(mutation).not.toHaveBeenCalled();
  });
});
