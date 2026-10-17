import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mockOtherProofReview } from './helpers/delegationReview.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { acceptRootResult } from '../src/atoms/rootAcceptance.js';
import { Atom, type Supervisor } from '../src/core/atom.js';
import { createAttestationLog } from '../src/core/attestation.js';
import { superviseLoop, normalizeReason, type SupervisionHooks } from '../src/core/supervisor.js';
import { spentPhaseResult } from '../src/core/phaseBudget.js';
import {
  SUITE_DISPUTE_MIN_OBSERVATIONS,
  SUITE_DISPUTE_MIN_SUBJECTS,
  parentTestRejection,
  taskSuiteDispute,
} from '../src/core/parentTests.js';
import { snapshotProject } from '../src/tools/parentTests.js';
import {
  parentTestObservationSchema,
  parentTestSuiteDigest,
  persistedParentTests,
  type HeldParentTestObservation,
  type ParentTestSuite,
} from '../src/contracts/parentTests.js';
import {
  parentTestRowSchema,
  persistedParentTestReaderSchema,
  persistedParentTestSchema,
  summarizeParentTests,
} from '../src/contracts/parentTestRecord.js';
import { runStatsSchema, type RunStatSignal } from '../src/contracts/runStats.js';
import type { AcceptanceInfo } from '../src/contracts/depthRouting.js';
import { isLanded } from '../src/contracts/runLanding.js';
import { runDepthTask } from '../src/run/depth.js';
import type { LlmCompletionRequest, Plan, Result, RunContext, Task, Tier, ToolExecutor, Verdict } from '../src/core/types.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { jsonText, jsonTextPair, makeCtx, silentLogger } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';

/**
 * A SUITE DISPUTE, detection only (2026-10-17). Run 2e6bdcfc's parent suite
 * carried a regular expression escaped twice: it failed byte for byte on every
 * run, across several implementations, spent a retry ladder and a root
 * acceptance, and nobody named the suite. A suite that fails with the same
 * assertions on several versions of the workspace is now counted, logged and
 * named in one host line where the failure is handed up; nothing is routed
 * differently.
 */

const SUITE: ParentTestSuite = {
  requirement: 'npm run test:browser forwards caller arguments before every browser suite path',
  cwd: '.',
  source: "import { test, expect } from 'vitest';\nimport pkg from './package.json';\ntest('forwards', () => {\n  expect(pkg.scripts['test:browser']).toMatch(/!\\\\s+-name/);\n});",
};
const DIGEST = parentTestSuiteDigest(SUITE);
const TASK: Task = { description: 'repair only package.json scripts', acceptanceTests: SUITE };

/** The runner's details for 2e6bdcfc's failure, as recorded; the host note varies, the failing set does not. */
function incidentDetails(note = 'Host: the snapshot skipped 3 unreachable entries'): string {
  return JSON.stringify([
    note,
    '',
    {
      name: 'browser script forwards caller arguments before all browser suite paths',
      status: 'failed',
      failures: ["AssertionError: expected 'sh -c \\'npm run build && vitest run \"…' to match /!\\\\s+-name\\\\s+['\\\"]xe-browser-local-h…/\n" +
        '    at Proxy.<anonymous> (/app/dist/tools/parentTestSetup.js:388:24)\n    at ./atoma.acceptance.test.ts:11:20'],
    },
    { name: 'chromium entry has typed CommonJS dependency calls and no ESM syntax', status: 'passed', failures: [] },
  ]);
}

const OTHER_DETAILS = JSON.stringify(['', { name: 'browser script forwards caller arguments before all browser suite paths', status: 'failed',
  failures: ['AssertionError: expected [] to include \'tests/xe-chromium.test.ts\''] }]);

