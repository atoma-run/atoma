import { z } from 'zod';

/**
 * WHAT THE HOST PREPARED IN A RUN'S WORKSPACE AT LAUNCH — a receipt in the
 * root task's `inputs`, never a verdict and never current state.
 *
 * `dependencies` is how installed dependencies reached the workspace: the
 * seed copy leaves out `node_modules` at every depth (`excluded-from-seed`),
 * a resumed checkpoint keeps whatever it held, unchecked
 * (`preserved-unverified`), and an unseeded workspace is `unverified`.
 *
 * `packageRoots` names the directories of the SEED that hold a package.json,
 * read on the server from the seed source at launch (`packageRootsOf`,
 * src/run/workspace.ts), root first. Production run 2f2643d5 (2026-10-26)
 * installed the repository root and found the nested `browser/` root missing
 * only when its browser suite failed, near the end of its tool budget: the
 * host held both manifests and said only "excluded-from-seed". A root's
 * `lockfile` is the one its install is frozen to, or null when its
 * package.json has none. `packageRootsComplete` is false when a bound cut the
 * scan, so other roots may exist deeper. Both are absent on a run with no
 * seed, and on a checkpoint saved before they existed.
 */
export const PACKAGE_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'] as const;
export const packageLockfileSchema = z.enum(PACKAGE_LOCKFILES);
export type PackageLockfile = z.infer<typeof packageLockfileSchema>;

/** At most this many roots are listed; a scan that found more is incomplete. */
export const MAX_PACKAGE_ROOTS = 20;
/**
 * The longest `dir` a receipt holds. The scan never goes below a directory
 * whose path is longer and marks itself incomplete instead: four nested
 * 150-character names made this parse throw at launch (review 2026-10-26).
 */
export const MAX_PACKAGE_ROOT_DIR_LENGTH = 512;

export const packageRootSchema = z.object({
  /** Workspace-relative POSIX path; '.' is the repository root. */
  dir: z.string().min(1).max(MAX_PACKAGE_ROOT_DIR_LENGTH),
  lockfile: packageLockfileSchema.nullable(),
}).strict();
export type PackageRoot = z.infer<typeof packageRootSchema>;

export const workspacePreparationSchema = z.object({
  dependencies: z.enum(['excluded-from-seed', 'preserved-unverified', 'unverified']),
  packageRoots: z.array(packageRootSchema).max(MAX_PACKAGE_ROOTS).optional(),
  packageRootsComplete: z.boolean().optional(),
}).strict();
export type WorkspacePreparation = z.infer<typeof workspacePreparationSchema>;
