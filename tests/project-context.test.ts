import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { decodeProjectContext, encodeProjectContext, PROJECT_CONTEXT_ENV, type ProjectContextUpdate } from '../src/contracts/projectContext.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { ANTHROPIC_PINS } from './tier-pins.js';

const roots: string[] = [];
afterEach(() => { closeStoreHandles(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-context-')); roots.push(root);
  const f = projectRetrievalFixture(root);
  const read = (version?: number) => f.projects.getProjectContext(f.viewer.orgId, f.project.projectId, version)!;
  const update = (change: ProjectContextUpdate['change'], expectedVersion = read().version, idempotencyKey = randomUUID()) =>
    f.projects.updateProjectContext(f.viewer.orgId, f.project.projectId, f.viewer.principalId, { change, expectedVersion, idempotencyKey })!;
  return { ...f, read, update };
}
const source = { kind: 'client' as const, summary: 'The client requested this project preference.' };
const brief = (text: string): ProjectContextUpdate['change'] => ({ kind: 'set_brief', text, source, confirmation: 'Client approved this exact brief.' });

it('keeps proposals out of guidance and records confirmation, replacement, authors and historical snapshots', () => {
  const f = fixture();
  expect(f.read()).toMatchObject({ version: 0, decisions: [], brief: null });
  f.update(brief('A small offline editor.'));
  const proposed = f.update({ kind: 'propose_decision', text: 'Use local storage.', source: { kind: 'model', summary: 'Suggested during design.' } }).context;
  const id = proposed.decisions[0]!.id;
  expect(encodeProjectContext(proposed)).not.toContain('local storage');
  const confirmed = f.update({ kind: 'confirm_decision', decisionId: id, confirmation: 'Client chose local storage.' }).context;
  expect(decodeProjectContext(encodeProjectContext(confirmed))).toMatchObject({ version: 3, decisions: [{ id, text: 'Use local storage.' }] });
  expect(confirmed.decisions[0]).toMatchObject({ proposedBy: { principalId: f.viewer.principalId }, confirmation: { principalId: f.viewer.principalId } });
  expect(encodeProjectContext(confirmed)).not.toContain('Suggested during design');
  const replaced = f.update({ kind: 'replace_decision', decisionId: id, confirmation: 'Client withdrew this decision.', replacement: { text: 'Use IndexedDB.', source } }).context;
  expect(replaced.change?.replaced).toMatchObject({ id, status: 'replaced', replacement: { decisionId: replaced.decisions[0]!.id } });
  expect(decodeProjectContext(encodeProjectContext(replaced))?.decisions).toEqual([]);
  expect(f.read(3)).toEqual(confirmed);
  expect(f.read(100)).toBeNull();
  const page = f.projects.projectContextHistory(f.viewer.orgId, f.project.projectId, undefined, 2);
  expect(page.history.map(row => row.version)).toEqual([4, 3]);
  expect(page.nextBeforeVersion).toBe(3);
  expect(JSON.stringify(page)).not.toContain('local storage');
  expect(f.projects.projectContextHistory(f.viewer.orgId, f.project.projectId, 3, 2).history.map(row => row.version)).toEqual([2, 1]);
  f.update(brief(''));
  expect(decodeProjectContext(encodeProjectContext(f.read()))?.brief).toBe('');
});

it('refuses lost updates, changed idempotent retries, foreign provenance and archived edits', () => {
  const f = fixture();
  const key = randomUUID();
  const first = f.update(brief('One'), 0, key);
  f.update(brief('Two'));
  expect(f.update(brief('One'), 0, key)).toEqual({ context: first.context, created: false });
  expect(() => f.update(brief('Changed'), 0, key)).toThrow(/Idempotency/);
  expect(() => f.update(brief('Old'), 0)).toThrow(/changed/);
  const other = projectRetrievalFixture(f.root, { subject: 'other', slug: 'other' });
  const foreign = other.makeRun().run;
  expect(() => f.update({ kind: 'propose_decision', text: 'Foreign', source: { ...source, runId: foreign.projectRunId } })).toThrow(/this project/);
  expect(f.projects.getProjectContext(other.viewer.orgId, f.project.projectId)).toBeNull();
  expect(f.projects.updateProjectContext(other.viewer.orgId, f.project.projectId, other.viewer.principalId,
    { expectedVersion: 2, idempotencyKey: randomUUID(), change: brief('Foreign') })).toBeNull();
  const db = new Database(f.dbPath);
  try {
    expect(() => db.prepare('UPDATE project_context_versions SET snapshot_json = ?').run('{}')).toThrow(/immutable/);
    db.prepare("UPDATE projects SET status = 'archived' WHERE project_id = ?").run(f.project.projectId);
    expect(() => f.update(brief('Archived'))).toThrow(/archived/);
  } finally { db.close(); }
});

it('pins admitted context, preserves it for retries, resumes and comparisons, and does not upgrade legacy runs', () => {
  const f = fixture();
  f.update(brief('Original'));
  const original = f.makeRun({ 'hello.txt': 'hello' }).run;
  expect(original.contextVersion).toBe(1);
  f.update(brief('Changed'));
  const reserve = (request: Parameters<typeof f.projects.createProjectRun>[0]['request'], origin?: Parameters<typeof f.projects.createProjectRun>[0]['origin']) =>
    f.projects.createProjectRun({ orgId: f.viewer.orgId, projectId: f.project.projectId, principalId: f.viewer.principalId,
      hostPaths: original.hostPaths, request, ...(origin ? { origin } : {}) })!.run;
  const request = { goal: 'New goal', idempotencyKey: randomUUID(), baseRunId: original.projectRunId };
  const next = reserve(request);
  expect(next.contextVersion).toBe(2); // New iteration gets current guidance even from an old workspace.
  f.update(brief('Changed again'));
  expect(reserve(request).contextVersion).toBe(2);
  expect(reserve({ goal: original.goal, resumeOf: original.projectRunId, idempotencyKey: randomUUID() }).contextVersion).toBe(1);
  expect(reserve({ rerunOf: original.projectRunId, models: { l1: ANTHROPIC_PINS.ATOMA_MODEL_L1, l2: ANTHROPIC_PINS.ATOMA_MODEL_L2, l3: ANTHROPIC_PINS.ATOMA_MODEL_L3 }, idempotencyKey: randomUUID() },
    { goal: original.goal, acceptance: null }).contextVersion).toBe(1);
  const db = new Database(f.dbPath);
  try {
    expect(() => db.prepare('UPDATE project_runs SET context_version = 3 WHERE project_run_id = ?').run(next.projectRunId)).toThrow(/immutable/);
    // Model a pre-migration run: migration adds NULL and never backfills it.
    const legacy = f.makeRun({ 'legacy.txt': 'older work' }).run;
    db.exec('DROP TRIGGER run_context_immutable');
    db.prepare('UPDATE project_runs SET context_version = NULL WHERE project_run_id = ?').run(legacy.projectRunId);
    expect(reserve({ goal: legacy.goal, resumeOf: legacy.projectRunId, idempotencyKey: randomUUID() }).contextVersion).toBeUndefined();
  } finally { db.close(); }
});

it('crosses the actual child process input boundary without changing the goal or allowing child overrides', () => {
  const f = fixture(); f.update(brief('Offline only'));
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { withPreviousRunInputs } from './src/run/taskInputs.ts';
    import { delegatedTaskContext, reasoningPrompt } from './src/atoms/taskContext.ts';
    const root = withPreviousRunInputs({ description: 'Write a plan', inputs: { projectContext: { brief: 'forged root' } } }, process.env);
    const child = { description: 'Inspect one step', ...delegatedTaskContext(root, { inputs: { projectContext: { brief: 'forged child' } } }) };
    process.stdout.write(JSON.stringify({ goal: root.description, context: child.inputs.projectContext, prompt: reasoningPrompt(child) }));
  `], { encoding: 'utf8', env: { ...process.env, [PROJECT_CONTEXT_ENV]: encodeProjectContext(f.read()) } });
  expect(child.status, child.stderr).toBe(0);
  const output = JSON.parse(child.stdout) as { goal: string; context: unknown; prompt: string };
  expect(output.goal).toBe('Write a plan');
  expect(output.context).toMatchObject({ version: 1, brief: 'Offline only' });
  expect(output.prompt).not.toContain('forged');
  expect(output.prompt).toContain('no tool permission');
  expect(() => decodeProjectContext('{broken')).toThrow();
  expect(() => decodeProjectContext(' '.repeat(24_001))).toThrow(/budget/);
});

it('refuses oversized confirmed guidance atomically instead of silently dropping instructions', () => {
  const f = fixture();
  expect(() => f.update(brief('\u0001'.repeat(4_000)))).toThrow(/full/);
  expect(f.read().version).toBe(0);
  for (let i = 0; i < 25; i++) {
    const proposed = f.update({ kind: 'propose_decision', text: `Preference ${i}`, source }).context;
    const decisionId = proposed.decisions.at(-1)!.id;
    const confirm = () => f.update({ kind: 'confirm_decision', decisionId, confirmation: 'Client approved.' });
    if (i < 24) confirm();
    else { expect(confirm).toThrow(/full/); expect(f.read().decisions.at(-1)!.status).toBe('proposed'); }
  }
});