let clock = 1_000;
function failed(subjectDigest: string | undefined, details = incidentDetails(), suiteDigest = DIGEST): HeldParentTestObservation {
  clock += 1;
  return {
    suiteDigest, workspaceDigest: `w${clock}`, ...(subjectDigest !== undefined ? { subjectDigest } : {}),
    status: 'failed', cause: 'ran', passed: 1, failed: 1, skipped: 0, details, observedAt: clock,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('B1: subjectDigest, from the real snapshot', () => {
  function write(root: string, relative: string, content: string): void {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }

  it('ignores the probe manifest and installs and caches, and follows package.json and source', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'atoma-subject-')));
    const copies = mkdtempSync(path.join(tmpdir(), 'atoma-subject-copies-'));
    dirs.push(root, copies);
    let copy = 0;
    const snapshot = () => snapshotProject(root, path.join(copies, String(copy++)), new AbortController().signal);
    write(root, 'package.json', JSON.stringify({ type: 'module', scripts: { 'test:browser': 'vitest run tests/a.test.js' } }));
    write(root, 'src/add.ts', 'export const add = (a: number, b: number): number => a + b;\n');
    write(root, 'node_modules/vitest/package.json', '{"name":"vitest"}');
    write(root, 'node_modules/.vite/deps/_metadata.json', '{"hash":"1"}');
    const first = await snapshot();
    expect(first.subjectDigest).toMatch(/^[0-9a-f]{64}$/);

    // Host artefacts at the root: a probe record and a saved response body.
    write(root, '.atoma-probes.json', JSON.stringify({ probes: [{ cmd: 'npm test', exitCode: 1 }] }));
    write(root, '.atoma-http/body-1.txt', 'saved');
    const probed = await snapshot();
    expect(probed.digest).not.toBe(first.digest);
    expect(probed.subjectDigest).toBe(first.subjectDigest);

    // A Vite cache and an install, at the root and in a nested package.
    write(root, 'node_modules/.vite/deps/_metadata.json', '{"hash":"2"}');
    write(root, 'node_modules/.vite/deps/chunk-a.js', 'export {};\n');
    write(root, 'packages/web/node_modules/.vite/deps/_metadata.json', '{"hash":"3"}');
    const cached = await snapshot();
    expect(cached.digest).not.toBe(probed.digest);
    expect(cached.subjectDigest).toBe(first.subjectDigest);

    // What the code under test is made of.
    write(root, 'package.json', JSON.stringify({ type: 'module', scripts: { 'test:browser': 'vitest run "$@" tests/a.test.js' } }));
    const scripts = await snapshot();
    expect(scripts.subjectDigest).not.toBe(first.subjectDigest);
    write(root, 'src/add.ts', 'export const add = (a: number, b: number): number => b + a;\n');
    const source = await snapshot();
    expect(source.subjectDigest).not.toBe(scripts.subjectDigest);
    // Only ROOT `.atoma*` names are host artefacts: one inside the project is project content.
    write(root, 'src/.atoma-notes.json', '{}');
    expect((await snapshot()).subjectDigest).not.toBe(source.subjectDigest);
  });
});

