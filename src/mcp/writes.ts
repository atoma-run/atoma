import { unfoldedRegistryPredicate } from '../registry/db.js';
/**
 * The OPERATOR WRITES of the MCP surface — the four catalogue-hygiene verbs
 * the CLI has had all along (`skills reset|drop|merge`, `registry rollback`),
 * reached over the MCP by a platform-tier caller.
 *
 * WHY THIS IS A CONTRACT CHANGE AND NOT AN INCREMENT. Until now only the run
 * tools mutated anything, and the skills contract requires every operator
 * lifecycle action to be ATTRIBUTABLE. The CLI discharges that through the
 * lifecycle ledger alone, because the CLI has no principal — possession of the
 * machine is the identity. A bearer token DOES have one, so every write here
 * does two things the CLI cannot: it names its actor, and on a gated host it
 * journals the action as a platform event carrying that actor (`skill.reset`,
 * `skill.dropped`, `skill.merged`, `registry.rolled_back`). The lifecycle
 * ledger rows the store methods append are unchanged — one ledger, one set of
 * choke points — so `ledger check` still projects the same counters.
 *
 * THE SAME REFUSALS AS THE CLI, IN THE SAME WORDS. Dropping or absorbing a
 * skill with recorded successes deletes proven knowledge and is refused
 * without `force`; a rollback to the live version is a no-op the registry
 * itself refuses. Nothing here is a new rule — the CLI's own guards, reached
 * through a second door, must not be looser.
 *
 * WRITE HANDLES. The readers open `{ readonly: true }` handles on purpose;
 * these open the store through `openDb` — the one path that runs the schema
 * and migrations — exactly as the CLI does, and close it before returning.
 *
 * LEDGER SCOPE (T7). The lifecycle rows those store methods append carry the
 * actor too, through `withLedgerScope` around each SYNCHRONOUS write: this
 * process serves every organisation, so a process-wide scope would attribute
 * one request's write to another's principal. The scope names the principal
 * and organisation of a bearer, or `cli` for the loopback operator — the same
 * mapping `journal` applies to the platform event.
 */

import { existsSync } from 'node:fs';
import { type PlatformEventInput, type PlatformEventSink, eventLabel } from '../contracts/platformEvents.js';
import { withLedgerScope, type LedgerScope } from '../core/ledger.js';
import { skillsDirPath, storeDbPath } from '../core/stores.js';
import { AtomRegistry } from '../registry/atomRegistry.js';
import { applyIdentityMerge, archiveForMerge, planIdentityMerge } from '../registry/mergeIdentities.js';
import { capabilityDescription } from '../atoms/capability.js';
import { openDb } from '../registry/db.js';
import { resolveMoleculeRef } from '../skills/namespace.js';
import { SkillRegistry } from '../skills/registry.js';
import { promoteThreshold, trustThreshold } from '../atoms/cost.js';
import Database from 'better-sqlite3';

/** Who performed a write: the principal behind a bearer, or the loopback operator. */
export type OperatorActor =
  | { readonly kind: 'principal'; readonly principalId: string; readonly orgId: string; readonly label: string }
  | { readonly kind: 'operator'; readonly label: string };

export class WriteRefused extends Error {}

/** atom id → display name, through a short-lived readonly handle (absent store → empty). */
function labels(): Map<string, string> {
  const out = new Map<string, string>();
  const dbPath = storeDbPath();
  if (!existsSync(dbPath)) return out;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    for (const r of db.prepare(`SELECT atom_id, name FROM atom_types WHERE ${unfoldedRegistryPredicate(db)}`).all() as { atom_id: string | null; name: string }[]) {
      if (r.atom_id) out.set(r.atom_id, r.name);
    }
  } catch {
    /* unreadable store — fall back to raw keys */
  } finally {
    db.close();
  }
  return out;
}

function journal(emit: PlatformEventSink | undefined, actor: OperatorActor, event: Omit<PlatformEventInput, 'actorType' | 'actorId' | 'orgId'>): boolean {
  if (!emit) return false;
  emit({
    ...event,
    actorType: actor.kind === 'principal' ? 'principal' : 'cli',
    actorId: actor.kind === 'principal' ? actor.principalId : null,
    orgId: actor.kind === 'principal' ? actor.orgId : null,
  });
  return true;
}

