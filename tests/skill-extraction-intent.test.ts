import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { createJevDecider } from '../src/core/jev.js';
import { subtaskOutputIntent } from '../src/skills/scriptTargets.js';
import type { JevTwinRequest, SkillEventInfo, ToolExecutor } from '../src/core/types.js';
import { makeCtx, nsOf, saveCompiledScript } from './helpers.js';

const seed = { description: 'command artifact worker', systemPrompt: 'Execute the task.', params: {}, createdBy: 'test' };
const primary = { id: 'build-test-artifact', description: 'Build an artifact', when_to_use: 'Task asks to build an artifact', body: '1. write_file <entry>.\n2. record_probe its commands.' };
const verification = { id: 'verify-recorded-commands', description: 'Replay recorded commands', when_to_use: 'Task asks to recheck recorded behavior', body: '1. read_file .atoma-probes.json.\n2. run_shell each recorded command and compare exit and streams.' };
const script = 'console.log(JSON.stringify({output: {verified: true}, summary: "All recorded probes match."}));';
const originalGoal = 'Recheck the existing API verification package against every command and expected exitCode/stdout/stderr recorded in .atoma-probes.json. Replay the entries in order with a bounded timeout and compare the actual results byte-for-byte wherever stdout or stderr is recorded, including entries whose expected exit code is nonzero. Report the observed comparisons and fail on any mismatch. Preserve all application files, fixture manifests and recorded expectations exactly; do not regenerate, overwrite or add probes and do not repair anything. This is only a re-verification of recorded behavior, not a build or design task.';

