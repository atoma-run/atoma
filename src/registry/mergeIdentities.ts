import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AtomRegistry, AtomType } from './atomRegistry.js';
import type { SkillRegistry } from '../skills/registry.js';

/**
 * MERGING IDENTITIES — `registry merge <winner> <losers…>` and
 * `atoma_registry_merge` (docs/registry-reconciliation-2026-10-10.md).
 *
 * `registry dedupe` groups by display NAME and never finds the clones the
 * catalogue actually holds (Water, Glucose, Sucrose: one signature, three
 * chemistry names), and when it merges it DROPS the losers' skill
 * namespaces. This is the merge the record asked for: the winner is named
 * by a person, the losers' recipes MOVE under the winner (an id the winner
 * already holds is absorbed as `skills merge` absorbs: the winner's body
 * and counters stay, the loser's matching surface joins it), the store and
 * every touched namespace are archived first, and `mergeInto` then moves
 * the counters and history as it always did.
 *
 * Three steps, on purpose: the PLAN is pure and says what would happen;
 * the ARCHIVE is the one asynchronous step (a SQLite online backup); the
 * APPLY is synchronous and takes the archive's path, so it cannot run
 * unarchived and can run inside a ledger scope, which refuses a promise.
 */

export interface IdentityMergeSkill {
  /** The loser's atom id (its namespace). */
  readonly from: string;
  readonly fromName: string;
  readonly id: string;
  /** `move`: the winner has no such id. `absorb`: it has; the loser's body and counters are lost. */
  readonly action: 'move' | 'absorb';
  readonly successes: number;
  readonly failures: number;
}

export interface IdentityMergePlan {
  readonly winner: AtomType;
  readonly losers: readonly AtomType[];
  readonly skills: readonly IdentityMergeSkill[];
  /** What stops the merge; empty when it may proceed. */
  readonly refusals: readonly string[];
}

/** A loser whose identity someone chose on purpose: refused without `force`. */
function deliberate(type: AtomType): boolean {
  return type.createdBy.startsWith('bootstrap-') || type.createdBy === 'user' || type.createdBy === 'platform-tissue-author';
}

export function planIdentityMerge(
  registry: AtomRegistry,
  skills: SkillRegistry,
  winnerName: string,
  loserNames: readonly string[],
  opts: { readonly force?: boolean } = {}
): IdentityMergePlan {
  const refusals: string[] = [];
  const winner = registry.getByName(winnerName);
  if (!winner) {
    return { winner: { name: winnerName } as AtomType, losers: [], skills: [], refusals: [`no agent type named "${winnerName}"`] };
  }
  if (loserNames.length === 0) refusals.push('a merge needs at least one loser');
  const seen = new Set<string>();
  const losers: AtomType[] = [];
  for (const name of loserNames) {
    if (seen.has(name)) { refusals.push(`"${name}" is listed twice`); continue; }
    seen.add(name);
    if (name === winnerName) { refusals.push(`"${name}" cannot be both the winner and a loser`); continue; }
    const loser = registry.getByName(name);
    if (!loser) { refusals.push(`no agent type named "${name}"`); continue; }
    if (loser.tier !== winner.tier) { refusals.push(`"${name}" is tier ${loser.tier}, the winner tier ${winner.tier}`); continue; }
    if (deliberate(loser) && !opts.force) {
      refusals.push(`"${name}" was created by ${loser.createdBy}, a deliberate identity: pass force to absorb it`);
      continue;
    }
    losers.push(loser);
  }
  const winnerIds = new Set(skills.loadFor(winner.atomId).map((skill) => skill.id));
  const moved: IdentityMergeSkill[] = [];
  for (const loser of losers) {
    for (const skill of skills.loadFor(loser.atomId)) {
      moved.push({
        from: loser.atomId, fromName: loser.name, id: skill.id,
        action: winnerIds.has(skill.id) ? 'absorb' : 'move',
        successes: skill.successes, failures: skill.failures,
      });
    }
  }
  return { winner, losers, skills: moved, refusals };
}

/**
 * The archive a merge needs before it writes: a SQLite online backup of the
 * store (the ledger lives in it) and a copy of every namespace the merge
 * touches, so `skills/<atom-id>/` of each loser and of the winner can be put
 * back beside a `registry rollback`. Returns the archive's directory;
 * `<store dir>/archives/registry-merge-<stamp>` by default.
 */
export async function archiveForMerge(args: {
  readonly db: Database.Database;
  readonly dbPath: string;
  readonly skills: SkillRegistry;
  readonly plan: IdentityMergePlan;
  readonly archiveRoot?: string;
}): Promise<string> {
  const { plan, skills } = args;
  if (plan.refusals.length > 0) throw new Error(`merge refused: ${plan.refusals.join('; ')}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = join(args.archiveRoot ?? join(dirname(args.dbPath), 'archives'), `registry-merge-${stamp}`);
  mkdirSync(archiveDir, { recursive: true });
  await args.db.backup(join(archiveDir, 'atoma.db'));
  for (const type of [plan.winner, ...plan.losers]) {
    const dir = join(skills.rootDir, type.atomId);
    if (existsSync(dir)) cpSync(dir, join(archiveDir, 'skills', type.atomId), { recursive: true });
  }
  return archiveDir;
}

export interface IdentityMergeResult {
  readonly winner: AtomType;
  readonly archiveDir: string;
  readonly moved: readonly string[];
  readonly absorbed: readonly string[];
  readonly relabelled: boolean;
}

/** The merge itself, after `archiveForMerge`: recipes first, then counters and history, then the label. */
export function applyIdentityMerge(args: {
  readonly registry: AtomRegistry;
  readonly skills: SkillRegistry;
  readonly plan: IdentityMergePlan;
  readonly modifiedBy: string;
  /** Where `archiveForMerge` put the archive: the proof it ran. */
  readonly archiveDir: string;
  /** A new description for the winner, applied after the merge as a label-only patch. */
  readonly relabel?: string;
}): IdentityMergeResult {
  const { plan, registry, skills } = args;
  if (plan.refusals.length > 0) throw new Error(`merge refused: ${plan.refusals.join('; ')}`);
  if (!existsSync(join(args.archiveDir, 'atoma.db'))) throw new Error(`merge refused: no archive at ${args.archiveDir}`);
  const moved: string[] = [];
  const absorbed: string[] = [];
  for (const loser of plan.losers) {
    const outcome = skills.moveNamespace(loser.atomId, plan.winner.atomId);
    moved.push(...outcome.moved.map((id) => `${loser.name}/${id}`));
    absorbed.push(...outcome.absorbed.map((id) => `${loser.name}/${id}`));
  }
  let winner = registry.mergeInto(plan.winner.name, plan.losers.map((loser) => loser.name));
  let relabelled = false;
  const relabel = args.relabel?.trim();
  if (relabel && relabel !== winner.description) {
    winner = registry.patch(winner.name, { descriptionReplace: relabel }, args.modifiedBy,
      `relabelled after absorbing ${plan.losers.map((loser) => loser.name).join(', ')}`);
    relabelled = true;
  }
  return { winner, archiveDir: args.archiveDir, moved, absorbed, relabelled };
}