/** The lifecycle-ledger scope of a write: who did it, and for which organisation. */
export function ledgerScopeOf(actor: OperatorActor): LedgerScope {
  return actor.kind === 'principal'
    ? { orgId: actor.orgId, actorType: 'principal', actorId: actor.principalId }
    : { actorType: 'cli' };
}

function resolveSkill(l1: string, id: string) {
  const dir = skillsDirPath();
  const reg = new SkillRegistry(dir);
  const names = labels();
  const ref = resolveMoleculeRef(l1, names);
  const skill = reg.loadFor(ref.atomId).find((s) => s.id === id) ?? null;
  return { dir, reg, ref, skill };
}

/** `skills reset`: counters to zero, refusal stamp cleared, trust re-earned from scratch. */
export function skillReset(input: { l1: string; id: string; actor: OperatorActor; emit?: PlatformEventSink }): unknown {
  const { dir, reg, ref, skill } = resolveSkill(input.l1, input.id);
  if (!skill) throw new WriteRefused(`no skill "${input.id}" for molecule "${input.l1}" under ${dir}`);
  withLedgerScope(ledgerScopeOf(input.actor), () => reg.resetCounters(ref.atomId, input.id));
  const journaled = journal(input.emit, input.actor, {
    kind: 'skill.reset',
    summary: `skill ${eventLabel(ref.name)}/${eventLabel(input.id)} counters reset by ${input.actor.label}`,
    detail: { l1: ref.name, l1Key: ref.atomId, id: input.id, before: { successes: skill.successes, failures: skill.failures, promotionRefusedAt: skill.promotionRefusedAt ?? null } },
  });
  return {
    reset: { l1: ref.name, l1Key: ref.atomId, id: input.id },
    before: { successes: skill.successes, failures: skill.failures, promotionRefusedAt: skill.promotionRefusedAt ?? null },
    after: { successes: 0, failures: 0, promotionRefusedAt: null },
    actor: input.actor.label,
    journaled,
    note: `Counters and refusal stamp cleared: a script dispatches deterministically again at once; an llm recipe re-attempts compilation after ${Math.max(1, promoteThreshold())} credited run(s).`,
  };
}

/** `skills drop`: delete a recipe; proven knowledge (successes > 0) needs force. */
export function skillDrop(input: { l1: string; id: string; force?: boolean; actor: OperatorActor; emit?: PlatformEventSink }): unknown {
  const { dir, reg, ref, skill } = resolveSkill(input.l1, input.id);
  if (!skill) throw new WriteRefused(`no skill "${input.id}" for molecule "${input.l1}" under ${dir}`);
  if (skill.successes > 0 && !input.force) {
    throw new WriteRefused(
      `refusing to drop ${ref.name}/${input.id}: it has ${skill.successes} recorded success(es) — proven knowledge. Pass force to drop it anyway.`
    );
  }
  withLedgerScope(ledgerScopeOf(input.actor), () => reg.drop(ref.atomId, input.id));
  const journaled = journal(input.emit, input.actor, {
    kind: 'skill.dropped',
    summary: `skill ${eventLabel(ref.name)}/${eventLabel(input.id)} dropped by ${input.actor.label}`,
    detail: { l1: ref.name, l1Key: ref.atomId, id: input.id, kind: skill.kind, successes: skill.successes, failures: skill.failures, matches: skill.matches ?? 0, forced: Boolean(input.force) },
  });
  return {
    dropped: { l1: ref.name, l1Key: ref.atomId, id: input.id, kind: skill.kind, successes: skill.successes, failures: skill.failures, matches: skill.matches ?? 0 },
    actor: input.actor.label,
    journaled,
  };
}

