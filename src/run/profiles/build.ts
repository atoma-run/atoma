import { SMOKE_DESIGN_GUIDANCE } from '../../atoms/prompts.js';
import { repairTaskBakedPrompts } from '../../atoms/promptRepair.js';
import {
  ensureCanonicalL1,
  ensureCanonicalL2,
  ensureCanonicalHttpL1,
  ensureCanonicalHttpL2,
  ensureCanonicalFileScribeL1,
  ensureCanonicalFullStack,
  ensureCanonicalProjectDocsL1,
} from '../../atoms/capability.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace } from '../workspace.js';
import { DEFAULT_DB_PATH } from '../../core/stores.js';
import type { ProfileSeedContext, TaskProfile } from '../profile.js';

/**
 * Where build runs get their scratch directory.
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

/** Legacy build launch configuration; tissue selection belongs to the runner. */
export const buildProfile: TaskProfile = {
  depthExperiment: {
    defaultMode: 'deep',
    // This family also builds APIs and CLIs. No universal HTML deliverable exists.
    // Empty floors still receive semantic root review; plans declare UI obligations.
    floor: [],
    entryCell({ registry, toolDecls }) {
      const cell = ensureCanonicalFullStack(registry, toolDecls, 2);
      if (!cell) throw new Error('Depth routing requires the full-stack tool set');
      return cell;
    },
  },
  id: 'build',
  traceLabelPrefix: 'run: ',
  envVars: {
    // THE STORE IS NOT PER-FAMILY, so its env var is not either. This said
    // `ATOMA_BUILD_DB_PATH` while every CLI read `ATOMA_DB_PATH`, and the
    // mismatch is what grew four different `existsSync('./atoma-build.db')`
    // probes across the CLIs and the viz. The workspace and the budget DO
    // stay per-family: those genuinely differ between task families, a
    // catalog of atom types and skills deliberately does not (see
    // `resolveCreationDescription`, which strips task themes precisely so a
    // type earns reuse outside the family that spawned it).
    dbPath: 'ATOMA_DB_PATH',
    workspace: 'ATOMA_BUILD_WORKSPACE',
    timeoutMs: 'ATOMA_BUILD_TIMEOUT_MS',
  },
  defaults: {
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
  },

  guidance: {
    label: 'Run a task',
    help: 'Describe the outcome you want and any constraints. For an imported repository, explain what to inspect or change. Atoma selects a tissue from the request and repository context, reusing an existing capability or creating one when needed. Verification follows the requested outcome.',
    examples: [
      'Explain how authentication works in this repository and identify the files responsible for it.',
      'Analyze the CSV files in the repository and write a report on missing values and outliers.',
      'Build a single-page pomodoro timer with start, pause and reset controls.',
    ],
  },

  prepareWorkspace(root: string, clean: boolean): void {
    prepareWorkspace(root, clean);
  },

  seedCatalog({ registry, toolDecls, log }: ProfileSeedContext): void {
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
  },

};
