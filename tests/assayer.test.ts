import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatRunStatsEpilogue, type RunStats } from '../src/contracts/runStats.js';
import { skillAssayRecordSchema, type AssayCaseResult } from '../src/contracts/skillAssay.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { acquireRunLeaseWithoutRecovery } from '../src/mcp/runLock.js';
import { PlatformEventLog } from '../src/platform/events.js';
import { SkillRegistry } from '../src/skills/registry.js';
import {
  armEnvironment,
  armMatchedRecipe,
  assayCases,
  assayNext,
  judgeAssay,
  pendingAssays,
  runAssay,
  surfaceDigestOf,
  type ArmLaunch,
  type AssayerOptions,
} from '../src/supervisor/assayer.js';
import { startResidentAssayer, vizAssayerEnabled } from '../src/supervisor/residentAssayer.js';

/**
 * STAGE 4, THE ASSAYER, with a fake runner in place of `npm run run:build`.
 * What these hold: the pre-registered judgement; which recipes are pending;
 * that every arm runs on COPIES with learning off and the `without` copy
 * lacks the recipe; that the record, the store row and the journal row carry
 * the facts; that a retirement reaches the live catalog and nothing else
 * does; that an active run or a held lease refuses; that a dry run spends
 * nothing; and the resident shell's pause and preemption.
 */