describe('production verification extraction and semantic dispatch', () => {
  let dir: string;
  let registry: AtomRegistry;
  let skills: SkillRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-extract-intent-'));
    registry = new AtomRegistry(openDb(':memory:'));
    registry.create(2, { ...seed, tools: [] });
    registry.create(1, { ...seed, tools: ['write_file', 'read_file', 'run_shell', 'record_probe'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })) });
    for (let i = 0; i < 4; i++) registry.recordSuccess('Water');
    skills = new SkillRegistry(dir);
    vi.stubEnv('ATOMA_SKILL_LEARN', '1');
    vi.stubEnv('ATOMA_SKILL_PROMOTE', '0');
    vi.stubEnv('ATOMA_SKILL_DIRECT', '1');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const reusable = (target: string) => JSON.stringify({ kind: 'reuse', target, confidence: 'high', reasoning: 'fits' });
  function builder(reuse = false, record = true, late = false) {
    if (reuse) skills.save(nsOf(registry, 'Water'), { id: primary.id, description: primary.description, whenToUse: primary.when_to_use, kind: 'llm', body: primary.body });
    const ctx = makeCtx();
    ctx.llm.enqueueText(reusable('Water'));
    if (reuse) ctx.llm.enqueueText(reusable(primary.id));
    ctx.llm.enqueueText(JSON.stringify({ reasoning: 'Build and probe', proposedAction: 'Use file and probe tools', expectedOutput: 'Verified artifact' }));
    ctx.llm.enqueue(req => {
      for (let i = 0; i < (late ? 65 : 1); i++) req.onToolInvocation?.({ name: 'write_file', args: { path: 'entry.mjs' }, result: { ok: true }, durationMs: 1, startedAt: Date.now() });
      if (record) req.onToolInvocation?.({ name: 'record_probe', args: { cmd: 'node entry.mjs --invalid' }, result: { exitCode: 1, stdout: '', stderr: 'expected invalid input', recorded: true }, durationMs: 1, startedAt: Date.now() });
      return { text: JSON.stringify({ output: { recordedCommandProbes: true }, summary: 'Built and recorded command probes.' }), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    });
    return { ctx, run: () => L2Atom.fromType(registry.getByName('Tracheid')!, registry, [], skills).handleDirect({ description: 'Build and verify an artifact.' }, ctx) };
  }
  const loaded = () => skills.loadFor(nsOf(registry, 'Water'));

  it('extracts and compiles the omitted sibling through the actual L1 observer and L2 approval hook', async () => {
    vi.stubEnv('ATOMA_SKILL_PROMOTE', '1');
    const { ctx, run } = builder(false, true, true);
    ctx.llm.enqueueText(JSON.stringify(primary));
    ctx.llm.enqueueText(JSON.stringify({ verification, reason: 'Recorded comparisons are mechanical.' }));
    ctx.llm.enqueueText(JSON.stringify({ promotable: false, reason: 'The build needs judgment.' }));
    ctx.llm.enqueueText(JSON.stringify({ promotable: true, language: 'node', body: script, writes: [] }));
    const result = await run();
    expect(result.recordedCommandProbes).toBe(true);
    expect(result.toolCallResults).toHaveLength(64);
    expect(loaded().find(s => s.id === primary.id)?.kind).toBe('llm');
    expect(loaded().find(s => s.id === verification.id)).toMatchObject({ kind: 'script', body: script, successes: 0, failures: 0 });
    expect(ctx.llm.calls.filter(c => c.userContent.startsWith('Extract ONE'))).toHaveLength(1);
  });

  it('extracts beside a reused build recipe without redistilling or overwriting it', async () => {
    const { ctx, run } = builder(true);
    ctx.llm.enqueueText(JSON.stringify({ verification, reason: 'Reusable command replay.' }));
    await run();
    expect(loaded().find(s => s.id === primary.id)).toMatchObject({ body: primary.body, successes: 1 });
    expect(loaded().some(s => s.id === verification.id)).toBe(true);
    const learning = ctx.llm.calls.filter(c => c.role === 'skill');
    expect(learning).toHaveLength(1);
    expect(learning[0]!.userContent).toMatch(/^Extract ONE/);
  });

  it.each(['malformed', 'unavailable'])('keeps extraction independent of a %s primary draft', async failure => {
    const { ctx, run } = builder();
    if (failure === 'malformed') ctx.llm.enqueueText('no JSON');
    else ctx.llm.enqueue(() => { throw new Error('primary distiller unavailable'); });
    ctx.llm.enqueueText(JSON.stringify({ verification, reason: 'Mechanical replay remains useful.' }));
    await run();
    expect(loaded().map(s => s.id)).toEqual([verification.id]);
  });

  it('keeps the primary when extraction fails and retries on a later approved build', async () => {
    const first = builder();
    first.ctx.llm.enqueueText(JSON.stringify(primary));
    first.ctx.llm.enqueue(() => { throw new Error('temporary extraction outage'); });
    await first.run();
    expect(loaded().map(s => s.id)).toEqual([primary.id]);
    const second = builder(true);
    second.ctx.llm.enqueueText(JSON.stringify({ verification }));
    await second.run();
    expect(loaded().map(s => s.id).sort()).toEqual([primary.id, verification.id].sort());
  });

  it('does not buy extraction from narrative or model-payload claims of recorded probes', async () => {
    const { ctx, run } = builder(false, false);
    ctx.llm.enqueueText(JSON.stringify(primary));
    const result = await run();
    expect(result.recordedCommandProbes).toBeUndefined();
    expect(ctx.llm.calls.filter(c => c.role === 'skill')).toHaveLength(1);
    expect(loaded().map(s => s.id)).toEqual([primary.id]);
  });

  it('does not repeat extraction when the main response supplies a usable sibling', async () => {
    const { ctx, run } = builder();
    ctx.llm.enqueueText(JSON.stringify({ ...primary, verification }));
    await run();
    expect(ctx.llm.calls.filter(c => c.role === 'skill')).toHaveLength(1);
    expect(loaded().map(s => s.id).sort()).toEqual([primary.id, verification.id].sort());
  });

  it.each([
    { id: '../unsafe', body: verification.body },
    { id: 'phantom-browser-check', body: '1. validate_html with browser interactions.' },
  ])('applies the ordinary draft guards to independent extraction ($id)', async bad => {
    const { ctx, run } = builder();
    ctx.llm.enqueueText(JSON.stringify(primary));
    ctx.llm.enqueueText(JSON.stringify({ verification: { ...verification, ...bad } }));
    await run();
    expect(loaded().map(s => s.id)).toEqual([primary.id]);
  });

  it('preserves the existing exact-id recipe when extraction finds the same workflow', async () => {
    const { ctx, run } = builder(true);
    ctx.llm.enqueueText(JSON.stringify({ verification: primary }));
    await run();
    expect(loaded()).toHaveLength(1);
    expect(loaded()[0]!.successes).toBe(1);
  });

  it.each([true, false])('uses the ordinary Jev twin guard for the independent draft (twin: %s)', async twin => {
    const { ctx } = builder(true);
    skills.save(nsOf(registry, 'Water'), { id: 'existing-verifier', description: verification.description, whenToUse: verification.when_to_use, kind: 'llm', body: verification.body });
    const compared: JevTwinRequest[] = [];
    const actual = { ...ctx, jev: {
      choose: async () => null, approve: async () => null,
      twin: async (request: JevTwinRequest) => {
        compared.push(request);
        return twin ? { twinOf: 'existing-verifier', confidence: 0.99 } : null;
      },
    } };
    ctx.llm.enqueueText(JSON.stringify({ verification }));
    await L2Atom.fromType(registry.getByName('Tracheid')!, registry, [], skills).handleDirect({ description: 'Build and verify an artifact.' }, actual);
    expect(compared).toHaveLength(1);
    expect(compared[0]!.existing.map(s => s.id)).toContain('existing-verifier');
    expect(loaded().some(s => s.id === verification.id)).toBe(!twin);
  });

  function verifier() {
    saveCompiledScript(skills, nsOf(registry, 'Water'), { id: verification.id, description: verification.description, whenToUse: verification.when_to_use, language: 'node', body: script });
    const events: SkillEventInfo[] = [];
    const tools: ToolExecutor = {
      has: () => true,
      execute: async (name) => name === 'run_shell'
        ? { exitCode: 0, stdout: JSON.stringify({ output: { verified: true }, summary: 'All recorded probes match.' }), stderr: '' }
        : name === 'read_file' ? { content: '{}' } : { ok: true },
    };
    const ctx = { ...makeCtx(), tools, recordSkill: (event: SkillEventInfo) => events.push(event) };
    return { ctx, events, run: () => L2Atom.fromType(registry.getByName('Tracheid')!, registry, [], skills).handleDirect({ description: originalGoal }, ctx) };
  }

  it('directly dispatches the unmodified production request using the model prefilter file intent', async () => {
    const { ctx, events, run } = verifier();
    ctx.llm.enqueueText(reusable('Water'));
    ctx.llm.enqueueText(JSON.stringify({ kind: 'reuse', target: verification.id, confidence: 'high', fileEffect: 'read-only', reasoning: 'Only recorded verification.' }));
    // No Jev here: the script's result is validated by the model (2026-10-06).
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'every recorded probe matched' }));
    expect(subtaskOutputIntent({ description: originalGoal }).mutating).toBe(true);
    await run();
    expect(ctx.llm.calls.map(c => c.role)).toEqual(['prefilter', 'prefilter', 'validate-result']);
    expect(events.map(e => e.op)).toEqual(['match', 'direct', 'success']);
  });

  it('carries Jev’s already-asked file-intent answer through the real decoder and dispatch', async () => {
    const { ctx, events } = verifier();
    const questions: string[][] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      const body = JSON.parse(init.body) as { questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
      questions.push(Object.keys(body.questions));
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [
        id, q.type === 'choice'
          ? { type: 'choice', choice: Object.keys(q.criteria!)[0], confidence: 0.99, probabilities: { [Object.keys(q.criteria!)[0]!]: 0.99 } }
          : { type: 'noul', noul: id.startsWith('fits::') ? 0.99 : 0.01 },
      ]));
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    };
    const actual = { ...ctx, jev: createJevDecider({ apiKey: 'test-key', record: () => {}, fetchImpl }) };
    await L2Atom.fromType(registry.getByName('Tracheid')!, registry, [], skills).handleDirect({ description: originalGoal }, actual);
    expect(ctx.llm.calls).toHaveLength(0);
    expect(events.map(e => e.op)).toEqual(['match', 'direct', 'success']);
    // Routing, the recipe pick, then the approval of the script's result:
    // Jev approving keeps the whole dispatch free of model calls (2026-10-06).
    expect(questions).toHaveLength(3);
    expect(questions[1]).toContain('task_changes_files');
    expect(questions[2]!.some((id) => id.startsWith('requirement_'))).toBe(true);
  });

  it('never lets a semantic read-only label erase declared outputs', () => {
    expect(subtaskOutputIntent({ description: originalGoal, outputs: ['README.md'], fileEffect: 'read-only' }))
      .toEqual({ mutating: true, targetPaths: ['README.md'], source: 'declared' });
    expect(subtaskOutputIntent({ description: originalGoal, readOnly: true }).mutating).toBe(false);
    expect(subtaskOutputIntent({ description: 'Inspect the report', fileEffect: 'mutating' }).mutating).toBe(true);
  });
});
