import { AuthStore } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCheckpointStoreOutsideWorkspace, checkpointWorkspaceDigest, RunCheckpointStore, SequentialCheckpoint, savedRootActor } from '../src/run/checkpoint.js';
import { openDb } from '../src/registry/db.js';
import { seedTissueCatalog } from '../src/run/tissues.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { makeCtx } from './helpers.js';
import { parseRunnerArgs, shortRootHandle } from '../src/run/runner.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { PlanParseError } from '../src/core/errors.js';
import type { Result } from '../src/core/types.js';
import { BudgetGateLlmClient, RunBudgetMeter } from '../src/core/runBudget.js';
import { InMemoryMetrics } from '../src/core/metrics.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { withRecoveryEffects } from '../src/core/recoveryEffects.js';
import { checkpointRoots, cleanupCheckpointFixtures, fixture } from './helpers/checkpointFixture.js';

afterEach(cleanupCheckpointFixtures);

describe('durable sequential run continuation', () => {
  it('resumes after SIGKILL exactly at a committed boundary', () => {
    const f = fixture();
    const first = f.run(['--checkpoint', 'Write two files in sequence'], 'boundary');
    expect(first.signal, first.stdout + first.stderr).toBe('SIGKILL');
    const db = new Database(f.db, { readonly: true });
    const row = db.prepare('SELECT id FROM run_checkpoints').get() as { id: string };
    db.close();
    const next = f.run(['--resume', row.id]);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(f.report().outcome).toBe('delivered');
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    expect(f.counters().skills.n).toBe(2);
  }, 90000);

  it('still performs fresh final acceptance when every phase was completed before the pause', () => {
    const f = fixture();
    const first = f.run(['--pause-after-phase', '2', 'Write two files in sequence']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const before = f.report();
    const credit = f.counters();
    expect(before.calls.filter(c => c.endsWith(':run-root'))).toHaveLength(0);
    const next = f.run(['--resume', before.checkpointId]);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(f.report().outcome).toBe('delivered');
    expect(f.report().calls.filter(c => c.startsWith('execute:'))).toHaveLength(0);
    expect(f.report().calls.filter(c => c.endsWith(':run-root'))).toHaveLength(1);
    expect(f.counters()).toEqual(credit);
  }, 90000);

  it('refuses replay after SIGKILL inside a phase with an external effect', () => {
    const f = fixture();
    const first = f.run(['--checkpoint', 'Write two files in sequence'], 'phase');
    expect(first.signal, first.stdout + first.stderr).toBe('SIGKILL');
    const db = new Database(f.db, { readonly: true });
    const row = db.prepare('SELECT id FROM run_checkpoints').get() as { id: string };
    db.close();
    const next = f.run(['--resume', row.id]);
    expect(next.status).toBe(2);
    expect(next.stderr).toContain('not at a resumable');
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    expect(f.counters().skills.n).toBe(1);
  }, 90000);

  it('refuses a changed workspace without overwriting the user edit', () => {
    const f = fixture();
    const first = f.run(['--pause-after-phase', '1', 'Write two files in sequence']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const id = f.report().checkpointId;
    writeFileSync(join(f.root, 'workspace', 'phase-one.txt'), 'user edit');
    const next = f.run(['--resume', id]);
    expect(next.status).toBe(2);
    expect(next.stderr).toContain('Workspace changed');
    expect(readFileSync(join(f.root, 'workspace', 'phase-one.txt'), 'utf8')).toBe('user edit');
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\n');
  }, 90000);

  // Code review 2026-10-09, 1.1: the boundary was sealed while the phase's
  // server ran; the pause's drain sent SIGTERM, the server persisted its state,
  // and release() failed the run as 'Workspace changed during shutdown'.
  it('pauses a phase whose server writes on SIGTERM, and resumes it', () => {
    const f = fixture();
    const first = f.run(['--pause-after-phase', '1', 'Write two files in sequence'], '', { CHECKPOINT_TEST_SERVER: '1' });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(f.report()).toMatchObject({ outcome: 'partial', paused: true });
    expect(readFileSync(join(f.root, 'workspace', 'notes.json'), 'utf8')).toBe('[]');
    const next = f.run(['--resume', f.report().checkpointId]);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(f.report().outcome).toBe('delivered');
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
  }, 90000);

  it('keeps a client question answerable when the phase before it left a server that writes on SIGTERM', () => {
    const f = fixture();
    const viewer = AuthStore.open(f.db).completeLogin({ provider: 'github', subject: 'drain-owner', displayName: 'Owner', email: null, emailVerified: false }, null)!.viewer;
    const store = ProjectStore.open(f.db);
    const project = store.createProject({ orgId: viewer.orgId, principalId: viewer.principalId,
      project: { name: 'Drain', slug: 'drain', repositoryTarget: { installationId: '1', owner: 'owner', name: 'drain', visibility: 'private' } } });
    const reserve = (resumeOf?: string) => {
      const id = randomUUID(), workspace = join(f.root, id, 'workspace'), runs = join(f.root, id, 'traces');
      store.createProjectRun({ orgId: viewer.orgId, principalId: viewer.principalId, projectId: project.projectId, projectRunId: id,
        request: { goal: 'Write two files in sequence', idempotencyKey: id, ...(resumeOf ? { resumeOf } : {}) },
        hostPaths: { workspacePath: workspace, runsPath: runs, skillsPath: join(f.root, 'skills'), logPath: join(f.root, id, 'run.log') } });
      store.transitionProjectRun({ orgId: viewer.orgId, projectRunId: id, from: 'queued', to: 'running' });
      return { id, workspace, env: { ATOMA_TENANT_RUN: '1', CHECKPOINT_TEST_TENANT: '1', ATOMA_RUN_ID: id,
        ATOMA_BUILD_WORKSPACE: workspace, ATOMA_RUNS_DIR: runs, CHECKPOINT_TEST_QUESTION_PHASE: '1' } };
    };
    const first = reserve();
    const paused = f.run(['--container', '--checkpoint', 'Write two files in sequence'], '', { ...first.env, CHECKPOINT_TEST_SERVER: '1' });
    expect(paused.status, paused.stdout + paused.stderr).toBe(0);
    expect(f.report().outcome).toBe('partial');
    expect(readFileSync(join(first.workspace, 'notes.json'), 'utf8')).toBe('[]');
    const checkpoints = new RunCheckpointStore(f.db);
    expect(checkpoints.projectStatus(first.id, viewer.orgId)).toMatchObject({ state: 'paused', completed: 1 });
    const question = checkpoints.clientQuestion(viewer.orgId, first.id)!;
    expect(checkpoints.answerClientQuestion(viewer.orgId, first.id, viewer.principalId,
      { questionId: question.questionId, idempotencyKey: randomUUID(), answer: { optionId: 'keep_both' } }).created).toBe(true);
    const second = reserve(first.id);
    const resumed = f.run(['--container', '--resume', first.id], '', { ...second.env, CHECKPOINT_TEST_EXPECT_ANSWER: '1' });
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(f.report().outcome).toBe('delivered');
    expect(readFileSync(join(second.workspace, 'notes.json'), 'utf8')).toBe('[]');
  }, 90000);

  it('atomically admits only one claimant and refuses live sandbox processes', () => {
    const f = fixture();
    const first = f.run(['--pause-after-phase', '1', 'Write two files in sequence']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const store = new RunCheckpointStore(f.db);
    const id = f.report().checkpointId;
    const a = store.read(id);
    const b = store.read(id);
    const owner = store.claim(a, false);
    expect(() => store.claim(b, false)).toThrow('still owned');
    store.write(a, owner, 'ready');
    expect(() => store.read(id)).toThrow('still owned');
    // Simulate an exited owner with a surviving process; the pid probe is real.
    const db = new Database(f.db);
    const deadPid = 2_000_000_000;
    a.processes = [{ pid: process.pid, group: false }];
    db.prepare('UPDATE run_checkpoints SET pid=?, payload=? WHERE id=?').run(deadPid, JSON.stringify(a), id);
    expect(() => store.read(id)).toThrow('sandbox processes');
    a.processes = null;
    db.prepare('UPDATE run_checkpoints SET payload=? WHERE id=?').run(JSON.stringify(a), id);
    expect(() => store.read(id)).toThrow('backend_unknown');
    a.processes = [];
    db.prepare('UPDATE run_checkpoints SET payload=? WHERE id=?').run(JSON.stringify(a), id);
    store.beginAction(a, owner, 'tool', 'write_file', { path: 'uncertain.txt', content: 'intent' });
    expect(() => store.read(id)).toThrow('tool_pending');
    db.close();
  }, 90000);

  it('enforces carried consumption without billing previous calls to the new trace', async () => {
    const metrics = new InMemoryMetrics();
    const meter = new RunBudgetMeter(metrics, { tokens: 100, costUsd: 10 }, () => {}, undefined,
      { tokens: 90, costUsd: 1 });
    expect(metrics.events).toHaveLength(0);
    meter.record({ model: 'unknown', inputTokens: 11, outputTokens: 0, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0, durationMs: 1, stopReason: 'end_turn' });
    expect(meter.exceeded()?.kind).toBe('tokens');
    expect(meter.consumed()).toEqual({ tokens: 101, costUsd: 1 });
    expect(metrics.events).toHaveLength(1);
    const ctx = makeCtx();
    const gate = new BudgetGateLlmClient(ctx.llm, meter);
    await expect(gate.complete({ model: 'x', systemPrompt: '', userContent: '' })).rejects.toThrow('token ceiling');
    expect(ctx.llm.calls).toHaveLength(0);
    const narrowed = new RunBudgetMeter(new InMemoryMetrics(), { tokens: null, costUsd: 0.5 }, () => {}, undefined,
      { tokens: 90, costUsd: 1 });
    expect(narrowed.exceeded()?.kind).toBe('cost');
  });

  it('seals directories and internal dependency links, refuses escaping links', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-files-'))); checkpointRoots.push(root);
    const empty = checkpointWorkspaceDigest(root);
    mkdirSync(join(root, 'empty'));
    expect(checkpointWorkspaceDigest(root)).not.toBe(empty);
    writeFileSync(join(root, 'target'), 'first');
    symlinkSync('target', join(root, 'internal'));
    const linked = checkpointWorkspaceDigest(root);
    writeFileSync(join(root, 'target'), 'changed');
    expect(checkpointWorkspaceDigest(root)).not.toBe(linked);
    symlinkSync('/tmp', join(root, 'link'));
    expect(() => checkpointWorkspaceDigest(root)).toThrow('link or special');
  });

  // Code review 2026-10-09, 1.6: the client-question boundary sealed without
  // afterPhase's degradation, so a seed the snapshot refuses (here an 11 MiB
  // file) failed the whole run when a question was due before phase 1.
  it('degrades a client-question boundary over an unsupported workspace like afterPhase: no question, run goes on', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-question-'))); checkpointRoots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'dataset.bin'), Buffer.alloc(11 * 1024 * 1024));
    const store = new RunCheckpointStore(join(root, 'atoma.db'));
    const id = randomUUID();
    const data = {
      version: 1, id, scope: { orgId: 'o', projectId: 'p', principalId: 'u', runId: id }, goal: 'g', workspace,
      policy: '{}', actor: { name: 'Meristem', atomId: 'a', version: 1 }, checklist: [], root: null, completed: [],
      workspaceDigest: null, processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600_000, lastRunId: null,
    };
    const warnings: string[] = [];
    let drained = 0;
    await withRecoveryEffects(async () => {
      const cp = new SequentialCheckpoint(data as never, store, {
        fresh: true, automatic: true, account: () => ({ tokens: 1, costUsd: 0.1 }), deadlineAt: Date.now() + 600_000,
        settle: async () => {}, processes: () => [], warn: (m: string) => warnings.push(m),
        drain: () => { drained++; return Promise.resolve(); },
        assessClientQuestion: () => Promise.resolve({ question: 'Which database?', options: [
          { id: 'a', label: 'SQLite', consequence: 'file' }, { id: 'b', label: 'Postgres', consequence: 'server' }] }),
      } as never);
      cp.planned({ description: 'g' }, { subtasks: [{}, {}], aggregation: { mode: 'sequential' } } as never, {}, 2);
      await cp.beforePhase(0, {} as never);
      expect(cp.paused).toBe(false);
      expect(cp.completed).toEqual([]);
    });
    expect(warnings).toEqual([expect.stringContaining('Durable continuation unavailable')]);
    // The live backend was never stopped for a tree that cannot be sealed.
    expect(drained).toBe(0);
    expect(store.clientQuestion('o', id)).toBeNull();
  });

  // Code review 2026-10-09, 2.4: only the count (32) was checked before a
  // question was asked, not the 24000-character budget. A few long answers
  // filled the history, the question was asked, and no answer could then be
  // recorded, a plain option included: the run could only be cancelled.
  it('does not ask a client question the answer history has no characters left to record', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-history-'))); checkpointRoots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'index.html'), '<p>hi</p>');
    const store = new RunCheckpointStore(join(root, 'atoma.db'));
    const id = randomUUID();
    const data = {
      version: 1, id, scope: { orgId: 'o', projectId: 'p', principalId: 'u', runId: id }, goal: 'g', workspace,
      policy: '{}', actor: { name: 'Meristem', atomId: 'a', version: 1 }, checklist: [], root: null, completed: [],
      workspaceDigest: null, processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600_000, lastRunId: null,
    };
    // Eight answers, far below the 32-entry count, about 22000 encoded characters.
    const clientAnswers = Array.from({ length: 8 }, () => ({
      questionId: randomUUID(), question: 'q'.repeat(600), selectedOption: null, text: 't'.repeat(2000),
      principalId: randomUUID(), at: new Date().toISOString(),
    }));
    expect(JSON.stringify(clientAnswers).length).toBeLessThan(24_000);
    let asked = 0;
    await withRecoveryEffects(async () => {
      const cp = new SequentialCheckpoint(data as never, store, {
        fresh: true, automatic: true, account: () => ({ tokens: 1, costUsd: 0.1 }), deadlineAt: Date.now() + 600_000,
        settle: async () => {}, processes: () => [], warn: () => {}, drain: () => Promise.resolve(),
        assessClientQuestion: () => { asked++; return Promise.resolve({ question: 'Which database should the app use?', whyClient: 'w', missingDecision: 'm', options: [
          { id: 'a', label: 'SQLite', consequence: 'file' }, { id: 'b', label: 'Postgres', consequence: 'server' }] }); },
      });
      cp.planned({ description: 'g', inputs: { clientAnswers } }, { subtasks: [{}, {}], aggregation: { mode: 'sequential' } } as never, {}, 2);
      await expect(cp.beforePhase(0, {} as never)).rejects.toThrow('Client answer history is full; start a new scoped run');
    });
    expect(asked).toBe(1);
    expect(store.clientQuestion('o', id)).toBeNull();
  });

  // Code review 2026-10-09, 1.4: the saved root actor is checked after the
  // successor claimed the continuation, and the successor's own catalog
  // seeding can move Meristem's version. The refusal consumed the source for
  // good and left the successor `running`, blocked by its own seeding.
  it.each(['changed', 'identical', 'missing-history', 'corrupt-history', 'identity'] as const)('checks the complete saved root definition before continuing: %s', async mode => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-actor-'))); checkpointRoots.push(root);
    const dbPath = join(root, 'atoma.db');
    const registry = new AtomRegistry(openDb(dbPath));
    const schema = { type: 'object', properties: {} };
    const base = [{ name: 'read_file', description: 'Read a file', inputSchema: schema }];
    const docs = { name: 'search_project_docs', description: 'Search the project documents', inputSchema: schema };
    const seed = (toolDecls: typeof base) => seedTissueCatalog({ registry, toolDecls, log: () => {} });
    const paused = seed([...base, docs]);
    const workspace = join(root, 'ws-source');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'index.html'), '<p>phase 1 validated</p>');
    const store = new RunCheckpointStore(dbPath);
    const sourceId = randomUUID();
    const scope = { orgId: 'org', projectId: 'proj', principalId: 'alice', runId: sourceId };
    const data = { version: 1, id: sourceId, scope, goal: 'Build the app', workspace, policy: '{}',
      actor: { name: paused.name, atomId: paused.atomId, version: paused.version }, checklist: [], root: null, completed: [],
      workspaceDigest: null, processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600_000, lastRunId: null };
    const phase = (n: number) => ({ description: `phase ${n}`, child: 'Cell' });
    await withRecoveryEffects(async () => {
      const cp = new SequentialCheckpoint(data as never, store, { fresh: true, automatic: true, pauseAfter: 1,
        account: () => ({ tokens: 1000, costUsd: 0.42 }), deadlineAt: Date.now() + 600_000, settle: async () => {}, processes: () => [] });
      cp.planned({ description: 'Build the app' }, { subtasks: [phase(1), phase(2)], aggregation: { mode: 'sequential' } } as never, {}, 2);
      await cp.beforePhase(0, phase(1));
      await expect(cp.afterPhase(0, { output: { ok: true }, summary: 'phase 1 done', producedBy: { name: 'Cell', tier: 2, viaFallback: false },
        trace: [{ kind: 'verdict-result', payload: { approved: true } }] } as never)).rejects.toThrow();
      await cp.release();
    });
    expect(store.projectStatus(sourceId, 'org')?.state).toBe('paused');
    // Another run of the commons has no retrieval corpus: Meristem moves on.
    seed(base);
    const saved = store.read(sourceId);
    const nextId = randomUUID();
    const nextWorkspace = join(root, 'ws-next');
    await withRecoveryEffects(async () => {
      const successor = new SequentialCheckpoint({ ...saved, id: nextId, workspace: nextWorkspace, scope: { ...scope, runId: nextId } }, store, {
        fresh: false, source: saved, automatic: true, account: () => saved.consumed, deadlineAt: Date.now() + 600_000,
        settle: async () => {}, processes: () => [], restoreWorkspace: () => store.materialize(saved, nextWorkspace, false) });
      // The runner's order: the successor seeds its catalog, then selects the saved actor.
      if (mode !== 'changed') seed([...base, docs]);
      if (mode === 'missing-history' || mode === 'corrupt-history') {
        const raw = new Database(dbPath);
        if (mode === 'missing-history') raw.prepare('DELETE FROM atom_type_versions WHERE tier=3 AND ordinal=? AND version=?').run(paused.ordinal, paused.version);
        else raw.prepare('UPDATE atom_type_versions SET tools_json=? WHERE tier=3 AND ordinal=? AND version=?').run('broken', paused.ordinal, paused.version);
        raw.close();
      }
      if (mode === 'identical') {
        const current = savedRootActor(registry, saved.actor!, successor);
        expect(current.version).toBeGreaterThan(saved.actor!.version);
        expect(current.systemPrompt).toBe(paused.systemPrompt);
        expect(current.tools).toEqual(paused.tools);
        successor.refuseContinuation(); // Test cleanup must leave the original boundary untouched.
      } else expect(() => savedRootActor(registry, mode === 'identity' ? { ...saved.actor!, atomId: randomUUID() } : saved.actor!, successor))
        .toThrow('Saved root actor has changed; resume refused');
    });
    expect(store.projectStatus(sourceId, 'org')?.state).toBe('paused');
    expect(store.projectStatus(nextId, 'org')?.state).toBe('unavailable');
    expect(store.read(sourceId)).toEqual(saved);
  });

  it('cannot place its authority store inside the workspace through a parent symlink', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-containment-'))); checkpointRoots.push(root);
    mkdirSync(join(root, 'workspace'));
    const store = join(root, 'workspace', '..store.db');
    writeFileSync(store, '');
    symlinkSync(join(root, 'workspace'), join(root, 'alias'));
    expect(() => assertCheckpointStoreOutsideWorkspace(store, join(root, 'alias'))).toThrow('outside');
    expect(() => assertCheckpointStoreOutsideWorkspace(store, join(root, 'new', 'workspace'))).not.toThrow();
  });

  // Review 2026-10-16 (D5): an approved phase whose parent-owned suite did not
  // run proved nothing, like an uncovered obligation; parent tests no longer
  // write `refusal`, so `isLanded` alone would have saved it as a resume prefix.
  it('does not seed a resume with an approved phase whose parent-owned suite did not run', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-parent-tests-'))); checkpointRoots.push(root);
    const workspace = join(root, 'ws');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'add.ts'), 'export const add = (a: number, b: number) => a + b;');
    const store = new RunCheckpointStore(join(root, 'atoma.db'));
    const id = randomUUID();
    const data = { version: 1, id, scope: { orgId: 'o', projectId: 'p', principalId: 'u', runId: id }, goal: 'g', workspace,
      policy: '{}', actor: { name: 'Meristem', atomId: 'a', version: 1 }, checklist: [], root: null, completed: [],
      workspaceDigest: null, processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600_000, lastRunId: null };
    const warnings: string[] = [];
    await withRecoveryEffects(async () => {
      const cp = new SequentialCheckpoint(data as never, store, { fresh: true, automatic: true,
        account: () => ({ tokens: 1, costUsd: 0.1 }), deadlineAt: Date.now() + 600_000, settle: async () => {},
        processes: () => [], warn: (line: string) => warnings.push(line) });
      cp.planned({ description: 'g' }, { subtasks: [{ description: 'phase 1' }, { description: 'phase 2' }], aggregation: { mode: 'sequential' } } as never, {}, 2);
      await cp.beforePhase(0, { description: 'phase 1' });
      await cp.afterPhase(0, { output: { ok: true }, summary: 'phase 1 done', producedBy: { name: 'Cell', tier: 2, viaFallback: false },
        trace: [{ kind: 'verdict-result', ts: '0', atom: 'Meristem', payload: { approved: true, reasoning: 'reviewed' } }],
        parentTests: [{ suiteDigest: 'd', workspaceDigest: 'w', status: 'unavailable', cause: 'runner-error', passed: 0, failed: 0, skipped: 0,
          details: 'crashed', judged: true }] });
      await cp.release();
    });
    expect(warnings).toContain('Durable continuation disabled: this phase did not close with a complete approved result');
    expect(data.completed).toEqual([]);
  });

  it('keeps the checkpoint out of nested dispatch contexts', () => {
    const ctx = makeCtx();
    Object.assign(ctx, { rootCheckpoint: {} });
    expect(forkBranch(ctx, 'child').rootCheckpoint).toBeUndefined();
  });

  // Group D, review 2026-10-16: the SHORT root called cell.plan once, so one
  // unparseable reply ended the run.
  describe('the SHORT root plan', () => {
    const plan = { reasoning: 'r', subtasks: [{ description: 'Write a.txt', outputs: ['a.txt'] }], aggregation: { mode: 'sequential' }, expectedOutput: 'a.txt' };
    const good = JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'r' }, plan]);
    const bad = good.replace('"reasoning":"r"', '"reasoning":"say "hi""');
    const cell = () => {
      const db = openDb(':memory:');
      const registry = new AtomRegistry(db);
      const type = registry.create(2, { description: 'cell', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' });
      const atom = L2Atom.fromType(type, registry);
      const delivered: Result = { output: 'done', summary: 'done', trace: [], producedBy: { tier: 2, name: atom.name, viaFallback: false } };
      atom.execute = async () => delivered;
      return { atom, delivered, close: () => db.close() };
    };

    it('asks the entry cell again after an unparseable reply, with the parser message', async () => {
      const { atom, delivered, close } = cell();
      const ctx = makeCtx();
      ctx.llm.enqueueText(bad);
      ctx.llm.enqueueText(good);
      await expect(shortRootHandle(atom)({ description: 'Write a.txt' }, ctx)).resolves.toBe(delivered);
      close();
      expect(ctx.llm.calls).toHaveLength(2);
      expect(ctx.llm.calls[1]?.userContent).toContain('plan reply unparseable');
      // On the planner channel (group G4): never merged into the task's constraints.
      expect(ctx.llm.calls[1]?.userContent).toContain('PREVIOUS PLAN ATTEMPT:');
      expect(ctx.llm.calls[1]?.userContent).not.toContain('Constraints:');
    });

    it('gives up after three unparseable replies', async () => {
      const { atom, close } = cell();
      const ctx = makeCtx();
      for (let i = 0; i < 3; i++) ctx.llm.enqueueText(bad);
      await expect(shortRootHandle(atom)({ description: 'Write a.txt' }, ctx)).rejects.toBeInstanceOf(PlanParseError);
      close();
      expect(ctx.llm.calls).toHaveLength(3);
    });
  });

  it('parses bounded pause/resume arguments', () => {
    expect(parseRunnerArgs(['--pause-after-phase', '2', 'goal'])).toMatchObject({ checkpoint: true, pauseAfterPhase: 2, goal: 'goal' });
    expect(() => parseRunnerArgs(['--pause-after-phase', '0', 'goal'])).toThrow('positive phase');
    expect(() => parseRunnerArgs(['--resume', '../elsewhere'])).toThrow('UUID');
  });
});