const NS = 'atom-assay-1';
const dirs: string[] = [];
afterEach(() => {
  closeStoreHandles();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stats(outcome: RunStats['outcome'], costUsd = 0.1): RunStats {
  return {
    outcome, costUsd, llmCalls: 3, opusCalls: 0, sonnetCalls: 1, haikuCalls: 2, otherCalls: 0,
    deterministicPhases: 0, escalations: 0, learnedSkills: 0, learnedEventSkills: 0, promotions: 0,
    refusals: 0, compileErrors: 0, demotions: 0, dispatchFallbacks: 0, uncoveredObligations: 0,
    deepenings: 0, rootRemediations: 0, landingRemediations: 0, unjudgedRemediations: 0, discardedLessons: 0, triggerRejections: 0, suiteDisputes: 0, landingReasons: [],
  };
}

function arm(outcome: RunStats['outcome'], matched: boolean, which: 'with' | 'without' = 'with', costUsd = 0.1): AssayCaseResult['with'] {
  return { arm: which, outcome, costUsd, durationS: null, llmCalls: 3, matched, traceId: 't', logPath: `runs/0-${which}.log` };
}

describe('judgeAssay (the pre-registered rule)', () => {
  const kase = (w: AssayCaseResult['with'], wo: AssayCaseResult['without']): AssayCaseResult => ({ task: 'x', sampledAt: 'now', with: w, without: wo });
  it('says nothing about a recipe no run matched', () => {
    const j = judgeAssay([kase(arm('delivered', false), arm('delivered', false, 'without'))]);
    expect(j).toMatchObject({ verdict: 'not-reached', decision: 'keep', matchedCases: 0 });
  });
  it('is helpful, neutral or harmful by deliveries over matched cases, costs beside', () => {
    expect(judgeAssay([kase(arm('delivered', true), arm('failed', false, 'without'))]).verdict).toBe('helpful');
    const neutral = judgeAssay([kase(arm('delivered', true, 'with', 0.2), arm('delivered', false, 'without', 0.3))]);
    expect(neutral).toMatchObject({ verdict: 'neutral', decision: 'keep', costUsd: { with: 0.2, without: 0.3 } });
    expect(judgeAssay([kase(arm('failed', true), arm('delivered', false, 'without'))])).toMatchObject({ verdict: 'harmful', decision: 'keep', matchedCases: 1 });
  });
  it('retires only on two or more matched cases where the recipe delivered nothing and the run without it did', () => {
    const two = [kase(arm('failed', true), arm('delivered', false, 'without')), kase(arm('partial', true), arm('delivered', false, 'without'))];
    expect(judgeAssay(two)).toMatchObject({ verdict: 'harmful', decision: 'retire', deliveries: { with: 0, without: 2 } });
    const oneDelivered = [kase(arm('failed', true), arm('delivered', false, 'without')), kase(arm('delivered', true), arm('delivered', false, 'without'))];
    expect(judgeAssay(oneDelivered)).toMatchObject({ verdict: 'harmful', decision: 'keep' });
    const unmatchedSecond = [kase(arm('failed', true), arm('delivered', false, 'without')), kase(arm('failed', false), arm('delivered', false, 'without'))];
    expect(judgeAssay(unmatchedSecond)).toMatchObject({ matchedCases: 1, decision: 'keep' });
  });
  it('leaves a cost unknown when any arm has none', () => {
    expect(judgeAssay([kase({ ...arm('delivered', true), costUsd: null }, arm('delivered', false, 'without'))]).costUsd.with).toBeNull();
  });
});

interface Fixture {
  root: string;
  dbPath: string;
  skillsDir: string;
  skills: SkillRegistry;
  journal: PlatformEventLog;
  launches: ArmLaunch[];
  options: (overrides?: Partial<AssayerOptions>) => AssayerOptions;
}

/** A fake runner: writes a log with the epilogue the arm is scripted to produce, and a trace with a match event when told. */
function fakeLauncher(f: Pick<Fixture, 'launches'>, script: (launch: ArmLaunch) => { outcome: RunStats['outcome']; matched: boolean; costUsd?: number }) {
  return async (launch: ArmLaunch): Promise<string> => {
    f.launches.push(launch);
    const plan = script(launch);
    const trace = {
      id: `trace-${launch.caseIndex}-${launch.arm}`,
      events: plan.matched ? [{ kind: 'skill', op: 'match', skillId: 'probe-api', l1AtomId: NS }] : [{ kind: 'llm' }],
    };
    mkdirSync(launch.env['ATOMA_RUNS_DIR']!, { recursive: true });
    writeFileSync(join(launch.env['ATOMA_RUNS_DIR']!, `${trace.id}.json`), JSON.stringify(trace));
    const log = `goal echoed\n${formatRunStatsEpilogue(stats(plan.outcome, plan.costUsd ?? 0.1))}\n`;
    writeFileSync(launch.logPath, log);
    return log;
  };
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'atoma-assayer-'));
  dirs.push(root);
  const dbPath = join(root, 'atoma.db');
  const db = new Database(dbPath);
  const skillsDir = join(root, 'skills');
  const skills = new SkillRegistry(skillsDir, { db });
  skills.save(NS, { id: 'probe-api', description: 'probes a JSON API', whenToUse: 'when asked to verify a running API', kind: 'llm', body: '1. fetch each route.' },
    { mechanism: 'distilled', at: '2026-10-15T10:00:00.000Z' });
  skills.save(NS, { id: 'build-api', description: 'builds a JSON API', whenToUse: 'when asked to build an API', kind: 'llm', body: '1. write server.' },
    { mechanism: 'distilled', at: '2026-10-14T10:00:00.000Z' });
  skills.save(NS, { id: 'recover-port', description: 'recovers from a busy port', whenToUse: 'n/a', kind: 'llm', body: 'pick another port', trigger: 'EADDRINUSE' });
  skills.recordSuccess(NS, 'probe-api', { task: 'Verify the running books API answers its documented routes' });
  skills.recordSuccess(NS, 'probe-api', { task: 'Confirm the recipes API still serves its routes' });
  const journal = PlatformEventLog.open(dbPath);
  mkdirSync(join(root, 'runs'), { recursive: true });
  const launches: ArmLaunch[] = [];
  const base: Omit<AssayerOptions, 'launch'> = {
    repoRoot: root, dbPath, skillsDir, skills, runsDir: join(root, 'runs'), supervisorDir: join(root, 'supervisor'),
    leasePath: join(root, 'lease.db'), timeoutMs: 1000, maxCases: 2, isolation: 'container-egress', dryRun: false,
    journal: (input) => void journal.append(input), log: () => {}, warn: () => {},
  };
  const f: Fixture = { root, dbPath, skillsDir, skills, journal, launches, options: (overrides = {}) => ({ ...base, ...overrides }) };
  return f;
}

