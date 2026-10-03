import { SMOKE_DESIGN_GUIDANCE } from '../atoms/prompts.js';
import { repairTaskBakedPrompts } from '../atoms/promptRepair.js';
import {
  ensureCanonicalL1,
  ensureCanonicalL2,
  ensureCanonicalHttpL1,
  ensureCanonicalHttpL2,
  ensureCanonicalFileScribeL1,
  ensureCanonicalFullStack,
  ensureCanonicalProjectDocsL1,
} from '../atoms/capability.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace as prepareWorkspaceRoot } from './workspace.js';
import { DEFAULT_DB_PATH } from '../core/stores.js';
import type { AtomRegistry } from '../registry/atomRegistry.js';
import type { Tool } from '../core/types.js';
import type { DepthMode, ProofFloor } from '../contracts/depthRouting.js';

/**
 * The technical setup of a run: where it keeps its workspace and store, how
 * its catalog is seeded, and its supervision depth contract.
 *
 * There is ONE run and so one setup. It used to be a `TaskProfile` selected
 * by a family id, back when the family chose the root agent; the root is now
 * chosen from the task by `selectTissue`, so nothing varies between runs here
 * and the interface with a single implementation was removed (2026-10-03).
 * The request owns the task and the runner owns the tissue: no setup may bind
 * a root tissue or inject business constraints into every request.
 */

/** Env var NAMES a run reads (values are resolved by the runner). */
export const RUN_ENV = {
  // THE STORE IS NOT PER-TASK, so its env var is not either. This said
  // `ATOMA_BUILD_DB_PATH` while every CLI read `ATOMA_DB_PATH`, and the
  // mismatch is what grew four different `existsSync('./atoma-build.db')`
  // probes across the CLIs and the viz. A catalog of atom types and skills
  // is deliberately shared (see `resolveCreationDescription`, which strips
  // task themes precisely so a type earns reuse beyond the task that
  // spawned it).
  dbPath: 'ATOMA_DB_PATH',
  workspace: 'ATOMA_BUILD_WORKSPACE',
  timeoutMs: 'ATOMA_BUILD_TIMEOUT_MS',
} as const;

/**
 * Where runs get their scratch directory.
 *
 * Under the user's home rather than the repo, and STABLE across runs rather
 * than a fresh temp dir: the workspace holds the deliverable, and a human
 * inspects it after the run finishes (`prepareWorkspace` archives by rename
 * for the same reason — a wrong call must stay recoverable). An OS tmpdir
 * would be swept out from under that.
 *
 * Overridable with ATOMA_BUILD_WORKSPACE, which the burn-in harness does not
 * set — so batches share one workspace and rely on `--clean-workspace`,
 * exactly as before the move.
 */
export function defaultWorkspaceRoot(): string {
  return join(homedir(), '.atoma', 'workspaces', 'build');
}

/** Fallbacks when the corresponding env var is unset. */
export const RUN_DEFAULTS = {
  dbPath: DEFAULT_DB_PATH,
  // OUTSIDE THE REPO, deliberately. The workspace used to be `./build/app`,
  // two `..` hops below the atom registry, every skill body, the ledger and
  // the user's own uncommitted git work — and `run_shell`'s child is NOT
  // jailed to the workspace, it merely starts there (`builtin.ts` spawns
  // with `cwd`, nothing more). REPRODUCED: `ls ../../atoma-build.db
  // ../../skills` from a sandbox listed the registry and every learned
  // recipe.
  //
  // This is a BLAST-RADIUS REDUCTION, NOT A BOUNDARY, and the distinction
  // matters: an absolute path still reaches anything the user can read.
  // What it buys is that the casual traversal — a model running `ls ..` to
  // orient itself, or a stray `rm -rf ..` in generated cleanup code — now
  // lands in a scratch tree instead of the repository. A real boundary is
  // an OS one (container/VM) and belongs to deployment; see
  // docs/saas-architecture.md §3 and invariant T1. Do not describe this
  // line as isolation.
  //
  // It also removes the CAUSE of the ESM module-resolution leak rather
  // than compensating for it: the workspace no longer sits under a
  // package.json saying `"type": "module"`, so
  // `ensureModuleResolutionBoundary` goes inert here (it stays, and still
  // fires, for anyone who points the workspace back inside a module repo).
  workspace: defaultWorkspaceRoot(),
} as const;

