import { SkillLifecycle } from '../src/skills/lifecycle.js';
import { asStoredNamespace } from '../src/skills/namespace.js';
import { subtaskMutatesFiles, subtaskMutationTargets } from '../src/skills/lifecycle.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { SkillRegistry } from '../src/skills/registry.js';
import type { JevDecider, RunContext, SkillEventInfo, ToolExecutor } from '../src/core/types.js';
import { MockLlmClient } from '../src/core/llm.js';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import { deriveTrajectorySignatures } from '../src/contracts/trajectory.js';
import { makeCtx, jsonText , nsOf, saveCompiledScript } from './helpers.js';

/**
 * Tests for #C4 — DETERMINISTIC DISPATCH of trusted `kind: 'script'`
 * skills. When the skill prefilter matches a script skill whose own
 * counters pass the trust gate (0 failures — since 2026-09-26 no clean
 * runs are required first) and
 * `ctx.tools` is wired, L2 executes the script directly via
 * write_file + run_shell — no L1 plan/execute — and, since 2026-10-06,
 * validates its result (Jev, else the model). Any deviation (non-zero
 * exit, missing {"output","summary"} envelope, tool error, a refused
 * validation, kill-switch env) falls back to the validated loop, which is
 * never handed a script that already ran in the phase.
 */

const seed = {
  description: 'web orchestrator',
  systemPrompt: 'You are an L2.',
  tools: [],
  params: {},
  createdBy: 'test',
};

// The body WRITES (fs.writeFileSync). That matters since the capability
// filter added for round 7: a compiled script with no write surface is no
// longer offered for a subtask that asks a file to change, so a non-writing
// body here would never reach the deliverable gate these tests exercise.
const SCRIPT_BODY = `import fs from 'node:fs';\nfs.writeFileSync('out.txt', 'x');\nconsole.log(JSON.stringify({ output: { built: true }, summary: 'script ran clean' }));`;

const ENVELOPE_LINE = JSON.stringify({ output: { built: true }, summary: 'script ran clean' });

function enqueueExecutedResult(
  ctx: RunContext & { llm: MockLlmClient },
  payload: unknown
): void {
  ctx.llm.enqueue((req) => {
    req.onToolInvocation?.({
      name: 'write_file',
      args: { path: 'artefact.txt' },
      result: { ok: true },
      durationMs: 1,
      startedAt: Date.now(),
    });
    return {
      text: jsonText(payload),
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  });
}

/**
 * A Jev that approves every result it is asked to judge and decides nothing
 * else. Since 2026-10-06 a direct dispatch's result is validated like a
 * molecule's (`validateScriptDispatch`); with Jev approving, the tests that
 * are about something else keep their zero-model-call shape. The model
 * validator path has its own tests below.
 */
function approvingJev(): JevDecider {
  return {
    choose: async () => null,
    approve: async () => ({ approved: true, probability: 0.95 }),
    twin: async () => null,
  };
}

function makeExecutor(runShellResult: unknown): {
  executor: ToolExecutor;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const executor: ToolExecutor = {
    async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
      calls.push({ name, args });
      if (name === 'write_file') {
        return { ok: true, path: args['path'], bytes: ((args['content'] as string | undefined) ?? '').length };
      }
      if (name === 'run_shell') return runShellResult;
      throw new Error(`unexpected tool: ${name}`);
    },
    has(name: string): boolean {
      return name === 'write_file' || name === 'run_shell';
    },
  };
  return { executor, calls };
}