describe('B2: taskSuiteDispute, on typed observations', () => {
  it('needs three failures with one failing set over at least two versions of the workspace', () => {
    expect(SUITE_DISPUTE_MIN_OBSERVATIONS).toBe(3);
    expect(SUITE_DISPUTE_MIN_SUBJECTS).toBe(2);
  });

  it('three failures on one implementation: no dispute', () => {
    expect(taskSuiteDispute(TASK, [failed('a'), failed('a'), failed('a')])).toBeNull();
  });

  it('three failures on three implementations: a dispute, whatever host notes the runner added', () => {
    const dispute = taskSuiteDispute(TASK, [failed('a', incidentDetails('Host: one')), failed('b', incidentDetails('Host: two')), failed('c')]);
    expect(dispute).toMatchObject({ suiteDigest: DIGEST, observations: 3, subjects: 3 });
    // The key is the repeat key's text: the failing set, never the host notes.
    const reasoning = parentTestRejection({ parentTests: [failed('a')] })!.reasoning;
    expect(reasoning).toContain(dispute!.excerpt);
  });

  it('two failures: no dispute', () => {
    expect(taskSuiteDispute(TASK, [failed('a'), failed('b')])).toBeNull();
  });

  it('different failing sets: no dispute', () => {
    expect(taskSuiteDispute(TASK, [failed('a'), failed('b', OTHER_DETAILS), failed('c')])).toBeNull();
  });

  it('counts only this suite\'s failed runs that name a version, each once', () => {
    const counted = failed('a');
    const others: HeldParentTestObservation[] = [
      failed('b', incidentDetails(), 'f'.repeat(64)),
      { ...failed('c'), status: 'passed', failed: 0, passed: 2 },
      { ...failed('d'), status: 'unavailable', cause: 'timeout' },
      failed(undefined),
      counted,
      { ...counted },
    ];
    expect(taskSuiteDispute(TASK, [counted, failed('e'), ...others])).toBeNull();
    const withoutSuite: Task = { description: TASK.description };
    expect(taskSuiteDispute(withoutSuite, [failed('a'), failed('b'), failed('c')])).toBeNull();
  });

  it('2e6bdcfc: three attempts that edited nothing, then three implementations', () => {
    const attempts = ['a', 'a', 'a', 'b', 'c', 'd'].map((subject) => failed(subject));
    expect(taskSuiteDispute(TASK, attempts.slice(0, 3))).toBeNull();
    expect(taskSuiteDispute(TASK, attempts)).toMatchObject({ observations: 6, subjects: 4 });
  });

  it('names the failing set that failed last when two qualify', () => {
    const other = ['a', 'b', 'c'].map((subject) => failed(subject, OTHER_DETAILS));
    const incident = ['d', 'e', 'f'].map((subject) => failed(subject));
    expect(taskSuiteDispute(TASK, [...other, ...incident])!.excerpt).toBe(taskSuiteDispute(TASK, incident)!.excerpt);
    expect(taskSuiteDispute(TASK, [...incident, ...other])!.excerpt).toBe(taskSuiteDispute(TASK, other)!.excerpt);
  });
});

/** A tier-1 or tier-2 stand-in: every plan and result approved, so every refusal below is the host's typed mapping. */
class Stand extends Atom implements Supervisor<Stand> {
  readonly model = 'mock';
  constructor(readonly tier: Tier, name: string) {
    super({ name, ordinal: 0, systemPrompt: '', tools: [], params: {} });
  }
  async plan(): Promise<Plan> {
    return makePlan();
  }
  async execute(): Promise<Result> {
    return { output: this.name, summary: this.name, trace: [], producedBy: { tier: this.tier, name: this.name, viaFallback: false } };
  }
  async validatePlan(): Promise<Verdict> {
    return { approved: true, reasoning: 'plan reviewed' };
  }
  async validateResult(): Promise<Verdict> {
    return { approved: true, reasoning: 'semantic review' };
  }
}

/** The fixed runner's shell: every run of the suite fails the same way, on the version `subjects` names. */
function runner(subjects: readonly (string | undefined)[]): ToolExecutor & { readonly calls: () => number } {
  let call = 0;
  return {
    calls: () => call,
    has: (name) => name === 'run_shell',
    execute: async () => {
      const subject = subjects[call];
      call += 1;
      return {
        suiteDigest: DIGEST, workspaceDigest: `w${call}`, ...(subject !== undefined ? { subjectDigest: subject } : {}),
        status: 'failed', cause: 'ran', passed: 1, failed: 1, skipped: 0, details: incidentDetails(`Host: run ${call}`),
      };
    },
  };
}