/** `skills merge`: the keeper absorbs the other's when_to_use; the absorbed body is deleted. */
export function skillMerge(input: { l1: string; keep: string; absorb: string; force?: boolean; actor: OperatorActor; emit?: PlatformEventSink }): unknown {
  const { dir, reg, ref } = resolveSkill(input.l1, input.keep);
  const skills = reg.loadFor(ref.atomId);
  const keep = skills.find((s) => s.id === input.keep) ?? null;
  const absorb = skills.find((s) => s.id === input.absorb) ?? null;
  if (!keep || !absorb) {
    const missing = [!keep && input.keep, !absorb && input.absorb].filter(Boolean).join(', ');
    throw new WriteRefused(`merge needs two existing skills; missing: ${missing} (molecule "${input.l1}", ${dir})`);
  }
  if (input.keep === input.absorb) throw new WriteRefused('merge needs two DIFFERENT skills');
  if (absorb.successes > 0 && !input.force) {
    throw new WriteRefused(
      `refusing to absorb ${ref.name}/${input.absorb}: its body has ${absorb.successes} recorded success(es) and would be DELETED. If that body is the one worth keeping, merge in the other direction; otherwise pass force.`
    );
  }
  const merged = withLedgerScope(ledgerScopeOf(input.actor), () => reg.merge(ref.atomId, input.keep, input.absorb));
  if (!merged) throw new WriteRefused('merge failed (a skill vanished mid-operation)');
  const journaled = journal(input.emit, input.actor, {
    kind: 'skill.merged',
    summary: `skill ${eventLabel(ref.name)}/${eventLabel(input.absorb)} merged into ${eventLabel(input.keep)} by ${input.actor.label}`,
    detail: { l1: ref.name, l1Key: ref.atomId, keep: input.keep, absorb: input.absorb, absorbedSuccesses: absorb.successes, absorbedFailures: absorb.failures, forced: Boolean(input.force) },
  });
  return {
    merged: { l1: ref.name, l1Key: ref.atomId, keep: input.keep, absorbed: input.absorb },
    keeper: { successes: merged.successes, failures: merged.failures, whenToUse: merged.whenToUse },
    absorbedCountersLost: { successes: absorb.successes, failures: absorb.failures },
    actor: input.actor.label,
    journaled,
    note: 'The keeper’s body, counters and kind are untouched; the absorbed body and its counters are gone.',
  };
}

/**
 * `registry merge`: absorb named losers into a winner — counters and history
 * through `mergeInto`, recipes moved under the winner, the store and the
 * touched namespaces archived first (docs/registry-reconciliation-2026-10-10.md).
 * `dryRun` answers with the plan and writes nothing.
 */
export async function registryMerge(input: {
  winner: string; losers: string[]; relabel?: string; force?: boolean; dryRun?: boolean; actor: OperatorActor; emit?: PlatformEventSink;
}): Promise<unknown> {
  const dbPath = storeDbPath();
  if (!existsSync(dbPath)) throw new WriteRefused(`no agent store at ${dbPath}`);
  const db = openDb(dbPath);
  try {
    const registry = new AtomRegistry(db);
    const skills = new SkillRegistry(skillsDirPath(), { db });
    const plan = planIdentityMerge(registry, skills, input.winner, input.losers, { force: Boolean(input.force) });
    const relabel = input.relabel === 'canonical' && plan.refusals.length === 0
      ? capabilityDescription(plan.winner.tools, plan.winner.tier)
      : input.relabel;
    const planned = {
      winner: { name: plan.winner.name, tier: plan.winner.tier, successes: plan.winner.successes, failures: plan.winner.failures, description: plan.winner.description },
      losers: plan.losers.map((loser) => ({ name: loser.name, createdBy: loser.createdBy, successes: loser.successes, failures: loser.failures, consecutiveSuccesses: loser.consecutiveSuccesses })),
      skills: plan.skills,
      relabel: relabel ?? null,
      refusals: plan.refusals,
    };
    if (plan.refusals.length > 0) throw new WriteRefused(`merge refused: ${plan.refusals.join('; ')}`);
    if (input.dryRun) {
      return { dryRun: true, ...planned, actor: input.actor.label, note: 'Nothing was written. Call again without dryRun to archive, then merge.' };
    }
    // The archive is the one asynchronous step and runs OUTSIDE the ledger
    // scope, which refuses a promise; the merge itself is synchronous inside it.
    const archiveDir = await archiveForMerge({ db, dbPath, skills, plan });
    const result = withLedgerScope(ledgerScopeOf(input.actor), () =>
      applyIdentityMerge({ registry, skills, plan, modifiedBy: input.actor.label, archiveDir, ...(relabel !== undefined ? { relabel } : {}) }));
    const journaled = journal(input.emit, input.actor, {
      kind: 'registry.merged',
      summary: `agent types ${plan.losers.map((loser) => eventLabel(loser.name)).join(', ')} merged into ${eventLabel(plan.winner.name)} by ${input.actor.label}`,
      detail: {
        winner: plan.winner.name, tier: plan.winner.tier, losers: plan.losers.map((loser) => loser.name),
        successes: plan.losers.reduce((sum, loser) => sum + loser.successes, 0),
        failures: plan.losers.reduce((sum, loser) => sum + loser.failures, 0),
        skillsMoved: result.moved.length, skillsAbsorbed: result.absorbed.length, relabelled: result.relabelled, archiveDir: result.archiveDir,
      },
    });
    return {
      dryRun: false,
      ...planned,
      merged: { name: result.winner.name, successes: result.winner.successes, failures: result.winner.failures, consecutiveSuccesses: result.winner.consecutiveSuccesses, description: result.winner.description, version: result.winner.version },
      skillsMoved: result.moved, skillsAbsorbed: result.absorbed, archiveDir: result.archiveDir,
      actor: input.actor.label, journaled,
      note: 'Losers deleted, their totals summed into the winner (its streak resets by contract), their history archived under the winner’s versions, their recipes moved; absorbed recipes lost their body and counters. The archive holds the store and every touched namespace as they were.',
    };
  } finally {
    db.close();
  }
}