describe('pendingAssays / assayCases', () => {
  it('lists task recipes with credited cases and no row for their surface, newest surface first', () => {
    const f = fixture();
    expect(pendingAssays(f.skills).map((t) => t.skillId)).toEqual(['probe-api']);
    f.skills.recordSuccess(NS, 'build-api', { task: 'Build a books API' });
    expect(pendingAssays(f.skills).map((t) => t.skillId)).toEqual(['probe-api', 'build-api']);
    expect(pendingAssays(f.skills, { max: 1 }).map((t) => t.skillId)).toEqual(['probe-api']);
    const digest = surfaceDigestOf(f.skills.loadFor(NS).find((s) => s.id === 'probe-api')!);
    f.skills.recordAssay({ namespace: NS, skillId: 'probe-api', surfaceDigest: digest, at: 'now', verdict: 'neutral', decision: 'keep', recordPath: 'x', costUsd: 1 });
    expect(pendingAssays(f.skills).map((t) => t.skillId)).toEqual(['build-api']);
    // A revised surface re-opens the assay; `only` ignores the row.
    f.skills.save(NS, { id: 'probe-api', description: 'probes a JSON API', whenToUse: 'when asked to VERIFY an API; not to build one', kind: 'llm', body: '1. fetch each route.' });
    expect(pendingAssays(f.skills).map((t) => t.skillId)).toContain('probe-api');
    expect(pendingAssays(f.skills, { only: { namespace: NS, skillId: 'build-api' } }).map((t) => t.skillId)).toEqual(['build-api']);
    // Two credits in one millisecond tie on `at`; the set is what matters here.
    expect(assayCases(f.skills, NS, 'probe-api', 5).map((c) => c.task.slice(0, 7)).sort()).toEqual(['Confirm', 'Verify ']);
    expect(assayCases(f.skills, NS, 'probe-api', 1)).toHaveLength(1);
  });
});