async function supervise(subjects: readonly (string | undefined)[], shared?: Set<string>) {
  const stats: RunStatSignal[] = [];
  const warnings: string[] = [];
  const tools = runner(subjects);
  const ctx: RunContext = {
    ...makeCtx({ logger: { ...silentLogger(), warn: (message) => { warnings.push(message); } } }),
    tools,
    recordRunStat: (signal) => { stats.push(signal); },
    ...(shared ? { mechanicalResultRejections: shared } : {}),
  };
  const onFailed = vi.fn(async () => {});
  const branchOnEscalation = vi.fn(async () => new Stand(1, 'Branched'));
  const hooks: SupervisionHooks<Stand> = { applyByScope: async (child) => child, branchOnEscalation, onFailed };
  const result = await superviseLoop(new Stand(2, 'Cell'), new Stand(1, 'Molecule'), TASK, ctx, hooks);
  const routing = result.trace.map((entry) => `${entry.kind}:${entry.atom}`);
  const reasonings = result.trace.filter((entry) => entry.kind === 'verdict-result').map((entry) => (entry.payload as Verdict).reasoning);
  const streakKeys = result.trace.filter((entry) => entry.kind === 'repeat-rejection').map((entry) => (entry.payload as { streakKey: string }).streakKey);
  const failures = (onFailed.mock.calls as unknown as [Stand, string, Verdict | undefined][])
    .map(([child, reason, verdict]) => [child.name, reason, verdict?.reasoning]);
  const disputeWarning = (message: string): boolean => message.startsWith('[parent-tests] suite dispute');
  return { result, stats, failures, branchOnEscalation, runs: tools.calls(), routing, reasonings, streakKeys,
    warnings: warnings.filter(disputeWarning), otherWarnings: warnings.filter((message) => !disputeWarning(message)) };
}

const SPENT = ['a', 'a', 'a', 'b', 'c', 'd', 'e'];

describe('B3: surfacing in superviseLoop, routing unchanged', () => {
  it('records the failure, branches and falls back exactly as without a dispute; counts and logs it once', async () => {
    const disputed = await supervise(SPENT);
    const control = await supervise(SPENT.map(() => 'a'));
    const older = await supervise(SPENT.map(() => undefined));

    for (const run of [control, older]) {
      expect(disputed.routing).toEqual(run.routing);
      expect(disputed.reasonings).toEqual(run.reasonings);
      expect(disputed.streakKeys).toEqual(run.streakKeys);
      expect(disputed.runs).toBe(run.runs);
      expect(disputed.otherWarnings).toEqual(run.otherWarnings);
      expect(disputed.failures).toEqual(run.failures);
      expect(disputed.branchOnEscalation.mock.calls.length).toBe(run.branchOnEscalation.mock.calls.length);
      expect(disputed.result.producedBy).toEqual(run.result.producedBy);
      expect(disputed.result.spentLadder).toEqual(run.result.spentLadder);
    }
    // Three tries, a branch's three, the cell's fallback: the ladder as it is today.
    expect(disputed.runs).toBe(7);
    expect(disputed.failures.map(([name, reason]) => [name, reason])).toEqual([['Molecule', 'escalation-repeat'], ['Branched', 'escalation-repeat']]);
    expect(disputed.routing.filter((step) => step.startsWith('branch-retry'))).toHaveLength(1);
    expect(disputed.result.producedBy.viaFallback).toBe(true);
    expect(disputed.result.spentLadder).toEqual({ by: 'Cell', on: [TASK.description] });

    // The repeat key stays the failing excerpt: no host line ever enters a verdict.
    const reasoning = parentTestRejection({ parentTests: [failed('z')] })!.reasoning;
    expect(disputed.streakKeys).toEqual([normalizeReason(reasoning), normalizeReason(reasoning)]);
    expect(disputed.reasonings.every((text) => text === reasoning)).toBe(true);

    // Found where the loop escalated the second time: 6 runs over a, b, c, d.
    expect(disputed.stats).toEqual(['escalation', 'escalation', 'suite-dispute']);
    expect(control.stats).toEqual(['escalation', 'escalation']);
    expect(older.stats).toEqual(['escalation', 'escalation']);
    expect(disputed.warnings).toHaveLength(1);
    expect(disputed.warnings[0]).toContain(`suite dispute: suite ${DIGEST.slice(0, 16)} for "${TASK.description}"`);
    expect(disputed.warnings[0]).toContain('on 4 versions of the workspace over 6 attempts');
    expect(control.warnings).toEqual([]);
    // The fallback's observation is returned as verified: nothing is added to it.
    expect(disputed.result.parentTests).toEqual([expect.objectContaining({ suiteDigest: DIGEST, subjectDigest: 'e', status: 'failed' })]);
    expect(Object.keys(disputed.result.parentTests![0]!).sort()).toEqual(Object.keys(control.result.parentTests![0]!).sort());
  });

  // Review 2026-10-17: a host line reached every model call of the next pass
  // and invited children under a correct suite to contest it. Measured only.
  it('shows no model anything: the spent-ladder hand-up reads as without a dispute', async () => {
    const disputed = await supervise(SPENT);
    const control = await supervise(SPENT.map(() => 'a'));
    const refusal = parentTestRejection(disputed.result)!.reasoning;
    const handedUp = spentPhaseResult(disputed.result, refusal);
    expect(handedUp.summary).toBe(spentPhaseResult({ ...control.result, summary: disputed.result.summary }, refusal).summary);
    expect(handedUp.summary).not.toContain('SUITE DISPUTE');
  });

  it('counts a suite at most once per attempt: a later loop over the same suite does not', async () => {
    const attempt = new Set<string>();
    const first = await supervise(SPENT, attempt);
    const again = await supervise(SPENT, attempt);
    expect(first.stats).toContain('suite-dispute');
    expect(again.stats).toEqual(['escalation', 'escalation']);
    expect(again.warnings).toEqual([]);
    expect(again.routing).toEqual(first.routing);
  });

  it('fails open: a fault while surfacing is logged and leaves the ladder as it is', async () => {
    const broken = new Set<string>();
    broken.has = () => { throw new Error('memo unavailable'); };
    const faulted = await supervise(SPENT, broken);
    const control = await supervise(SPENT.map(() => 'a'));
    expect(faulted.routing).toEqual(control.routing);
    expect(faulted.failures).toEqual(control.failures);
    expect(faulted.runs).toBe(control.runs);
    expect(faulted.result.spentLadder).toEqual(control.result.spentLadder);
    expect(faulted.stats).toEqual(['escalation', 'escalation']);
    expect(faulted.warnings).toEqual([expect.stringContaining('suite dispute detection failed; nothing counted: Error: memo unavailable')]);
  });
});