describe('direct dispatch — attribution follows the EXECUTOR, not the namespace', () => {
  let dir: string;
  let skills: SkillRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-attrib-'));
    skills = new SkillRegistry(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports the running atom when a script is matched from a DONOR namespace', async () => {
    // Under the shared catalog a trusted script can be matched out of another
    // atom's namespace. Attribution used to be stamped from that namespace, so
    // the result claimed it was produced by an atom that never ran — and
    // `producedBy.name` is rendered to the model as the phase author in the L2
    // and L3 aggregation prompts.
    skills.save(asStoredNamespace('Ammonia'), {
      id: 'scaffold-config',
      description: 'write a canonical config file',
      whenToUse: 'when the subtask asks for the standard config scaffold',
      kind: 'script',
      language: 'node',
      body: SCRIPT_BODY,
    });
    const skill = skills.loadFor(asStoredNamespace('Ammonia'))[0]!;
    const { executor } = makeExecutor({ exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' });
    const lifecycle = new SkillLifecycle(
      {
        name: 'Water',
        model: 'm',
        params: {},
        toLlmRequest: (role, args) => ({
          ...args,
          model: 'm',
          systemPrompt: 'sys',
          role,
          actor: { name: 'Water', tier: 2 },
        }),
      },
      skills
    );
    const ctx = { ...makeCtx(), tools: executor };

    const outcome = await lifecycle.runScriptSkillDirect(
      skill,
      asStoredNamespace('Ammonia'), // where the recipe is FILED
      'Water', // who actually RUNS it
      { description: 'scaffold the config' },
      ctx
    );

    expect(outcome.kind).toBe('ran');
    const result = outcome.kind === 'ran' ? outcome.result : null;
    expect(result!.producedBy).toEqual({ tier: 1, name: 'Water', viaFallback: false });
    expect(result!.trace?.[0]?.atom).toBe('Water');
  });
});

describe('L2.runSubtask — deterministic script dispatch (C4)', () => {
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;
  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-direct-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, {
      ...seed,
      description: 'web builder',
      systemPrompt: 'You are an L1.',
    });
    envBefore = process.env['ATOMA_SKILL_DIRECT'];
    delete process.env['ATOMA_SKILL_DIRECT'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env['ATOMA_SKILL_DIRECT'];
    else process.env['ATOMA_SKILL_DIRECT'] = envBefore;
  });

  function trustAtomType(): void {
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Water');
  }

  function saveScriptSkill(successes: number): void {
    saveCompiledScript(skills, nsOf(reg, 'Water'), {
      id: 'scaffold-config',
      description: 'write a canonical config file',
      whenToUse: 'when the subtask asks for the standard config scaffold',
      language: 'node',
      body: SCRIPT_BODY,
    });
    for (let i = 0; i < successes; i++) skills.recordSuccess(nsOf(reg, 'Water'), 'scaffold-config');
  }

  /** The one untrusted state left: a script with a failure on record. */
  function saveUntrustedScriptSkill(): void {
    saveScriptSkill(0);
    skills.recordFailure(nsOf(reg, 'Water'), 'scaffold-config');
  }

  function makeCtxWith(
    executor: ToolExecutor,
    events?: SkillEventInfo[]
  ): RunContext & { llm: MockLlmClient } {
    const base = makeCtx();
    return {
      ...base,
      tools: executor,
      ...(events ? { recordSkill: (e: SkillEventInfo) => events.push(e) } : {}),
    };
  }

  it('runs a TRUSTED script skill with zero LLM calls beyond the two prefilters', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES); // 3/0 — trusted
    const { executor, calls } = makeExecutor({ exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' });
    const events: SkillEventInfo[] = [];
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = { ...makeCtxWith(executor, events), jev: approvingJev() };

    // ONLY the two prefilter replies are queued. If the dispatch fell
    // through to the LLM loop, MockLlmClient would throw "no queued
    // reply" on the L1 plan call — that's the strongest assertion that
    // the fast-path really made zero further LLM calls.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );

    const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);

    expect(ctx.llm.calls).toHaveLength(2);
    expect(result.output).toEqual({ built: true });
    expect(result.summary).toBe('script ran clean');
    expect(result.producedBy).toEqual({ tier: 1, name: 'Water', viaFallback: false });

    // write + run mirror skillContextBlock's calling convention, then the
    // scratch script is removed — it is scaffolding, not deliverable, and
    // subtasks routinely assert the exact workspace contents afterwards.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      name: 'write_file',
      args: { path: '_skill_scaffold-config.mjs', content: SCRIPT_BODY },
    });
    expect(calls[1]!.name).toBe('run_shell');
    expect(calls[1]!.args).toEqual({
      command: 'node',
      args: ['_skill_scaffold-config.mjs', JSON.stringify('scaffold the config')],
    });
    expect(calls[2]!.name).toBe('run_shell');
    expect(calls[2]!.args['args']).toEqual([
      '-e',
      'require("fs").rmSync(process.argv[1],{force:true})',
      '_skill_scaffold-config.mjs',
    ]);

    // Skill success counter bumped by the dispatch itself (the supervise
    // loop never ran, so its onApproved hook could not).
    const loaded = skills.loadFor(nsOf(reg, 'Water')).find((s) => s.id === 'scaffold-config')!;
    expect(loaded.successes).toBe(TRUST_THRESHOLD_SUCCESSES + 1);
    expect(loaded.failures).toBe(0);

    // Event stream: match → direct → success, and NO inject (the body
    // never entered any prompt).
    expect(events.map((e) => e.op)).toEqual(['match', 'direct', 'success']);
  });

  it('dispatches a never-credited script (0/0) on its very first match', async () => {
    // Owner decision 2026-09-26: a freshly compiled script — counters reset
    // by promotion — does not earn clean runs before it runs unwatched.
    trustAtomType();
    saveScriptSkill(0);
    const { executor, calls } = makeExecutor({ exitCode: 0, stdout: `${ENVELOPE_LINE}
`, stderr: '' });
    const events: SkillEventInfo[] = [];
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = { ...makeCtxWith(executor, events), jev: approvingJev() };
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );

    const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);

    expect(ctx.llm.calls).toHaveLength(2);
    expect(result.output).toEqual({ built: true });
    expect(calls.map((c) => c.name)).toEqual(['write_file', 'run_shell', 'run_shell']);
    const loaded = skills.loadFor(nsOf(reg, 'Water')).find((s) => s.id === 'scaffold-config')!;
    expect(loaded.successes).toBe(1);
    expect(events.map((e) => e.op)).toEqual(['match', 'direct', 'success']);
  });

  it('does NOT dispatch a script with a recorded failure (falls through to the LLM loop)', async () => {
    trustAtomType();
    saveUntrustedScriptSkill(); // 0/1 — a failure revokes dispatch
    const { executor, calls } = makeExecutor({ exitCode: 0, stdout: ENVELOPE_LINE, stderr: '' });
    const events: SkillEventInfo[] = [];
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtxWith(executor, events);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    // L1.plan + L1.execute — the normal skilled path.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

    const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);

    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
    // No direct tool calls happened (the L1's mocked execute made none).
    expect(calls).toHaveLength(0);
    // The script body was injected for the LLM path instead.
    expect(ctx.llm.calls[2]!.systemPrompt).toMatch(/== ACTIVE SKILL: scaffold-config/);
    expect(events.map((e) => e.op)).toEqual(['match', 'inject', 'credit-withheld']);
  });

  it('does NOT dispatch a hand-authored script without a fallback, however clean its record', async () => {
    // skills/AGENTS.md: a script without _fallback.md is undemotable and is
    // refused before dispatch. The earned-run wait used to be the only thing
    // keeping such a script from running unwatched; with it gone (2026-09-26)
    // the refusal lives in shouldTrustSkill.
    trustAtomType();
    skills.save(nsOf(reg, 'Water'), {
      id: 'scaffold-config',
      description: 'write a canonical config file',
      whenToUse: 'when the subtask asks for the standard config scaffold',
      kind: 'script',
      language: 'node',
      body: SCRIPT_BODY,
    });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) skills.recordSuccess(nsOf(reg, 'Water'), 'scaffold-config');
    const { executor, calls } = makeExecutor({ exitCode: 0, stdout: ENVELOPE_LINE, stderr: '' });
    const events: SkillEventInfo[] = [];
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtxWith(executor, events);
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

    const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);

    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
    expect(calls).toHaveLength(0);
    expect(ctx.llm.calls[2]!.systemPrompt).toMatch(/== ACTIVE SKILL: scaffold-config/);
    expect(events.map((e) => e.op)).not.toContain('direct');
  });

  it('credits an untrusted script only when L1 writes and runs its exact scratch file', async () => {
    trustAtomType();
    saveUntrustedScriptSkill();
    const { executor } = makeExecutor({ exitCode: 0, stdout: ENVELOPE_LINE, stderr: '' });
    const events: SkillEventInfo[] = [];
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtxWith(executor, events);
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueue((req) => {
      req.onToolInvocation?.({
        name: 'write_file',
        args: { path: '_skill_scaffold-config.mjs' },
        result: { ok: true },
        durationMs: 1,
        startedAt: 1,
      });
      req.onToolInvocation?.({
        name: 'run_shell',
        args: {
          command: 'node',
          args: ['_skill_scaffold-config.mjs', JSON.stringify('scaffold the config')],
        },
        result: { exitCode: 0, stdout: ENVELOPE_LINE, stderr: '' },
        durationMs: 1,
        startedAt: 2,
      });
      return {
        text: jsonText({ output: 'done', summary: 'script-assisted path' }),
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    });

    await neuron.handleDirect({ description: 'scaffold the config' }, ctx);
    const loaded = skills.loadFor(nsOf(reg, 'Water')).find((s) => s.id === 'scaffold-config')!;
    expect(loaded.successes).toBe(1);
    expect(events.map((e) => e.op)).toEqual(['match', 'inject', 'success']);
  });

  it('falls back to the LLM loop when the script exits non-zero — without bumping the failure counter', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const { executor, calls } = makeExecutor({ exitCode: 1, stdout: '', stderr: 'boom' });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtxWith(executor);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'saved by the loop', summary: 'llm path ok' });

    const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);

    expect(result.summary).toBe('llm path ok');
    // The direct attempt DID try both tools before giving up — and still
    // cleaned up its scratch file on the way out (the `finally`), so a failed
    // dispatch doesn't leave debris for the LLM loop to trip over.
    expect(calls.map((c) => c.name)).toEqual(['write_file', 'run_shell', 'run_shell']);
    expect(calls[2]!.args['args']).toContain('_skill_scaffold-config.mjs');
    // A deterministic failure is NOT a skill failure. The fallback LLM
    // delivered, but it did not execute the injected script scratch body, so
    // that delivery cannot credit the script either.
    const loaded = skills.loadFor(nsOf(reg, 'Water')).find((s) => s.id === 'scaffold-config')!;
    expect(loaded.failures).toBe(0);
    expect(loaded.successes).toBe(TRUST_THRESHOLD_SUCCESSES);
  });

  it('DEMOTES a script back to its llm fallback after 2 consecutive deterministic failures', async () => {
    trustAtomType();
    // Reach kind:script the production way — promotion writes _fallback.md,
    // which is what demotion restores.
    skills.save(nsOf(reg, 'Water'), {
      id: 'scaffold-config',
      description: 'write a canonical config file',
      whenToUse: 'when the subtask asks for the standard config scaffold',
      kind: 'llm',
      body: '1. derive fields from the workspace.\n2. write_file config.\n3. read back.',
    });
    skills.promoteToScript({
      l1Name: nsOf(reg, 'Water'),
      skillId: 'scaffold-config',
      language: 'node',
      scriptBody: SCRIPT_BODY,
    });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      skills.recordSuccess(nsOf(reg, 'Water'), 'scaffold-config');
    }
    // Brittle script: exits 1 on every run, LLM loop saves the subtask.
    const { executor } = makeExecutor({ exitCode: 1, stdout: '', stderr: 'REVERIFY-FAIL: nothing extracted' });

    for (const runLabel of ['first', 'second'] as const) {
      const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
      const events: SkillEventInfo[] = [];
      const ctx = makeCtxWith(executor, events);
      ctx.llm.enqueueText(
        jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
      );
      ctx.llm.enqueueText(
        jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
      );
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      enqueueExecutedResult(ctx, {
        output: 'saved by the loop',
        summary: `llm ok (${runLabel})`,
      });
      const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);
      expect(result.summary).toBe(`llm ok (${runLabel})`);
      if (runLabel === 'first') {
        // Streak at 1 — still a script, no demotion yet.
        expect(skills.loadFor(nsOf(reg, 'Water'))[0]!.kind).toBe('script');
        expect(skills.loadFor(nsOf(reg, 'Water'))[0]!.directFailures).toBe(1);
      } else {
        // Streak hit 2 — demoted, original llm recipe restored, and the
        // demotion is visible in the event stream.
        const demoted = skills.loadFor(nsOf(reg, 'Water'))[0]!;
        expect(demoted.kind).toBe('llm');
        expect(demoted.body).toMatch(/derive fields from the workspace/);
        expect(ctx.llm.calls[2]!.systemPrompt).toMatch(/derive fields from the workspace/);
        expect(ctx.llm.calls[2]!.systemPrompt).not.toMatch(/kind: script|== SCRIPT BODY ==/);
        expect(events.some((e) => e.op === 'demote')).toBe(true);
        // save() during demotion cleared the streak with the body rewrite.
        expect(demoted.directFailures).toBeUndefined();
        // Anti-oscillation: without the stamp, the restored llm form would
        // re-earn 5/0, recompile the SAME body, produce the SAME brittle
        // script, and loop forever. Cleared only by a body revision.
        expect(demoted.promotionRefusedAt).toBeTruthy();
        expect(demoted.promotionRefusedReason).toMatch(/auto-demoted/);
      }
    }
  });

  it('a deterministic SUCCESS clears the failure streak', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    skills.markDirectFailure(nsOf(reg, 'Water'), 'scaffold-config');
    expect(skills.loadFor(nsOf(reg, 'Water'))[0]!.directFailures).toBe(1);
    const { executor } = makeExecutor({ exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = { ...makeCtxWith(executor), jev: approvingJev() };
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('script ran clean');
    expect(skills.loadFor(nsOf(reg, 'Water'))[0]!.directFailures).toBeUndefined();
  });

  it('treats a self-reported FAILED envelope as off-contract even on exit 0', async () => {
    // The deterministic path has no validator downstream, and a compiled
    // script can announce its own failure while still exiting 0 — measured on
    // the freshly-promoted `document-cli-from-source`:
    //   {"output":null,"summary":"FAILED: index.js ... not found ..."}  EXIT=0
    // Accepting that credited a success and entrenched a broken script.
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const failEnvelope = JSON.stringify({
      output: null,
      summary: 'FAILED: index.js and/or package.json not found in workspace.',
    });
    const { executor } = makeExecutor({ exitCode: 0, stdout: failEnvelope, stderr: '' });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtxWith(executor);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    // The LLM loop must take over.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done properly', summary: 'ok' });

    const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
  });

  it('treats output:null as off-contract (no silent success on a null deliverable)', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const nullOut = JSON.stringify({ output: null, summary: 'wrote nothing, all good!' });
    const { executor } = makeExecutor({ exitCode: 0, stdout: nullOut, stderr: '' });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtxWith(executor);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

    await neuron.handleDirect({ description: 'scaffold the config' }, ctx);
    // Neither the off-contract direct result nor an LLM fallback that ignored
    // the injected scratch body may credit the script.
    const loaded = skills.loadFor(nsOf(reg, 'Water')).find((s) => s.id === 'scaffold-config')!;
    expect(loaded.successes).toBe(TRUST_THRESHOLD_SUCCESSES);
    expect(loaded.failures).toBe(0);
  });

  it('falls back to the LLM loop when stdout carries no {"output","summary"} envelope', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const { executor } = makeExecutor({ exitCode: 0, stdout: 'plain text, no envelope', stderr: '' });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtxWith(executor);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

    const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
  });

  it('never RUNS a script whose body cannot emit the envelope (pre-flight gate)', async () => {
    trustAtomType();
    // A hand-authored script written against a different calling convention:
    // positional argv, prose stdout. Dispatching it would write a bogus
    // artefact (its argv[0] is the whole JSON-encoded subtask description)
    // BEFORE the envelope parse could reject it, leaving the LLM loop to
    // clean up after a side effect it didn't cause. The gate must skip the
    // run entirely, not run-then-reject.
    saveCompiledScript(skills, nsOf(reg, 'Water'), {
      id: 'scaffold-config',
      description: 'write a canonical config file',
      whenToUse: 'when the subtask asks for the standard config scaffold',
      language: 'node',
      body: [
        `const fs = require('fs');`,
        `const name = process.argv[2];`,
        `fs.writeFileSync('config.json', JSON.stringify({ name }));`,
        `console.log('wrote config.json: ' + name);`,
      ].join('\n'),
    });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      skills.recordSuccess(nsOf(reg, 'Water'), 'scaffold-config');
    }
    const { executor, calls } = makeExecutor({ exitCode: 0, stdout: 'wrote config.json', stderr: '' });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const events: SkillEventInfo[] = [];
    const ctx = makeCtxWith(executor, events);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

    const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('ok');
    // Zero tool calls from the dispatch path: no write_file, no run_shell,
    // and therefore no scratch-script cleanup either.
    expect(calls).toHaveLength(0);
    // No deterministic-dispatch event was recorded: the skill still drove the
    // run (and so still earns its counter bump through the normal validated
    // path), but it was never credited with a script execution.
    expect(events.map((e) => e.op)).not.toContain('direct');
    expect(events.map((e) => e.op)).toContain('match');
  });

  it('honours the ATOMA_SKILL_DIRECT=0 kill switch', async () => {
    process.env['ATOMA_SKILL_DIRECT'] = '0';
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const { executor, calls } = makeExecutor({ exitCode: 0, stdout: ENVELOPE_LINE, stderr: '' });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtxWith(executor);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

    const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
    expect(calls).toHaveLength(0);
  });

  it('does not dispatch when ctx.tools is absent (research-brief-style runs)', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx(); // no tools

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

    const result = await neuron.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
  });
});