/** Prefix of the viz trace label of a run. */
export const TRACE_LABEL_PREFIX = 'run: ';

/** Prepare the workspace directory, BEFORE the sandbox is constructed. */
export function prepareWorkspace(root: string, clean: boolean): void {
  // `ToolSandbox` realpath-resolves its root at construction, so archiving
  // the directory afterwards would leave every tool pointing at the archive.
  prepareWorkspaceRoot(root, clean);
}

/** What the runner hands the seeding hooks. */
export interface SeedContext {
  readonly registry: AtomRegistry;
  readonly toolDecls: readonly Tool[];
  /**
   * Console sink. Passed in rather than letting seeding call `console.log`
   * directly so the runner owns the output stream — the burn-in harness
   * parses that stream, which makes it an API rather than decoration.
   */
  readonly log: (line: string) => void;
}

/** Supervision depth policy. The floor is fixed before either planner runs. */
export const DEPTH_CONTRACT: {
  readonly defaultMode: DepthMode;
  readonly floor: ProofFloor;
  entryCell(ctx: SeedContext): ReturnType<typeof ensureCanonicalL2>;
} = {
  defaultMode: 'deep',
  // Runs also build APIs and CLIs. No universal HTML deliverable exists.
  // Empty floors still receive semantic root review; plans declare UI obligations.
  floor: [],
  entryCell({ registry, toolDecls }) {
    const cell = ensureCanonicalFullStack(registry, toolDecls, 2);
    if (!cell) throw new Error('Depth routing requires the full-stack tool set');
    return cell;
  },
};

/** Seed the canonical L2/L1 catalog the prefilter will match against. */
export function seedCatalog({ registry, toolDecls, log }: SeedContext): void {
  // Bootstrap canonical L2 + L1 catalog entries. These are capability-
  // focused, domain-neutral atoms seeded so L3/L2 prefilter has a clean
  // reusable target on every run — without them the first build on a
  // fresh registry spawns a bespoke (and usually theme-poisoned) clone
  // of the same "single-file web artefact" recipe we already know how
  // to execute. Idempotent: we match by the `CANONICAL_BOOTSTRAP_MARKER`
  // in `createdBy`, refreshing tools on each run so the canonical
  // catalog follows the current executor set.
  const canonicalL2Web = ensureCanonicalL2(registry, toolDecls);
  log(
    `canonical L2 (web): ${canonicalL2Web.name} (v${canonicalL2Web.version}) — ${canonicalL2Web.description.slice(0, 70)}…`
  );
  const canonicalL2Http = ensureCanonicalHttpL2(registry, toolDecls);
  log(
    `canonical L2 (http): ${canonicalL2Http.name} (v${canonicalL2Http.version}) — ${canonicalL2Http.description.slice(0, 70)}…`
  );
  const canonicalL1Web = ensureCanonicalL1(registry, toolDecls, SMOKE_DESIGN_GUIDANCE);
  log(
    `canonical L1 (web): ${canonicalL1Web.name} (v${canonicalL1Web.version}) — ${canonicalL1Web.description.slice(0, 70)}…`
  );
  const canonicalL1Http = ensureCanonicalHttpL1(registry, toolDecls);
  log(
    `canonical L1 (http): ${canonicalL1Http.name} (v${canonicalL1Http.version}) — ${canonicalL1Http.description.slice(0, 70)}…`
  );
  const canonicalL1FileScribe = ensureCanonicalFileScribeL1(registry, toolDecls);
  log(
    `canonical L1 (file-scribe): ${canonicalL1FileScribe.name} (v${canonicalL1FileScribe.version}) — ${canonicalL1FileScribe.description.slice(0, 70)}…`
  );
  const documentMolecule = ensureCanonicalProjectDocsL1(registry, toolDecls);
  if (documentMolecule) log(`canonical L1 (project-docs): ${documentMolecule.name} (v${documentMolecule.version})`);
  for (const tier of [1, 2] as const) {
    const fullStack = ensureCanonicalFullStack(registry, toolDecls, tier);
    if (fullStack) log(`canonical L${tier} (full-stack): ${fullStack.name} (v${fullStack.version}) — ${fullStack.description}`);
  }
  // Branch rows created before the capability-first reset still carry the
  // one task they were branched for, and get reused for any other.
  for (const name of repairTaskBakedPrompts(registry)) log(`stored prompt freed of its task: ${name}`);
}