/** The run's root actor where the test supplies the result itself. */
class RootActor extends Atom implements Supervisor<RootActor> {
  readonly model = 'test';
  readonly tier = 3 as const;
  constructor() {
    super({ name: 'actor-3', ordinal: 1, systemPrompt: '', tools: makeTools(['read_file']), params: {} });
  }
  async plan(): Promise<Plan> {
    return makePlan();
  }
  async execute(): Promise<Result> {
    return { output: null, summary: 'root', trace: [], producedBy: { tier: 3, name: 'actor-3', viaFallback: false } };
  }
  async validatePlan(): Promise<Verdict> {
    return { approved: true, reasoning: 'fixture' };
  }
  async validateResult(): Promise<Verdict> {
    return { approved: true, reasoning: 'fixture' };
  }
}

describe('B3: what root acceptance refuses with, which the remediation pass reads', () => {
  const rootCtx = () => ({ ...makeCtx(), tools: { has: () => false, execute: async () => ({}) } as ToolExecutor, attempt: 1,
    attestations: createAttestationLog() });

  it('leaves the mechanical refusal the remediation pass reads as it was', async () => {
    const disputed = await supervise(SPENT);
    const ctx = rootCtx();
    const accepted = await acceptRootResult({ actor: new RootActor(), task: { description: 'Restore the scripts' }, result: disputed.result, ctx, floor: [], phaseCoverage: [] });
    expect(accepted.approved).toBe(false);
    expect(accepted.basis).toBe('mechanical');
    expect(ctx.llm.calls).toHaveLength(0);
    expect(accepted.reasoning).toBe(parentTestRejection(disputed.result)!.reasoning);
    expect(accepted.reasoning).not.toContain('SUITE DISPUTE');
  });
});