describe('SkillRegistry.resetCounters', () => {
  let dir: string;
  let skills: SkillRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-reset-'));
    skills = new SkillRegistry(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('zeroes counters AND clears the promotion-refusal stamp', () => {
    skills.save(asStoredNamespace('Water'), {
      id: 'some-skill',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    skills.recordSuccess(asStoredNamespace('Water'), 'some-skill');
    skills.recordFailure(asStoredNamespace('Water'), 'some-skill');
    skills.markPromotionRefused(asStoredNamespace('Water'), 'some-skill');

    const meta = skills.resetCounters(asStoredNamespace('Water'), 'some-skill');
    expect(meta).toEqual(
      expect.objectContaining({ successes: 0, failures: 0 })
    );
    const loaded = skills.loadFor(asStoredNamespace('Water')).find((s) => s.id === 'some-skill')!;
    expect(loaded.successes).toBe(0);
    expect(loaded.failures).toBe(0);
    expect(loaded.promotionRefusedAt).toBeUndefined();
  });

  it('returns null for a skill that does not exist', () => {
    expect(skills.resetCounters(asStoredNamespace('Water'), 'ghost')).toBeNull();
  });

  it('listNamespaces enumerates L1 folders (sorted), empty store yields []', () => {
    expect(skills.listNamespaces()).toEqual([]);
    skills.save(asStoredNamespace('Ammonia'), { id: 'a-skill', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    skills.save(asStoredNamespace('Water'), { id: 'b-skill', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    expect(skills.listNamespaces()).toEqual(['Ammonia', 'Water']);
  });
});

describe('anti-redispatch guard — a reproduced dispatch output routes to the LLM loop (epoch-5 run 5)', () => {
  it('same ctx, reworded subtask, fresh L2 instance: the byte-identical output is caught', async () => {
    // The $1.63 lesson, with the REAL replan shape: supervisor replans
    // build FRESH L2 instances and reword subtasks, so no instance/task
    // state survives — only the run context does. The guard keys on the
    // dispatch OUTPUT: a summary this run has already seen from this
    // skill means the deterministic re-run cannot answer the content
    // rejection that caused the retry.
    process.env['ATOMA_SKILL_DIRECT'] = '1';
    const dir = mkdtempSync(join(tmpdir(), 'atoma-redispatch-'));
    const skills = new SkillRegistry(dir);
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, { description: 'l2', systemPrompt: 'l2', tools: [], params: {}, createdBy: 't' });
    reg.create(1, { description: 'l1', systemPrompt: 'l1', tools: [], params: {}, createdBy: 't' });
    for (let i = 0; i < 3; i++) reg.recordSuccess('Water');
    saveCompiledScript(skills, nsOf(reg, 'Water'), {
      id: 'verify-stuff', description: 'd', whenToUse: 'w', language: 'node',
      body: 'console.log(JSON.stringify({output: "ok", summary: "done"}))',
    });
    for (let i = 0; i < 3; i++) skills.recordSuccess(nsOf(reg, 'Water'), 'verify-stuff');

    const executor = {
      has: () => true,
      declarations: () => [],
      execute: async (name: string) => {
        if (name === 'run_shell')
          return { stdout: JSON.stringify({ output: 'ok', summary: 'done' }) + '\n', exitCode: 0, stderr: '' };
        return { ok: true };
      },
    };
    const directEvents: SkillEventInfo[] = [];
    const ctx = {
      ...makeCtx(),
      tools: executor as never,
      recordSkill: (event: SkillEventInfo) => directEvents.push(event),
      jev: approvingJev(),
    };

    // Attempt 1: dispatch fires (2 prefilter calls only).
    const neuron1 = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'verify-stuff', confidence: 'high', reasoning: 'f' }));
    const first = await neuron1.handleDirect({ description: 'verify every documented command' }, ctx);
    expect(first.summary).toBe('done');
    expect(ctx.llm.calls).toHaveLength(2);
    expect(directEvents.filter((event) => event.op === 'direct')).toHaveLength(1);

    // Attempt 2 (upstream rejected the content → replan): FRESH instance,
    // reworded description, same ctx. The dispatch reproduces 'done' — the
    // guard catches it and the validated LLM loop runs instead.
    const neuron2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'verify-stuff', confidence: 'high', reasoning: 'f' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, {
      output: 'adapted',
      summary: 'did it differently this time',
    });
    const second = await neuron2.handleDirect(
      { description: 're-run EVERY command in the README verbatim' },
      ctx
    );
    expect(second.summary).toMatch(/differently/);
    expect(ctx.llm.calls.length).toBe(6); // the L1 loop actually ran
    // The duplicate script execution was discarded before credit/events.
    // Only the first accepted direct result is published as a direct success.
    expect(directEvents.filter((event) => event.op === 'direct')).toHaveLength(1);

    // A NEW run (fresh ctx): the guard resets, dispatch fires again.
    const ctx2 = { ...makeCtx(), tools: executor as never, jev: approvingJev() };
    const neuron3 = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    ctx2.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx2.llm.enqueueText(jsonText({ kind: 'reuse', target: 'verify-stuff', confidence: 'high', reasoning: 'f' }));
    const third = await neuron3.handleDirect({ description: 'verify commands' }, ctx2);
    expect(third.summary).toBe('done');
    expect(ctx2.llm.calls).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('deliverable gate — a script cannot report success for a file it never wrote', () => {
  // NOTE ON LAYERING (2026-08-11): the match-time capability test now refuses a
  // script whose PROVABLE write destinations miss the files a mutating subtask
  // names, so the provable case never reaches dispatch at all. This describe
  // therefore uses a body whose destination is UNPROVABLE — a runtime variable
  // — which is exactly the residual the gate is the last resort for. The two
  // layers hold OPPOSITE dispositions on purpose: refuse the match when the
  // mismatch is proven, dispatch-then-gate when it is not.
  //
  // The match-filter half is covered by unit tests in
  // tests/script-write-targets.test.ts, not end-to-end here. An end-to-end
  // version was written and DELETED: when the filter empties the catalogue
  // matchSkill short-circuits with no LLM call, so the mock's fixed enqueue
  // order shifts and the run dies on schema validation instead of on the
  // behaviour under test. It passed with the filter neutralised — i.e. it
  // proved nothing. Reinstate it only with a harness that can assert on the
  // catalogue itself rather than on a response queue.
  const OPAQUE_SCRIPT_BODY = `import fs from 'node:fs';\nconst target = process.argv[3];\nfs.writeFileSync(target, 'x');\nconsole.log(JSON.stringify({ output: { built: true }, summary: 'script ran clean' }));`;
  // MEASURED on the real compiled verifier: handed the subtask "Write a
  // README.md documenting the CLI usage", it replayed the manifest,
  // printed a valid envelope, exited 0 and wrote no README. This path
  // returns BEFORE superviseLoop, so no validator sees it, onFailed is
  // unreachable, and the phantom success entrenches the script — the
  // documented `document-cli-from-source` class, with no gate at all.
  const SEED2 = {
    description: 'orchestrator',
    systemPrompt: 'You are an L2.',
    tools: [],
    params: {},
    createdBy: 'test',
  };

  function fsExecutor(
    present: Record<string, string>,
    onRunShell?: (files: Record<string, string>) => void
  ): {
    executor: ToolExecutor;
    calls: Array<{ name: string; args: Record<string, unknown> }>;
  } {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const executor: ToolExecutor = {
      async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
        calls.push({ name, args });
        if (name === 'write_file') return { ok: true, path: args['path'] };
        if (name === 'run_shell') {
          onRunShell?.(present);
          return { exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' };
        }
        if (name === 'read_file') {
          const p = String(args['path']);
          if (p in present) return { content: present[p] };
          throw new Error(`ENOENT: ${p}`);
        }
        throw new Error(`unexpected tool: ${name}`);
      },
      has(name: string): boolean {
        return ['write_file', 'run_shell', 'read_file'].includes(name);
      },
    };
    return { executor, calls };
  }

  let dir2: string;
  let skills2: SkillRegistry;
  let reg2: AtomRegistry;
  let envBefore2: string | undefined;

  beforeEach(() => {
    dir2 = mkdtempSync(join(tmpdir(), 'atoma-deliv-gate-'));
    skills2 = new SkillRegistry(dir2);
    reg2 = new AtomRegistry(openDb(':memory:'));
    reg2.create(2, SEED2);
    reg2.create(1, { ...SEED2, description: 'builder', systemPrompt: 'You are an L1.' });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg2.recordSuccess('Water');
    saveCompiledScript(skills2, nsOf(reg2, 'Water'), {
      id: 'scaffold-config',
      description: 'write a canonical config file',
      whenToUse: 'when the subtask asks for the standard config scaffold',
      language: 'node',
      body: OPAQUE_SCRIPT_BODY,
    });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      skills2.recordSuccess(nsOf(reg2, 'Water'), 'scaffold-config');
    }
    envBefore2 = process.env['ATOMA_SKILL_DIRECT'];
    delete process.env['ATOMA_SKILL_DIRECT'];
  });
  afterEach(() => {
    rmSync(dir2, { recursive: true, force: true });
    if (envBefore2 === undefined) delete process.env['ATOMA_SKILL_DIRECT'];
    else process.env['ATOMA_SKILL_DIRECT'] = envBefore2;
  });

  function queuePrefilters(ctx: ReturnType<typeof makeCtx>): void {
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 's' })
    );
  }

  it('falls back to the LLM loop when the named deliverable is absent, crediting nothing', async () => {
    const { executor, calls } = fsExecutor({}); // README.md does NOT exist
    const neuron = L2Atom.fromType(reg2.getByName('Tracheid')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e) };
    queuePrefilters(ctx);
    // The fallback LLM loop then runs normally.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'wrote it properly' });

    await neuron.handleDirect(
      { description: 'Write a README.md documenting the CLI usage and options.' },
      ctx
    );

    // The script DID run (that is how we learn it produced nothing)…
    expect(calls.some((c) => c.name === 'run_shell')).toBe(true);
    // …but the deliverable was missing, so the LLM loop took over.
    expect(ctx.llm.calls.length).toBeGreaterThan(2);
    // The PHANTOM success never happened: no 'direct' event was emitted.
    // (The skill may still earn a success afterwards — from the validated
    // LLM loop it then drove, which is a real one.)
    expect(events.some((e) => e.op === 'direct')).toBe(false);
    // And NOT a directFailure either: the script is not broken, it was
    // matched to the wrong kind of subtask.
    expect(skills2.loadFor(nsOf(reg2, 'Water'))[0]!.directFailures ?? 0).toBe(0);
  });

  it('never OFFERS a read-only script for a write subtask — the round-7 filter', async () => {
    // Round 6: the compiled verifier was matched to three "update README.md"
    // subtasks and once to the code-edit subtask; the gate then caught it
    // after a wasted dispatch, five times in six runs, taking dispatches from
    // 10 to 1. Filtering the catalogue is cheaper and more precise than
    // rejecting the result.
    saveCompiledScript(skills2, nsOf(reg2, 'Water'), {
      id: 'readonly-verifier',
      description: 'replay recorded invocations',
      whenToUse: 'confirm a CLI still behaves as recorded',
      language: 'node',
      body: "import fs from 'node:fs';\nJSON.parse(fs.readFileSync('.atoma-probes.json','utf8'));\nconsole.log('{}');",
    });
    const { executor, calls } = fsExecutor({ 'README.md': 'old\n' });
    const neuron = L2Atom.fromType(reg2.getByName('Tracheid')!, reg2, [], skills2);
    const base = makeCtx();
    const ctx = { ...base, tools: executor };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    // The skill prefilter must not even be offered the read-only script; if
    // it were, this queued reply would name it and a dispatch would follow.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'nothing fits' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));

    await neuron
      .handleDirect({ description: 'update README.md to describe the new behaviour' }, ctx)
      .catch(() => undefined);

    // No scratch script was ever written: the dispatch never started.
    expect(calls.some((c) => ((c.args['path'] as string | undefined) ?? '').startsWith('_skill_'))).toBe(false);
  });

  it('falls back when the named file already existed and is byte-identical afterwards', async () => {
    // MEASURED, 2026-08-11 maintenance round: every file was seeded before the
    // run, so the existence check above is inert — the compiled verifier took
    // "update README.md …", printed a valid envelope, wrote nothing, and was
    // CREDITED. Seven of nine deliverables shipped a README asserting
    // `chars 36` about a CLI that prints 35.
    const { executor } = fsExecutor({ 'README.md': 'chars 36\n' }); // never rewritten
    const neuron = L2Atom.fromType(reg2.getByName('Tracheid')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e) };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'f' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));

    await neuron
      .handleDirect({ description: 'update README.md with the new behaviour' }, ctx)
      .catch(() => undefined);

    // The dispatch ran but was not credited: the LLM loop took over.
    expect(events.some((e) => e.op === 'direct')).toBe(false);
    expect(ctx.llm.calls.length).toBeGreaterThan(2);
  });

  it('does not require a named INPUT file to change when every output changed', async () => {
    // Live packaging run: "write package.json and README.md ... pointing at
    // pathcase.js". The deterministic script changed both outputs, but the
    // old gate snapshot every named path and rejected it because pathcase.js
    // correctly stayed byte-identical. Match-time target extraction already
    // distinguishes inputs; the after-dispatch gate must use the same rule.
    const files = {
      'pathcase.js': 'source stays unchanged\n',
      'package.json': '{"name":"old"}\n',
      'README.md': 'old docs\n',
    };
    const { executor } = fsExecutor(files, (present) => {
      present['package.json'] = '{"name":"pathcase"}\n';
      present['README.md'] = 'new docs\n';
    });
    const neuron = L2Atom.fromType(reg2.getByName('Tracheid')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e), jev: approvingJev() };
    queuePrefilters(ctx);

    const description =
      'write package.json for pathcase.js and write README.md using the verified invocations; no server, no browser, no index.html';
    expect(subtaskMutationTargets(description)).toEqual(['package.json', 'README.md']);
    await neuron.handleDirect({ description }, ctx);

    expect(ctx.llm.calls).toHaveLength(2);
    expect(events.some((e) => e.op === 'direct')).toBe(true);
    expect(files['pathcase.js']).toBe('source stays unchanged\n');
  });

  it('preserves full output paths instead of accepting a root basename write', async () => {
    const files = {
      'docs/README.md': 'stale nested docs\n',
      'README.md': 'stale root docs\n',
    };
    const { executor } = fsExecutor(files, (present) => {
      // Wrong destination: a basename-only gate used to accept this.
      present['README.md'] = 'new root docs\n';
    });
    const neuron = L2Atom.fromType(reg2.getByName('Tracheid')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e) };
    queuePrefilters(ctx);
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'fixed', summary: 'updated the nested docs' });

    await neuron.handleDirect({ description: 'update docs/README.md with current usage' }, ctx);

    expect(events.some((e) => e.op === 'direct')).toBe(false);
    expect(ctx.llm.calls.length).toBeGreaterThan(2);
    expect(files['docs/README.md']).toBe('stale nested docs\n');
  });

  it('falls back before dispatch when a mutating task names no output path', async () => {
    const { executor, calls } = fsExecutor({});
    const neuron = L2Atom.fromType(reg2.getByName('Tracheid')!, reg2, [], skills2);
    const base = makeCtx();
    const ctx = { ...base, tools: executor };
    queuePrefilters(ctx);
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'hardened it' });

    await neuron.handleDirect({ description: 'harden the existing CLI' }, ctx);

    expect(
      calls.some(
        (call) =>
          typeof call.args['path'] === 'string' &&
          call.args['path'].startsWith('_skill_')
      )
    ).toBe(false);
    expect(ctx.llm.calls.length).toBeGreaterThan(2);
  });

  it('does NOT gate a pure re-verification subtask, which writes nothing by design', async () => {
    // Rejecting these would send healthy dispatches back to the LLM loop.
    const { executor } = fsExecutor({ 'README.md': 'chars 36\n' });
    const neuron = L2Atom.fromType(reg2.getByName('Tracheid')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e), jev: approvingJev() };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'f' }));

    await neuron.handleDirect(
      { description: 'Re-execute every invocation documented in README.md and report whether each still matches' },
      ctx
    );

    expect(events.some((e) => e.op === 'direct')).toBe(true);
  });

  it('dispatches normally for a read-only check when the named file is present', async () => {
    const { executor } = fsExecutor({ 'config.json': '{}' });
    const neuron = L2Atom.fromType(reg2.getByName('Tracheid')!, reg2, [], skills2);
    const base = makeCtx();
    const ctx = { ...base, tools: executor, jev: approvingJev() };
    queuePrefilters(ctx);
    // No further LLM replies queued: the dispatch must NOT fall through.

    await neuron.handleDirect({ description: 'Verify config.json against the template.' }, ctx);

    expect(ctx.llm.calls).toHaveLength(2); // the two prefilters only
    expect(skills2.loadFor(nsOf(reg2, 'Water'))[0]!.successes).toBe(TRUST_THRESHOLD_SUCCESSES + 1);
  });

  it('keeps inherited literal-contract mutations out of the direct-dispatch gate', async () => {
    const { executor } = fsExecutor({ 'config.json': '{}' });
    const neuron = L2Atom.fromType(reg2.getByName('Tracheid')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = {
      ...base,
      tools: executor,
      recordSkill: (event: SkillEventInfo) => events.push(event),
      jev: approvingJev(),
    };
    queuePrefilters(ctx);

    await neuron.handleDirect(
      {
        description:
          'Verify config.json against the template and report the result.\n\n' +
          '== LITERAL CONTRACTS FROM TOP-LEVEL GOAL ==\n' +
          'A separate phase must update README.md.',
      },
      ctx
    );

    expect(ctx.llm.calls).toHaveLength(2);
    expect(events.some((event) => event.op === 'direct')).toBe(true);
  });

  it('does not require a file mentioned only in a read-only negation', async () => {
    const { executor } = fsExecutor({ 'config.json': '{}' });
    const neuron = L2Atom.fromType(reg2.getByName('Tracheid')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e), jev: approvingJev() };
    queuePrefilters(ctx);

    await neuron.handleDirect({
      description: 'Verify config.json against the template; no browser and no index.html.',
    }, ctx);

    expect(ctx.llm.calls).toHaveLength(2);
    expect(events.some((e) => e.op === 'direct')).toBe(true);
  });

  it('stays out of the way when the subtask names no file at all', async () => {
    const { executor } = fsExecutor({});
    const neuron = L2Atom.fromType(reg2.getByName('Tracheid')!, reg2, [], skills2);
    const base = makeCtx();
    const ctx = { ...base, tools: executor, jev: approvingJev() };
    queuePrefilters(ctx);

    await neuron.handleDirect({ description: 'Re-run the recorded invocations and report.' }, ctx);

    expect(ctx.llm.calls).toHaveLength(2);
    expect(skills2.loadFor(nsOf(reg2, 'Water'))[0]!.successes).toBe(TRUST_THRESHOLD_SUCCESSES + 1);
  });
});