/** `registry rollback`: restore an old version's content as a NEW live version; trust resets. */
export function registryRollback(input: { name: string; toVersion: number; actor: OperatorActor; emit?: PlatformEventSink }): unknown {
  const dbPath = storeDbPath();
  if (!existsSync(dbPath)) throw new WriteRefused(`no agent store at ${dbPath}`);
  if (!Number.isInteger(input.toVersion) || input.toVersion < 1) throw new WriteRefused('toVersion must be a positive integer');
  const db = openDb(dbPath);
  try {
    const registry = new AtomRegistry(db);
    const before = registry.getByName(input.name);
    if (!before) throw new WriteRefused(`no agent type named "${input.name}"`);
    let after;
    try {
      after = withLedgerScope(ledgerScopeOf(input.actor), () =>
        registry.rollback(input.name, input.toVersion, input.actor.label));
    } catch (error: unknown) {
      // The registry's own refusals (unknown version, already live) become
      // tool refusals the host can show; they are domain answers, not faults.
      throw new WriteRefused(error instanceof Error ? error.message : String(error));
    }
    const noop = after.version === before.version;
    const journaled = noop
      ? false
      : journal(input.emit, input.actor, {
          kind: 'registry.rolled_back',
          summary: `agent type ${eventLabel(input.name)} rolled back to v${input.toVersion} (now v${after.version}) by ${input.actor.label}`,
          detail: { name: input.name, tier: before.tier, fromVersion: before.version, toVersion: input.toVersion, liveVersion: after.version, trustBefore: { successes: before.successes, failures: before.failures, consecutiveSuccesses: before.consecutiveSuccesses } },
        });
    return {
      name: input.name,
      tier: before.tier,
      noop,
      fromVersion: before.version,
      restoredVersion: input.toVersion,
      liveVersion: after.version,
      trustThreshold: trustThreshold(),
      trustBefore: { successes: before.successes, failures: before.failures, consecutiveSuccesses: before.consecutiveSuccesses },
      trustAfter: { successes: after.successes, failures: after.failures, consecutiveSuccesses: after.consecutiveSuccesses },
      actor: input.actor.label,
      journaled,
      note: noop
        ? `v${input.toVersion} content is identical to the live version; nothing changed.`
        : /^bootstrap-/.test(after.createdBy)
          ? 'Trust streak reset; historical success/failure totals preserved. The restored type re-earns trust through consecutive approved final results. This is a canonical/bootstrap type: its seeder re-aligns the prompt on the next run and will patch this rollback away if the seed differs.'
          : 'Trust streak reset; historical success/failure totals preserved. The restored type re-earns trust through consecutive approved final results. description is not versioned and was kept as-is.',
    };
  } finally {
    db.close();
  }
}
