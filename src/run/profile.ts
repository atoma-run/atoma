import type { AtomRegistry, AtomType } from '../registry/atomRegistry.js';
import type { Tool } from '../core/types.js';

/**
 * Launch configuration retained for existing CLI and API clients.
 *
 * Everything else — provider selection and cross-vendor routing, the
 * sandbox and its builtins, trace recording, the skill-lifecycle flags, the
 * run budget, the abort signal, signal handling and the last-resort
 * watchdog — is family-independent and lives in `runTask`.
 *
 * Extracted from the old build example. It now supplies technical setup and
 * help text only: the request owns the task, and the runner selects its tissue
 * from the platform registry. No profile may bind a root tissue or inject
 * business constraints into every request.
 */
/**
 * What a human needs in order to USE a family: how to phrase a goal for it.
 *
 * Lives on the profile rather than in the viz because the viz is generic —
 * a family nobody described would show up in the picker with no help text,
 * which is the exact defect this feature exists to prevent. Making it
 * REQUIRED is the point: it is also the second consumer of `TaskProfile`,
 * and an interface with one consumer has nothing keeping it honest.
 *
 * English is the source, matching the viz i18n convention: the UI prefers a
 * `launch.help.<id>` catalog key when one exists and falls back to `help`,
 * so a new profile is always describable without touching the Vite client.
 */
export interface TaskProfileGuidance {
  /** Label for the family picker. */
  readonly label: string;
  /** A few sentences on how to phrase a goal for this family. */
  readonly help: string;
  /** Concrete example goals, click-to-fill in the UI. */
  readonly examples: readonly string[];
}

export interface TaskProfile {
  /** Supervision depth policy. The floor is fixed before either planner runs. */
  readonly depthExperiment?: {
    readonly defaultMode?: import('../contracts/depthRouting.js').DepthMode;
    readonly floor: import('../contracts/depthRouting.js').ProofFloor;
    entryCell(ctx: ProfileSeedContext): AtomType;
  };
  /** Stable id, used in logs and (later) to select a profile. */
  readonly id: string;
  /**
   * Prefix of the viz trace label. Kept per-profile because the label is
   * how a human tells families apart in the run list.
   */
  readonly traceLabelPrefix: string;
  /** Human-facing description of the family, consumed by the viz Launch tab. */
  readonly guidance: TaskProfileGuidance;
  /** Env var NAMES this family reads (values resolved by the runner). */
  readonly envVars: {
    readonly dbPath: string;
    readonly workspace: string;
    readonly timeoutMs: string;
  };
  /** Fallbacks when the corresponding env var is unset. */
  readonly defaults: {
    readonly dbPath: string;
    readonly workspace: string;
  };
  /**
   * Prepare the workspace directory. Called BEFORE the sandbox is
   * constructed — `ToolSandbox` realpath-resolves its root at construction,
   * so archiving the directory afterwards would leave every tool pointing
   * at the archive. A family with nothing to prepare implements a no-op.
   */
  prepareWorkspace(root: string, clean: boolean): void;
  /** Seed the canonical L2/L1 catalog the prefilter will match against. */
  seedCatalog(ctx: ProfileSeedContext): void;
}

/** What the runner hands a profile's seeding hooks. */
export interface ProfileSeedContext {
  readonly registry: AtomRegistry;
  readonly toolDecls: readonly Tool[];
  /**
   * Console sink. Passed in rather than letting profiles call `console.log`
   * directly so the runner owns the output stream — the burn-in harness
   * parses that stream, which makes it an API rather than decoration.
   */
  readonly log: (line: string) => void;
}