describe('B3: through the real tissue, cell and molecules, with root acceptance and its one extra pass', () => {
  const ok = (text: string) => ({ text, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } });
  const seed = { description: 'orchestrator', systemPrompt: 'You are an L2.', tools: [], params: {}, createdBy: 'test' };
  const phase = 'restore the browser scripts';
  const leaf = 'repair only package.json scripts';

  async function run(subjectOf: (call: number) => string) {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(3, { ...seed, description: 'tissue', systemPrompt: 'You are an L3.' });
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
    const tissue = L3Atom.buildWithModel(reg.listByTier(3)[0]!, reg, FALLBACK_OPUS);
    let suiteRuns = 0;
    const tools: ToolExecutor = {
      has: (name) => name === 'run_shell',
      execute: async (name, args) => {
        if (name !== 'run_shell' || args['command'] !== 'atoma-verify') return {};
        const suite = JSON.parse((args['args'] as string[])[0]!) as ParentTestSuite;
        const call = suiteRuns++;
        return {
          suiteDigest: parentTestSuiteDigest(suite), workspaceDigest: `w${call}`, subjectDigest: subjectOf(call),
          status: 'failed', cause: 'ran', passed: 1, failed: 1, skipped: 0, details: incidentDetails(),
        };
      },
    };
    const rootPlan: Plan = { reasoning: 'one phase', subtasks: [{ description: phase, preferredChild: 'Tracheid' }], aggregation: { mode: 'sequential' }, expectedOutput: 'scripts' };
    const cellPlan: Plan = { reasoning: 'one file', subtasks: [{ description: leaf, preferredChild: 'Water', acceptanceTests: SUITE }], aggregation: { mode: 'concat' }, expectedOutput: 'package.json' };
    let executions = 0;
    const respond = (req: LlmCompletionRequest) => {
      const tier = req.actor?.tier;
      if (req.role === 'prefilter') return ok(jsonText({ kind: 'escalate', reasoning: 'no match' }));
      if (req.role === 'plan' && tier === 3) return ok(jsonTextPair({ strategy: 'reuse', target: 'Tracheid', reasoning: 'r' }, rootPlan));
      if (req.role === 'plan' && tier === 2) return ok(jsonTextPair({ strategy: 'reuse', target: 'Water', reasoning: 'r' }, cellPlan));
      if (req.role === 'plan' || req.role === 'fallback-plan') return ok(jsonText({ reasoning: 'r', proposedAction: 'edit it', expectedOutput: 'files' }));
      if (req.role === 'execute' || req.role === 'fallback-execute') return ok(jsonText({ output: { done: true }, summary: `execution ${++executions}` }));
      if (req.role === 'validate-plan') return ok(jsonText({ approved: true, reasoning: 'fine', ...mockOtherProofReview(req) }));
      return ok(jsonText({ approved: true, reasoning: 'reviewed and approved' }));
    };
    const stats: RunStatSignal[] = [];
    const ctx: RunContext & { llm: ReturnType<typeof makeCtx>['llm'] } = { ...makeCtx(), tools, recordRunStat: (signal) => { stats.push(signal); } };
    for (let i = 0; i < 800; i++) ctx.llm.enqueue(respond);
    const tasks: Task[] = [];
    const passes: Result[] = [];
    const acceptances: AcceptanceInfo[] = [];
    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Restore the browser scripts' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onApproved: vi.fn(), onAcceptance: (acceptance) => { acceptances.push(acceptance); },
      createExecutor: () => ({
        actor: tissue,
        handle: async (task: Task, passCtx: RunContext) => {
          tasks.push(task);
          const result = await tissue.handle(task, passCtx);
          passes.push(result);
          return result;
        },
      }),
    });
    const prompts = ctx.llm.calls.map((req) => `${req.systemPrompt}\n${req.userContent}`);
    return { outcome, tasks, passes, acceptances, stats, suiteRuns, prompts,
      calls: ctx.llm.calls.map((req) => `${req.role}:${req.actor?.name ?? ''}`) };
  }

  it('counts once with the control\'s routing, and no model call, hand-up or refusal carries a line', async () => {
    const disputed = await run((call) => `version-${call}`);
    const control = await run(() => 'version-0');

    // Routing unchanged at every tier: the same calls, in the same order, and the same suite runs.
    expect(disputed.calls).toEqual(control.calls);
    expect(disputed.suiteRuns).toBe(control.suiteRuns);
    expect(disputed.acceptances.map((acceptance) => acceptance.basis)).toEqual(['mechanical', 'mechanical']);
    expect(control.acceptances.map((acceptance) => acceptance.basis)).toEqual(['mechanical', 'mechanical']);
    expect(isLanded(disputed.outcome)).toBe(true);

    // Counted once in the attempt, though the extra pass met the same suite again.
    expect(disputed.stats.filter((signal) => signal === 'suite-dispute')).toHaveLength(1);
    expect(control.stats).not.toContain('suite-dispute');
    expect(runStatsSchema.parse({ outcome: 'partial', costUsd: 0, llmCalls: 0, opusCalls: 0, sonnetCalls: 0, haikuCalls: 0, otherCalls: 0,
      deterministicPhases: 0, escalations: 0, learnedSkills: 0, learnedEventSkills: 0, promotions: 0, refusals: 0, compileErrors: 0,
      demotions: 0, dispatchFallbacks: 0 }).suiteDisputes).toBe(0);

    // Measured only: the same calls as the control's (above), and no prompt,
    // hand-up or refusal names the dispute. (The prompts' trace windows differ
    // by this fixture's own subject digests, so they are not compared whole.)
    expect(disputed.prompts).toHaveLength(control.prompts.length);
    for (const text of [...disputed.prompts, ...disputed.passes.map((result) => result.summary),
      ...disputed.acceptances.map((acceptance) => acceptance.reasoning)]) {
      expect(text).not.toContain('SUITE DISPUTE');
    }
  }, 60_000);
});