describe('subtaskMutatesFiles — does the subtask ask for a file to CHANGE', () => {
  it('recognises the phrasing that shipped stale documentation', () => {
    // Verbatim from the 2026-08-11 maintenance round: the compiled verifier
    // took this subtask, printed a valid envelope, wrote nothing, and left a
    // README asserting `chars 36` about a CLI that now prints 35.
    expect(
      subtaskMutatesFiles(
        'Using the verdicts from the previous phase, update README.md so that only the invocations whose behaviour legitimately changed are corrected'
      )
    ).toBe(true);
  });

  it('recognises the other mutating verbs', () => {
    for (const v of ['rewrite', 'edit', 'fix', 'amend', 'revise', 'append', 'regenerate', 'refresh']) {
      expect(subtaskMutatesFiles(`${v} the README.md accordingly`)).toBe(true);
    }
  });

  it('does NOT fire on a pure re-verification, which legitimately writes nothing', () => {
    // Rejecting these would send healthy dispatches back to the LLM loop.
    expect(
      subtaskMutatesFiles(
        'Re-execute every invocation documented in README.md against the edited CLI and report whether each still matches'
      )
    ).toBe(false);
    expect(subtaskMutatesFiles('confirm the recorded exit codes still hold')).toBe(false);
    expect(subtaskMutatesFiles('replay the probe manifest and diff the outputs')).toBe(false);
  });


});