describe('runAssay', () => {
  it('runs each case twice on copies, with learning off and the recipe absent from the without arm, and records facts everywhere', async () => {
    const f = fixture();
    const [target] = pendingAssays(f.skills);
    const launch = fakeLauncher(f, (l) => ({ outcome: 'delivered', matched: l.arm === 'with', costUsd: l.arm === 'with' ? 0.2 : 0.3 }));
    const result = await runAssay(target!, assayCases(f.skills, NS, 'probe-api', 2), f.options({ launch }));
    expect(result.outcome).toBe('assayed');
    expect(result.judgement).toMatchObject({ verdict: 'neutral', decision: 'keep', matchedCases: 2, deliveries: { with: 2, without: 2 } });
    expect(f.launches.map((l) => `${l.caseIndex}-${l.arm}`)).toEqual(['0-with', '0-without', '1-with', '1-without']);
    for (const l of f.launches) {
      expect(l.env['ATOMA_DB_PATH']).not.toBe(f.dbPath);
      expect(l.env['ATOMA_SKILL_LEARN']).toBe('0');
      expect(l.env['ATOMA_SKILL_PROMOTE']).toBe('0');
      expect(l.env['ATOMA_SKILL_TRIGGER_EVAL']).toBe('0');
      expect(l.env['ATOMA_RUNS_DIR']).not.toBe(f.options().runsDir);
      expect(l.cwd).toBe(f.root);
      expect(l.isolation).toBe('container-egress');
      expect(l.goal.length).toBeGreaterThan(10);
    }
    // Observed while the copies existed: the fake kept the directory listing.
    const withDir = f.launches[0]!.env['ATOMA_SKILLS_DIR']!;
    const withoutDir = f.launches[1]!.env['ATOMA_SKILLS_DIR']!;
    expect(withDir).not.toBe(withoutDir);
    expect(withDir.endsWith('catalog-with')).toBe(true);
    expect(withoutDir.endsWith('catalog-without')).toBe(true);
    // The record is the contract's shape and lives under supervisor/assays.
    const record = skillAssayRecordSchema.parse(JSON.parse(readFileSync(result.recordPath!, 'utf8')));
    expect(record.cases).toHaveLength(2);
    expect(record.cases[0]!.with.matched).toBe(true);
    expect(record.cases[0]!.without.matched).toBe(false);
    expect(record.totalCostUsd).toBeCloseTo(1.0);
    expect(record.applied).toBe(true);
    expect(result.recordPath).toContain(join('supervisor', 'assays'));
    // Scratch is gone, logs and traces stay.
    expect(existsSync(join(result.recordPath!, '..', 'scratch'))).toBe(false);
    expect(existsSync(join(result.recordPath!, '..', 'runs', '0-with.log'))).toBe(true);
    // The store row closes the surface; the journal row carries facts only.
    expect(f.skills.assayFor(NS, 'probe-api', target!.surfaceDigest)).toMatchObject({ verdict: 'neutral', decision: 'keep', costUsd: 1.0 });
    expect(pendingAssays(f.skills).map((t) => t.skillId)).toEqual([]);
    const rows = f.journal.list({ kind: 'supervisor.assay' }).events;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ stage: 'assayer', skillId: 'probe-api', verdict: 'neutral', decision: 'keep', cases: 2, matchedCases: 2 });
    expect(JSON.stringify(rows[0])).not.toContain('books API');
    // The live catalog is untouched.
    expect(f.skills.loadFor(NS).map((s) => s.id).sort()).toEqual(['build-api', 'probe-api', 'recover-port']);
    expect(f.skills.loadFor(NS).find((s) => s.id === 'probe-api')!.successes).toBe(2);
  });

  it('retires a recipe that delivered on none of two matched cases where the run without it delivered', async () => {
    const f = fixture();
    const [target] = pendingAssays(f.skills);
    const launch = fakeLauncher(f, (l) => ({ outcome: l.arm === 'with' ? 'failed' : 'delivered', matched: l.arm === 'with' }));
    const result = await runAssay(target!, assayCases(f.skills, NS, 'probe-api', 2), f.options({ launch }));
    expect(result.judgement).toMatchObject({ verdict: 'harmful', decision: 'retire' });
    expect(f.skills.loadFor(NS).map((s) => s.id).sort()).toEqual(['build-api', 'recover-port']);
    expect(f.journal.list({ kind: 'supervisor.assay' }).events[0]!.detail).toMatchObject({ decision: 'retire', applied: true });
    expect(f.journal.list({ kind: 'supervisor.assay' }).events[0]!.summary).toMatch(/retired from the catalog/);
    // Judged: it does not come back as pending, even though the body is gone.
    expect(pendingAssays(f.skills).map((t) => t.skillId)).toEqual([]);
  });

  it('records a run that could not be launched as an error arm and keeps the recipe', async () => {
    const f = fixture();
    const [target] = pendingAssays(f.skills);
    const launch = async (l: ArmLaunch): Promise<string> => {
      f.launches.push(l);
      if (l.arm === 'with') throw new Error('spawn npm ENOENT');
      return fakeLauncher(f, () => ({ outcome: 'delivered', matched: false }))(l);
    };
    const result = await runAssay(target!, assayCases(f.skills, NS, 'probe-api', 2), f.options({ launch }));
    expect(result.outcome).toBe('assayed');
    expect(result.judgement).toMatchObject({ verdict: 'not-reached', decision: 'keep', matchedCases: 0 });
    const record = skillAssayRecordSchema.parse(JSON.parse(readFileSync(result.recordPath!, 'utf8')));
    expect(record.cases[0]!.with.outcome).toBe('error');
    expect(f.skills.loadFor(NS).some((s) => s.id === 'probe-api')).toBe(true);
  });

  it('spends nothing on a dry run and records nothing', async () => {
    const f = fixture();
    const [target] = pendingAssays(f.skills);
    const lines: string[] = [];
    const launch = fakeLauncher(f, () => ({ outcome: 'delivered', matched: true }));
    const result = await runAssay(target!, assayCases(f.skills, NS, 'probe-api', 2), f.options({ launch, dryRun: true, log: (l) => lines.push(l) }));
    expect(result.outcome).toBe('dry-run');
    expect(f.launches).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/would assay .*probe-api on 2 case\(s\), 4 run\(s\)/);
    expect(pendingAssays(f.skills).map((t) => t.skillId)).toEqual(['probe-api']);
    expect(f.journal.list({ kind: 'supervisor.assay' }).events).toHaveLength(0);
  });

  it('is preempted through its signal, recording nothing and leaving the recipe pending', async () => {
    const f = fixture();
    const [target] = pendingAssays(f.skills);
    const controller = new AbortController();
    const launch = async (l: ArmLaunch): Promise<string> => {
      f.launches.push(l);
      controller.abort(new Error('preempted'));
      throw new Error('killed');
    };
    const result = await runAssay(target!, assayCases(f.skills, NS, 'probe-api', 2), f.options({ launch, signal: controller.signal }));
    expect(result.outcome).toBe('preempted');
    expect(f.launches).toHaveLength(1);
    expect(pendingAssays(f.skills).map((t) => t.skillId)).toEqual(['probe-api']);
    expect(f.journal.list({ kind: 'supervisor.assay' }).events).toHaveLength(0);
  });
});

