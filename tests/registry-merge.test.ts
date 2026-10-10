import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { applyIdentityMerge, archiveForMerge, planIdentityMerge } from '../src/registry/mergeIdentities.js';
import { projectCounters, readLedger } from '../src/core/ledger.js';
import { makeTools } from './helpers/factories.js';
import type Db from 'better-sqlite3';

/**
 * `registry merge` (docs/registry-reconciliation-2026-10-10.md): the identity
 * merge `dedupe` cannot find — it groups by display name — and would do
 * wrong — it drops the losers' skill namespaces. Here the recipes follow
 * their counters, the ledger projects them where they now are, and the
 * store and the touched namespaces are archived before anything moves.
 */
const dirs: string[] = [];
const handles: Db.Database[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-registry-merge-'));
  dirs.push(dir);
  const dbPath = join(dir, 'atoma.db');
  const db = openDb(dbPath);
  handles.push(db);
  const registry = new AtomRegistry(db);
  const skills = new SkillRegistry(join(dir, 'skills'), { db });
  const tools = makeTools(['read_file', 'write_file']);
  const seed = (createdBy: string, prompt: string) => ({ description: 'file scribe', systemPrompt: prompt, tools, params: {}, createdBy });
  const winner = registry.create(1, seed('bootstrap-canonical-filescribe', 'Canonical.'));
  const clone = registry.create(1, seed('Idioblast', 'An older template.'));
  const empty = registry.create(1, seed('Idioblast', 'Another template.'));
  const cell = registry.create(2, seed('Meristem', 'Supervise.'));
  registry.recordSuccess(winner.name);
  for (let i = 0; i < 3; i += 1) registry.recordSuccess(clone.name);
  registry.recordFailure(clone.name);
  const recipe = (id: string, body: string, whenToUse = `when ${id}`) => ({ id, description: id, whenToUse, kind: 'llm' as const, body });
  skills.save(winner.atomId, recipe('shared', 'the winner body', 'when shared by the winner'));
  skills.save(winner.atomId, recipe('keep', 'kept'));
  skills.recordSuccess(winner.atomId, 'shared');
  skills.save(clone.atomId, recipe('shared', 'the loser body', 'when shared by the loser'));
  skills.save(clone.atomId, recipe('only-clone', 'moves'));
  for (let i = 0; i < 4; i += 1) skills.recordSuccess(clone.atomId, 'only-clone');
  skills.recordFailure(clone.atomId, 'only-clone');
  skills.recordSuccess(clone.atomId, 'shared');
  return { dir, dbPath, db, registry, skills, winner, clone, empty, cell };
}

describe('planIdentityMerge', () => {
  it('refuses what cannot merge and names every reason', () => {
    const { registry, skills, winner, clone, cell } = fixture();
    expect(planIdentityMerge(registry, skills, 'Nobody', [clone.name]).refusals).toEqual(['no agent type named "Nobody"']);
    const plan = planIdentityMerge(registry, skills, clone.name, [winner.name, cell.name, clone.name, 'Ghost', winner.name]);
    expect(plan.refusals).toEqual([
      `"${winner.name}" was created by bootstrap-canonical-filescribe, a deliberate identity: pass force to absorb it`,
      `"${cell.name}" is tier 2, the winner tier 1`,
      `"${clone.name}" cannot be both the winner and a loser`,
      'no agent type named "Ghost"',
      `"${winner.name}" is listed twice`,
    ]);
    expect(planIdentityMerge(registry, skills, clone.name, [winner.name], { force: true }).refusals).toEqual([]);
  });

  it('says which recipes move and which the winner absorbs', () => {
    const { registry, skills, winner, clone, empty } = fixture();
    const plan = planIdentityMerge(registry, skills, winner.name, [clone.name, empty.name]);
    expect(plan.refusals).toEqual([]);
    expect(plan.losers.map((loser) => loser.name)).toEqual([clone.name, empty.name]);
    expect(plan.skills).toEqual([
      { from: clone.atomId, fromName: clone.name, id: 'only-clone', action: 'move', successes: 4, failures: 1 },
      { from: clone.atomId, fromName: clone.name, id: 'shared', action: 'absorb', successes: 1, failures: 0 },
    ]);
  });
});