describe('a direct dispatch is validated, and a script set aside is not run again (2026-10-06)', () => {
  // Production, 2026-10-01 → 2026-10-03: the one compiled script
  // (`recheck-recorded-command-probes`) was matched six times in project runs.
  // It replays the probe manifest whatever its subtask asks; four times it
  // exited 0 on a phase that asked for more, and twice that replay was the
  // delivered result (947a21a2, 8738f263). Its one contract failure (822bb4fe)
  // was handed back to the L1 as "run it, do not improvise", and the L1 re-ran
  // it until the phase budget ran out. cc7ed6f1 did the same after the
  // anti-redispatch guard had set its output aside.
  const FALLBACK = 'FALLBACK-RECIPE: replay each recorded command and compare exit codes.';
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;
  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-direct-validated-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
    // A trusted molecule: its own loop needs no validator reply, so every
    // queued reply below is accounted for by the dispatch and its validation.
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Water');
    saveCompiledScript(skills, nsOf(reg, 'Water'), {
      id: 'scaffold-config',
      description: 'write a canonical config file',
      whenToUse: 'when the subtask asks for the standard config scaffold',
      language: 'node',
      body: SCRIPT_BODY,
      fallback: FALLBACK,
    });
    envBefore = process.env['ATOMA_SKILL_DIRECT'];
    delete process.env['ATOMA_SKILL_DIRECT'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env['ATOMA_SKILL_DIRECT'];
    else process.env['ATOMA_SKILL_DIRECT'] = envBefore;
  });

  const skill = () => skills.loadFor(nsOf(reg, 'Water')).find((s) => s.id === 'scaffold-config')!;
  const neuron = () => L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
  function queuePrefilters(ctx: { llm: MockLlmClient }): void {
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' }));
  }
  function queueMoleculeLoop(ctx: RunContext & { llm: MockLlmClient }, summary: string): void {
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done by the molecule', summary });
  }
  /** The L1 prompts of the molecule loop, after the prefilters and any validation. */
  const moleculePrompts = (ctx: { llm: MockLlmClient }) =>
    ctx.llm.calls.filter((call) => call.role === 'plan' || call.role === 'execute').map((call) => call.systemPrompt ?? '');

  it('the model validates the result when no Jev approves it, reading what the host observed the script do', async () => {
    const log = createAttestationLog();
    const { executor } = makeExecutor({ exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' });
    const events: SkillEventInfo[] = [];
    const ctx = {
      ...makeCtx(),
      attestations: log,
      tools: attestingExecutor(executor, log, undefined)!,
      recordSkill: (e: SkillEventInfo) => events.push(e),
    };
    queuePrefilters(ctx);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'the scaffold was written' }));

    const result = await neuron().handleDirect({ description: 'scaffold the config' }, ctx);

    expect(result.summary).toBe('script ran clean');
    expect(ctx.llm.calls.map((call) => call.role)).toEqual(['prefilter', 'prefilter', 'validate-result']);
    // The validator read the transport's record of the run, not just the envelope.
    expect(ctx.llm.calls[2]!.userContent).toContain('_skill_scaffold-config.mjs');
    expect(events.map((e) => e.op)).toEqual(['match', 'direct', 'success']);
    expect(skill().successes).toBe(1);
  });

  it('a Jev that does not approve leaves the decision to the model', async () => {
    const { executor } = makeExecutor({ exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' });
    const ctx = {
      ...makeCtx(),
      tools: executor,
      jev: { ...approvingJev(), approve: async () => ({ approved: false, probability: 0.3 }) },
    };
    queuePrefilters(ctx);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'fine' }));

    await neuron().handleDirect({ description: 'scaffold the config' }, ctx);

    expect(ctx.llm.calls.map((call) => call.role)).toEqual(['prefilter', 'prefilter', 'validate-result']);
    expect(skill().successes).toBe(1);
  });

  it('a refused result never stands: the molecule takes the phase with the reason, not the refused recipe, and nothing is credited (8738f263)', async () => {
    const { executor, calls } = makeExecutor({ exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' });
    const events: SkillEventInfo[] = [];
    const ctx = { ...makeCtx(), tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e) };
    queuePrefilters(ctx);
    ctx.llm.enqueueText(jsonText({
      approved: false,
      reasoning: 'only the recorded probes were replayed; the recomputation the phase asks for was not done',
      scope: 'ephemeral',
      modifications: {},
    }));
    queueMoleculeLoop(ctx, 'recomputed and audited');

    const result = await neuron().handleDirect(
      { description: 'scaffold the config and recompute every documented value' },
      ctx
    );

    expect(result.summary).toBe('recomputed and audited');
    expect(calls.filter((call) => call.name === 'run_shell' && call.args['command'] === 'node')).toHaveLength(2); // run + cleanup
    const [plan] = moleculePrompts(ctx);
    // The refusal's reason reaches the molecule; the replay it refused does not.
    expect(plan).toContain('the recomputation the phase asks for was not done');
    expect(plan).not.toContain(FALLBACK);
    expect(plan).not.toContain('== SCRIPT BODY ==');
    expect(events.map((e) => e.op)).toEqual(['match', 'set-aside']);
    expect(events[1]!.reasoning).toMatch(/^refused: /);
    // A content refusal is not a broken script: no counter moves.
    expect(skill()).toMatchObject({ kind: 'script', successes: 0, failures: 0 });
    expect(skill().directFailures).toBeUndefined();

    // The replan's re-dispatch reproduces the refused output: set aside by the
    // run's memo, with no second validation call.
    queuePrefilters(ctx);
    queueMoleculeLoop(ctx, 'second pass by the molecule');
    await neuron().handleDirect({ description: 'scaffold the config again and recompute' }, ctx);
    expect(ctx.llm.calls.filter((call) => call.role === 'validate-result')).toHaveLength(1);
  });

  it('a script whose contract failed is not handed back to the L1 to run again (822bb4fe)', async () => {
    const { executor } = makeExecutor({ exitCode: 1, stdout: '', stderr: 'Probe 10 mismatched: python3 .atoma-scratch/manifest-bad/verify.py' });
    const events: SkillEventInfo[] = [];
    const ctx = { ...makeCtx(), tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e) };
    queuePrefilters(ctx);
    queueMoleculeLoop(ctx, 'ran the documented commands');

    const result = await neuron().handleDirect({ description: 'scaffold the config' }, ctx);

    expect(result.summary).toBe('ran the documented commands');
    const prompts = moleculePrompts(ctx);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain(FALLBACK);
      expect(prompt).not.toContain('== SCRIPT BODY ==');
      expect(prompt).not.toMatch(/kind: script/);
    }
    // The streak still counts the contract failure; the molecule's success
    // is not the script's.
    expect(skill()).toMatchObject({ kind: 'script', successes: 0, failures: 0, directFailures: 1 });
    expect(events.map((e) => e.op)).toEqual(['match', 'set-aside', 'inject']);
    expect(events[1]!.reasoning).toMatch(/^contract: /);
  });

  it('the anti-redispatch guard hands the L1 neither the script nor its recipe (cc7ed6f1)', async () => {
    const { executor } = makeExecutor({ exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' });
    const ctx = { ...makeCtx(), tools: executor, jev: approvingJev() };
    queuePrefilters(ctx);
    await neuron().handleDirect({ description: 'scaffold the config' }, ctx);
    expect(skill().successes).toBe(1);

    queuePrefilters(ctx);
    queueMoleculeLoop(ctx, 'did it differently');
    const second = await neuron().handleDirect({ description: 'scaffold the config, reworded' }, ctx);

    expect(second.summary).toBe('did it differently');
    const [plan] = moleculePrompts(ctx);
    expect(plan).not.toContain(FALLBACK);
    expect(plan).not.toContain('== SCRIPT BODY ==');
    expect(skill().successes).toBe(1);
  });

  it('counts a deterministic phase below a tissue\'s read-only phase without crediting it (8738f263)', async () => {
    const { executor } = makeExecutor({ exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' });
    const events: SkillEventInfo[] = [];
    const stats: string[] = [];
    const ctx = {
      ...makeCtx(),
      tools: executor,
      jev: approvingJev(),
      recordSkill: (e: SkillEventInfo) => events.push(e),
      recordRunStat: (signal: string) => stats.push(signal),
    };
    queuePrefilters(ctx);

    const result = await neuron().handleDirect(
      { description: 'Audit the scaffold without changing anything.', readOnly: true },
      ctx
    );

    expect(result.summary).toBe('script ran clean');
    expect(events.map((e) => e.op)).toEqual(['match', 'direct', 'credit-withheld']);
    expect(events[1]!.reasoning).toMatch(/not credited: a read-only phase below a tissue/);
    expect(stats).toContain('deterministic');
    expect(skill()).toMatchObject({ successes: 0, failures: 0 });
  });
});

describe('the adversarial review of 2026-10-06, as regressions', () => {
  const REPLAY_ENVELOPE = JSON.stringify({ output: { replayed: 17 }, summary: 'all 17 recorded probes matched' });
  const REPLAY_BODY = `console.log(${JSON.stringify(REPLAY_ENVELOPE)});`;
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;
  const env: Record<string, string | undefined> = {};

  function fsExecutor(present: Record<string, string>, opts: { delayMs?: number; exit?: number } = {}): ToolExecutor {
    return {
      async execute(name, args) {
        if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
        if (name === 'write_file') return { ok: true, path: args['path'] };
        if (name === 'run_shell') {
          if (Array.isArray(args['args']) && args['args'][0] === '-e') return { exitCode: 0, stdout: '', stderr: '' };
          return { exitCode: opts.exit ?? 0, stdout: `${REPLAY_ENVELOPE}\n`, stderr: '' };
        }
        if (name === 'read_file') {
          const path = String(args['path']);
          if (path in present) return { content: present[path] };
          throw new Error(`ENOENT: ${path}`);
        }
        throw new Error(`unexpected tool: ${name}`);
      },
      has: (name) => ['write_file', 'run_shell', 'read_file'].includes(name),
    };
  }
  const lifecycle = () => new SkillLifecycle({
    name: 'Tracheid', model: 'm', params: {},
    toLlmRequest: (role, args) => ({ ...args, model: 'm', systemPrompt: 'sys', role, actor: { name: 'Tracheid', tier: 2 } }),
  }, skills);
  const observed = (outcome: Awaited<ReturnType<SkillLifecycle['runScriptSkillDirect']>>) =>
    (outcome.kind === 'ran' ? outcome.result.evidence ?? [] : [])
      .flatMap((witness) => witness.source === 'transport-observed' ? [`${witness.tool}: ${witness.observed}`] : []);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-review-regressions-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Water');
    for (const key of ['ATOMA_SKILL_DIRECT', 'ATOMA_SKILL_LEARN']) env[key] = process.env[key];
    delete process.env['ATOMA_SKILL_DIRECT'];
    saveCompiledScript(skills, nsOf(reg, 'Water'), { id: 'recheck', description: 'replay probes', whenToUse: 'recheck', body: REPLAY_BODY });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('the host\'s own reads are not filed as the script\'s evidence', async () => {
    const log = createAttestationLog();
    const ctx: RunContext = {
      ...makeCtx(),
      attestations: log,
      tools: attestingExecutor(fsExecutor({ 'README.md': '# optimums\nbest=42\n' }), log, undefined)!,
    };
    const outcome = await lifecycle().runScriptSkillDirect(skills.loadFor(nsOf(reg, 'Water'))[0]!, nsOf(reg, 'Water'), 'Water',
      { description: 'Recompute the optimums documented in README.md.' }, ctx, 'x');

    const lines = observed(outcome);
    expect(lines.some((line) => line.startsWith('run_shell') && line.includes('_skill_recheck.mjs'))).toBe(true);
    // The deliverable gate read README.md, and the cleanup ran: neither is the script's work.
    expect(lines.some((line) => line.startsWith('read_file'))).toBe(false);
    expect(lines.some((line) => line.includes('rmSync'))).toBe(false);
  });

  it('two dispatches sharing a lane do not read each other\'s runs', async () => {
    saveCompiledScript(skills, nsOf(reg, 'Water'), { id: 'beta', description: 'b', whenToUse: 'b', body: REPLAY_BODY });
    const [alpha, beta] = ['recheck', 'beta'].map((id) => skills.loadFor(nsOf(reg, 'Water')).find((s) => s.id === id)!);
    const log = createAttestationLog();
    const ctx: RunContext = { ...makeCtx(), attestations: log, currentBranchId: 'phase-lane',
      tools: attestingExecutor(fsExecutor({}, { delayMs: 5 }), log, 'phase-lane')! };
    const [a, b] = await Promise.all([
      lifecycle().runScriptSkillDirect(alpha!, nsOf(reg, 'Water'), 'Water', { description: 'recheck lane A' }, ctx, 'x'),
      lifecycle().runScriptSkillDirect(beta!, nsOf(reg, 'Water'), 'Water', { description: 'recheck lane B' }, ctx, 'x'),
    ]);

    expect(observed(a).some((line) => line.includes('_skill_recheck.mjs'))).toBe(true);
    expect(observed(a).some((line) => line.includes('_skill_beta'))).toBe(false);
    expect(observed(b).some((line) => line.includes('_skill_recheck'))).toBe(false);
  });

  it('a gate that rejects the script\'s result still rejects the molecule\'s, at no model cost', async () => {
    const ctx = { ...makeCtx(), tools: fsExecutor({ 'test-api.js': 'x' }) };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'recheck', confidence: 'high', reasoning: 'f' }));
    for (let i = 0; i < 6; i++) {
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      ctx.llm.enqueue((req) => {
        req.onToolInvocation?.({ name: 'run_shell', args: { command: 'node', args: ['test-api.js'] }, result: { exitCode: 1 }, durationMs: 1, startedAt: Date.now() });
        return { text: jsonText({ output: 'ran', summary: 'node test-api.js passes' }), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      });
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'looks fine' }));
    }

    await L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills)
      .handleDirect({ description: 'Run node test-api.js and confirm it passes.' }, ctx)
      .catch(() => undefined);

    // `required-command-manifest` refused the replay mechanically, then the
    // molecule's first result too: no validation call sits between them.
    expect(ctx.llm.calls.map((call) => call.role).slice(0, 5)).toEqual(['prefilter', 'prefilter', 'plan', 'execute', 'plan']);
  });

  it('a set-aside script does not open the verification extraction', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    const ctx = { ...makeCtx(), tools: fsExecutor({}, { exit: 1 }) };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'recheck', confidence: 'high', reasoning: 'f' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueue((req) => {
      req.onToolInvocation?.({ name: 'record_probe', args: { cmd: 'node cli.js' }, result: { recorded: true, exitCode: 0 }, durationMs: 1, startedAt: Date.now() });
      return { text: jsonText({ output: 'ok', summary: 'replayed the recorded probes' }), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });

    await L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills).handleDirect({ description: 'Recheck the recorded invocations.' }, ctx);

    expect(ctx.llm.calls.map((call) => call.role)).not.toContain('skill');
    expect(skills.loadFor(nsOf(reg, 'Water')).map((s) => s.id)).toEqual(['recheck']);
  });

  it('an uncredited direct result does not swallow a later success in its lane', () => {
    const signatures = deriveTrajectorySignatures('r', [
      { kind: 'skill', id: 's1', op: 'direct', l1Name: 'Water', skillId: 'S', branchId: 'B' },
      { kind: 'skill', id: 's2', op: 'credit-withheld', l1Name: 'Water', skillId: 'S', branchId: 'B' },
      { kind: 'skill', id: 's3', op: 'inject', l1Name: 'Water', skillId: 'S', branchId: 'B' },
      { kind: 'branch', id: 'b1', op: 'start', branchId: 'C', parentBranchId: 'B' },
      { kind: 'tool', id: 't1', llmEventId: 'L1', name: 'run_shell', actor: { name: 'Water', tier: 1 }, branchId: 'C' },
      { kind: 'llm', id: 'L1', actor: { name: 'Water', tier: 1 }, branchId: 'C' },
      { kind: 'skill', id: 's4', op: 'success', l1Name: 'Water', skillId: 'S', branchId: 'B' },
    ]);
    expect(signatures[0]!.credited).toBe(true);
  });
});