describe('B4: older records and replies', () => {
  const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    suiteDigest: 'a'.repeat(64), workspaceDigest: 'b'.repeat(64), status: 'failed', cause: 'ran',
    passed: 1, failed: 1, skipped: 0, requirement: 'adds', details: '[]', ...overrides,
  });

  it('reads a record written before subjectDigest, and keeps a row whose subjectDigest is malformed', () => {
    expect(persistedParentTestSchema.strict().safeParse(record()).success).toBe(true);
    expect(persistedParentTestReaderSchema.safeParse(record()).success).toBe(true);
    const malformed = persistedParentTestReaderSchema.safeParse(record({ subjectDigest: 42 }));
    expect(malformed.success).toBe(true);
    expect(malformed.data?.subjectDigest).toBeUndefined();
    const summary = summarizeParentTests({ parentTests: [record(), record({ subjectDigest: 42 }), record({ subjectDigest: 'c'.repeat(64) })] },
      { rows: 12, requirementChars: 300, detailsChars: 600, detailRows: 6 });
    expect(summary.records.invalid).toBe(0);
  });

  it('parses an older worker reply without subjectDigest, and the strict reply with it', () => {
    const reply = { suiteDigest: DIGEST, workspaceDigest: 'w', status: 'failed', cause: 'ran', passed: 0, failed: 1, skipped: 0, details: '[]' };
    expect(parentTestObservationSchema.safeParse(reply).success).toBe(true);
    expect(parentTestObservationSchema.safeParse({ ...reply, subjectDigest: 's'.repeat(64) }).success).toBe(true);
    expect(parentTestObservationSchema.safeParse({ ...reply, dispute: { task: 't', observations: 3, subjects: 3 } }).success).toBe(false);
  });

  it('persists subjectDigest, and leaves the display rows as they were', async () => {
    const disputed = await supervise(SPENT);
    const [persisted] = persistedParentTests(disputed.result.parentTests!);
    expect(persisted).toMatchObject({ subjectDigest: 'e', suiteDigest: DIGEST });
    expect(persistedParentTestSchema.strict().safeParse(persisted).success).toBe(true);
    const [row] = summarizeParentTests({ parentTests: [persisted] }, { rows: 12, requirementChars: 300, detailsChars: 600, detailRows: 6 }).observations;
    expect(parentTestRowSchema.strict().safeParse(row).success).toBe(true);
    expect(row).not.toHaveProperty('subjectDigest');
  });
});