describe('applyIdentityMerge', () => {
  it('archives, moves the recipes with their counters, sums the totals and relabels', async () => {
    const { dir, dbPath, db, registry, skills, winner, clone, empty } = fixture();
    const plan = planIdentityMerge(registry, skills, winner.name, [clone.name, empty.name]);
    const archiveDir = await archiveForMerge({ db, dbPath, skills, plan, archiveRoot: join(dir, 'archives') });
    const result = applyIdentityMerge({ registry, skills, plan, modifiedBy: 'test', relabel: 'file scribe, merged', archiveDir });

    // The archive: the store as it was, and every touched namespace.
    expect(result.archiveDir.startsWith(join(dir, 'archives', 'registry-merge-'))).toBe(true);
    const archived = new Database(join(result.archiveDir, 'atoma.db'), { readonly: true });
    expect((archived.prepare('SELECT COUNT(*) AS n FROM atom_types WHERE tier = 1').get() as { n: number }).n).toBe(3);
    archived.close();
    expect(readFileSync(join(result.archiveDir, 'skills', clone.atomId, 'only-clone', 'SKILL.md'), 'utf8')).toContain('moves');
    expect(readFileSync(join(result.archiveDir, 'skills', winner.atomId, 'shared', 'SKILL.md'), 'utf8')).toContain('the winner body');

    // The registry: one identity left, totals summed, streak reset by contract, relabelled.
    expect(registry.listByTier(1).map((type) => type.name)).toEqual([winner.name]);
    expect(result.winner).toMatchObject({ successes: 4, failures: 1, consecutiveSuccesses: 0, description: 'file scribe, merged' });
    expect(result.relabelled).toBe(true);
    expect(result.moved).toEqual([`${clone.name}/only-clone`]);
    expect(result.absorbed).toEqual([`${clone.name}/shared`]);

    // The recipes: moved with counters, absorbed into the winner's body and matching surface.
    const merged = new Map(skills.loadFor(winner.atomId).map((skill) => [skill.id, skill]));
    expect([...merged.keys()].sort()).toEqual(['keep', 'only-clone', 'shared']);
    expect(merged.get('only-clone')).toMatchObject({ successes: 4, failures: 1, body: 'moves' });
    expect(merged.get('shared')).toMatchObject({ successes: 1, failures: 0, body: 'the winner body', whenToUse: 'when shared by the winner; also: when shared by the loser' });
    expect(existsSync(join(dir, 'skills', clone.atomId))).toBe(false);
    expect(readdirSync(join(dir, 'skills'))).toEqual([winner.atomId]);

    // The ledger projects every counter where it now is.
    const projected = projectCounters(readLedger(db));
    expect(projected.get(winner.atomId)).toEqual({ successes: 4, failures: 1 });
    expect(projected.get(`${winner.atomId}/only-clone`)).toEqual({ successes: 4, failures: 1 });
    expect(projected.get(`${winner.atomId}/shared`)).toEqual({ successes: 1, failures: 0 });
    expect(readLedger(db).filter((event) => event.kind === 'type-merge')).toHaveLength(1);
  });

  it('never reissues a loser\'s name: the merge leaves a tombstone at its ordinal', async () => {
    const { dir, dbPath, db, registry, skills, winner, clone, empty } = fixture();
    const plan = planIdentityMerge(registry, skills, winner.name, [clone.name, empty.name]);
    const archiveDir = await archiveForMerge({ db, dbPath, skills, plan, archiveRoot: join(dir, 'archives') });
    applyIdentityMerge({ registry, skills, plan, modifiedBy: 'test', archiveDir });
    // Production, 2026-10-10: Water's next escalation branch came out named Glucose.
    const next = registry.create(1, { description: 'd', systemPrompt: 'p', tools: makeTools(['read_file']), params: {}, createdBy: 'Idioblast' });
    expect([clone.name, empty.name]).not.toContain(next.name);
    expect(next.ordinal).toBeGreaterThan(Math.max(clone.ordinal, empty.ordinal));
  });

  it('the winner can be patched and rolled back after the merge: its versions stay unique and rising', async () => {
    const { dir, dbPath, db, registry, skills, winner, clone, empty } = fixture();
    const plan = planIdentityMerge(registry, skills, winner.name, [clone.name, empty.name]);
    const archiveDir = await archiveForMerge({ db, dbPath, skills, plan, archiveRoot: join(dir, 'archives') });
    const merged = applyIdentityMerge({ registry, skills, plan, modifiedBy: 'test', archiveDir }).winner;
    // Production run 35178ec3 (2026-10-10): the second patch after the merge
    // archived the live content at a version the transplanted history held.
    const archived = registry.listVersions(winner.name).map((row) => row.version);
    expect(merged.version).toBeGreaterThan(Math.max(...archived));
    const once = registry.patch(winner.name, { systemPromptAppend: 'one' }, 'test');
    const twice = registry.patch(winner.name, { systemPromptAppend: 'two' }, 'test');
    const back = registry.rollback(winner.name, once.version, 'test');
    const versions = registry.listVersions(winner.name).map((row) => row.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(back.version).toBeGreaterThan(twice.version);
    expect(twice.version).toBeGreaterThan(once.version);
    expect(back.systemPrompt).toBe(once.systemPrompt);
  });

  it('refuses a plan that carries refusals and an apply without its archive, and writes nothing', async () => {
    const { dir, dbPath, db, registry, skills, winner, clone } = fixture();
    const refused = planIdentityMerge(registry, skills, clone.name, [winner.name]);
    await expect(archiveForMerge({ db, dbPath, skills, plan: refused, archiveRoot: join(dir, 'archives') })).rejects.toThrow(/merge refused/);
    expect(existsSync(join(dir, 'archives'))).toBe(false);
    const plan = planIdentityMerge(registry, skills, winner.name, [clone.name]);
    expect(() => applyIdentityMerge({ registry, skills, plan, modifiedBy: 'test', archiveDir: join(dir, 'nowhere') })).toThrow(/no archive/);
    expect(registry.listByTier(1)).toHaveLength(3);
    expect(skills.loadFor(clone.atomId)).toHaveLength(2);
  });
});