describe('assayNext', () => {
  it('refuses beside a held lease, and otherwise takes the lease for the assay', async () => {
    const f = fixture();
    const launch = fakeLauncher(f, (l) => ({ outcome: 'delivered', matched: l.arm === 'with' }));
    const held = acquireRunLeaseWithoutRecovery('test-run', f.options().leasePath);
    try {
      expect((await assayNext(f.options({ launch }))).outcome).toBe('refused-active');
      expect(f.launches).toHaveLength(0);
    } finally {
      held.release();
    }
    const result = await assayNext(f.options({ launch }));
    expect(result.outcome).toBe('assayed');
    expect(f.launches).toHaveLength(4);
    expect((await assayNext(f.options({ launch }))).outcome).toBe('nothing-pending');
  });
});

describe('arm helpers', () => {
  it('reads a match from the newest trace runtime skill events only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-assay-trace-'));
    dirs.push(dir);
    expect(armMatchedRecipe(dir, 'probe-api')).toEqual({ matched: false, traceId: null });
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ id: 'a', events: [{ kind: 'skill', op: 'inject', skillId: 'probe-api' }] }));
    expect(armMatchedRecipe(dir, 'probe-api')).toEqual({ matched: false, traceId: 'a' });
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ id: 'a', events: [{ kind: 'skill', op: 'direct', skillId: 'probe-api' }] }));
    expect(armMatchedRecipe(dir, 'probe-api').matched).toBe(true);
    expect(armMatchedRecipe(dir, 'other').matched).toBe(false);
  });
  it('turns every lifecycle stage off for an arm', () => {
    const env = armEnvironment({ dbPath: '/s.db', skillsDir: '/c', runsDir: '/r', workspace: '/w' });
    expect(env).toMatchObject({ ATOMA_DB_PATH: '/s.db', ATOMA_SKILLS_DIR: '/c', ATOMA_RUNS_DIR: '/r', ATOMA_BUILD_WORKSPACE: '/w', ATOMA_SKILL_LEARN: '0', ATOMA_SKILL_PROMOTE: '0', ATOMA_SKILL_TRIGGER_EVAL: '0' });
  });
});

describe('the resident assayer', () => {
  it('is on unless told off, pauses after a failure, defers while active, and yields to a product run', async () => {
    expect(vizAssayerEnabled({}, () => {})).toBe(true);
    expect(vizAssayerEnabled({ ATOMA_VIZ_ASSAYER: '0' }, () => {})).toBe(false);
    expect(vizAssayerEnabled({ ATOMA_VIZ_ASSAYER: 'maybe' }, () => {})).toBe(true);
    let clock = 1_000;
    let active = false;
    const outcomes: Array<'failed' | 'assayed'> = ['failed', 'assayed'];
    let aborted = 0;
    const resident = startResidentAssayer({
      assay: async (signal) => {
        signal.addEventListener('abort', () => { aborted += 1; });
        const outcome = outcomes.shift() ?? 'assayed';
        await new Promise((r) => setTimeout(r, 5));
        if (signal.aborted) return { outcome: 'preempted', target: null, recordPath: null, judgement: null };
        return { outcome, target: { namespace: NS, skillId: 'probe-api', kind: 'llm', surfaceDigest: 'd', surfaceAt: '' }, recordPath: null,
          judgement: outcome === 'assayed' ? { verdict: 'neutral', decision: 'keep', matchedCases: 1, deliveries: { with: 1, without: 1 }, costUsd: { with: null, without: null } } : null };
      },
      isActive: () => active,
      pollMs: 60_000, failurePauseMs: 10_000, now: () => clock,
    });
    try {
      await resident.tickNow();
      expect(resident.health()).toMatchObject({ failed: 1, assayed: 0 });
      expect(resident.health().pausedUntil).not.toBeNull();
      await resident.tickNow();
      expect(resident.health().assayed).toBe(0);
      clock += 10_001;
      active = true;
      await resident.tickNow();
      expect(resident.health().deferred).toBe(1);
      active = false;
      await resident.tickNow();
      expect(resident.health().assayed).toBe(1);
      const flight = resident.tickNow();
      expect(await resident.yieldForRun()).toBe(true);
      await flight;
      expect(aborted).toBe(1);
      expect(resident.health().preempted).toBe(1);
    } finally {
      resident.stop();
    }
  });
});
