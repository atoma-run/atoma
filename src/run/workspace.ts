import { dirname, basename, join, relative, resolve } from 'node:path';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { inheritProbeManifest, PROBE_MANIFEST_FILENAME } from '../contracts/probeManifest.js';
import { READ_RUNS_DIRECTORY } from '../contracts/readRuns.js';
import { byteLessWorkspaceEntry } from '../projects/artifacts.js';
import type { DeliveredSnapshot, StartingSnapshot, WorkspaceFileSnapshot } from '../contracts/startingWorkspace.js';
import { MAX_PACKAGE_ROOT_DIR_LENGTH, MAX_PACKAGE_ROOTS, workspacePreparationSchema, type PackageLockfile, type PackageRoot, type WorkspacePreparation } from '../contracts/workspacePreparation.js';
import { OMIT_DIRECTORIES } from './routingRepository.js';

/**
 * Stale artefacts from PREVIOUS runs pollute the current one. They land in
 * the read-back probe's `list_files` evidence block, and a phase that ends
 * with "confirm exactly <these files> exist" can legitimately flag them.
 * Measured on the csv2json run: the workspace still held `server.js`,
 * `data.db`, `views/` and a 180-entry `node_modules/` from an SSR run three
 * months earlier.
 *
 * Default behaviour is to WARN, never to touch the directory: the workspace
 * holds the user's deliverable and this example has no way to know whether
 * it has been collected yet. `--clean-workspace` ARCHIVES by rename rather
 * than deleting, for the same reason — a wrong call stays recoverable.
 */
/**
 * Node resolves a `.js` file's module system by walking UP from the file
 * until it finds a package.json — and the workspace lives under the atoma
 * repo, whose package.json says `"type": "module"`. A task that ships
 * CommonJS `.js` files WITHOUT its own package.json therefore crashes with
 * "require is not defined in ES module scope" — because of a file that sits
 * OUTSIDE the sandbox jail and outside every prompt's view. Measured on the
 * HTTP burn-in batches (2026-08-07): 8/10 runs wrote no local package.json,
 * and exactly the ones whose L1 happened to pick the CommonJS style crashed
 * and had to convert to ESM in-loop — an unfixable-from-inside environment
 * leak that no skill can learn its way around (each run's self-repair is
 * locally correct and leaves nothing durable behind).
 *
 * The fix is a SENTINEL package.json (`{}` — no "type", i.e. the exact
 * default a standalone folder would have) in the workspace's PARENT, which
 * stops Node's walk before it reaches the repo's. The parent is
 * harness-owned (`build/` — the same place prepareWorkspace puts archives),
 * and a task that writes its own package.json still wins, being closer.
 * Guarded to write ONLY when the nearest package.json above the parent
 * actually carries `"type": "module"` — in innocent layouts (no ancestor
 * package.json, or a CJS one) the sentinel would change nothing, so we
 * never touch directories that aren't ours to fix.
 */
export function ensureModuleResolutionBoundary(root: string): void {
  const parent = dirname(root);
  if (parent === root) return; // filesystem root — nowhere to fence
  const sentinel = join(parent, 'package.json');
  if (existsSync(sentinel)) return; // parent already IS a boundary
  // Find the nearest ancestor package.json strictly above the parent.
  let dir = dirname(parent);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      let hazardous = false;
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { type?: string };
        hazardous = parsed.type === 'module';
      } catch {
        // Unreadable/invalid ancestor manifest: Node would fail loudly on it
        // anyway; not this helper's problem.
      }
      if (hazardous) {
        // First run: the harness-owned parent may not exist yet (the sandbox
        // mkdirs the workspace AFTER prepareWorkspace runs).
        mkdirSync(parent, { recursive: true });
        writeFileSync(sentinel, '{}\n');
      }
      return; // nearest ancestor decides — hazardous or not, we're done
    }
    const up = dirname(dir);
    if (up === dir) return; // reached the filesystem root: no ancestor manifest
    dir = up;
  }
}

/** Returns the archive the workspace was moved to, when it was archived. */
export function prepareWorkspace(root: string, clean: boolean, log: (line: string) => void = console.log): string | undefined {
  ensureModuleResolutionBoundary(root);
  if (!existsSync(root)) return undefined;
  const stale = readdirSync(root);
  if (stale.length === 0) return undefined;
  if (!clean) {
    const shown = stale.slice(0, 8).join(', ');
    log(
      `⚠ workspace is not empty (${stale.length} entries: ${shown}${stale.length > 8 ? ', …' : ''})`
    );
    log(
      '  stale artefacts appear in verification evidence — pass --clean-workspace to archive them'
    );
    return undefined;
  }
  // A monotonic suffix keeps repeated archives distinct without a clock
  // (and without ever overwriting an earlier archive).
  const parent = dirname(root);
  const base = basename(root);
  let n = 1;
  while (existsSync(join(parent, `${base}.prev${n}`))) n++;
  const archived = join(parent, `${base}.prev${n}`);
  renameSync(root, archived);
  log(`workspace archived: ${archived} (${stale.length} entries) — starting clean`);
  return archived;
}


/** What `seedWorkspace` copied, for the launch log. */
export interface SeedReport {
  /** Top-level entries of the seeded workspace. */
  readonly entries: number;
  /**
   * What happened to the inherited probe manifest: `absent` (the seed had
   * none), `kept` (byte-identical), `filtered` (unreplayable entries dropped),
   * `removed` (nothing replayable left, or not a regular file).
   */
  readonly manifest: 'absent' | 'kept' | 'filtered' | 'removed';
  readonly kept: number;
  readonly dropped: number;
  /** Kept entries whose port-bearing stdout was omitted to keep them replayable. */
  readonly repaired?: number;
  readonly problems: readonly string[];
}

/**
 * The ONE seed copy, used at launch and again when a seeded run deepens.
 *
 * A seed is the state a run starts from. Depth routing restarts a deepening
 * attempt "fresh" (decided 2026-09-13 for runs that carried no seed); since
 * 2026-09-23 every project run is seeded AND depth-routed, and a restart over
 * an empty directory rebuilt the project's whole corpus from nothing — then
 * seeded the next run from that. Fresh, for a seeded run, means the seed.
 *
 * The inherited `.atoma-probes.json` is filtered through
 * `inheritProbeManifest`: kept as a replay baseline, minus every entry no
 * reader can replay. The seed's read-run copies (`.atoma-runs`, at its top
 * level) are never inherited: they were given to the run that read them, and
 * a run reads only the runs its own request names (src/contracts/readRuns.ts).
 * Installed dependencies (node_modules at any depth) and top-level run scratch
 * are re-created by the next run, never multiplied with each seed. Sources,
 * built deliverables, historical data and the inherited proof manifest remain.
 * The seed source is never modified.
 */
export function seedWorkspace(seedRoot: string, workspaceRoot: string): SeedReport {
  mkdirSync(workspaceRoot, { recursive: true });
  const sourceRoot = resolve(seedRoot);
  const readRunCopies = resolve(seedRoot, READ_RUNS_DIRECTORY);
  const scratch = resolve(seedRoot, '.atoma-scratch');
  // Links are copied as written. Without `verbatimSymlinks`, cpSync rewrites a
  // relative link (`node_modules/.bin/vite -> ../vite/bin/vite.js`) into an
  // absolute one into the SEED, which the checkpoint digest refuses as
  // escaping: every seeded run with installed dependencies lost pause, client
  // questions and resume without an error (code review 2026-10-09, 1.5). A link
  // that leaves the tree stays refused by the checkpoint, as before. What the
  // publication inventory leaves out as byte-less (a dangling link, a socket,
  // a FIFO) is never seeded: a delivered workspace may hold them (run 40c20c5d).
  cpSync(seedRoot, workspaceRoot, { recursive: true, verbatimSymlinks: true,
    filter: (source) => {
      const path = resolve(source);
      if (path === sourceRoot) return true;
      if (path === readRunCopies || path === scratch || basename(path) === 'node_modules') return false;
      return byteLessWorkspaceEntry(sourceRoot, relative(sourceRoot, path)) === null;
    } });
  const entries = readdirSync(workspaceRoot).length;
  const manifestPath = join(workspaceRoot, PROBE_MANIFEST_FILENAME);
  let stat;
  try {
    stat = lstatSync(manifestPath);
  } catch {
    return { entries, manifest: 'absent', kept: 0, dropped: 0, problems: [] };
  }
  if (!stat.isFile()) {
    // A symlinked or special manifest is never followed: rewriting it would
    // write wherever the link points.
    rmSync(manifestPath, { recursive: true, force: true });
    return { entries, manifest: 'removed', kept: 0, dropped: 0, problems: ['not a regular file'] };
  }
  const inherited = inheritProbeManifest(readFileSync(manifestPath, 'utf8'));
  const problems = inherited.unreadable ? ['not a readable version-1 manifest'] : inherited.problems;
  if (inherited.text === null) {
    rmSync(manifestPath, { force: true });
    return { entries, manifest: 'removed', kept: 0, dropped: inherited.dropped, problems };
  }
  if (inherited.dropped === 0 && inherited.repaired === 0) {
    return { entries, manifest: 'kept', kept: inherited.kept, dropped: 0, problems: [] };
  }
  writeFileSync(manifestPath, inherited.text);
  return { entries, manifest: 'filtered', kept: inherited.kept, dropped: inherited.dropped,
    ...(inherited.repaired > 0 ? { repaired: inherited.repaired } : {}), problems };
}

/** The launch-log line for a seed manifest that changed, or null when none did. */
export function describeSeedManifest(report: SeedReport): string | null {
  if (report.manifest === 'absent' || report.manifest === 'kept') return null;
  const detail = report.problems.length > 0 ? ` — ${report.problems.join('; ')}` : '';
  return report.manifest === 'removed'
    ? `seed ${PROBE_MANIFEST_FILENAME}: not inherited, nothing replayable (${report.dropped} entries dropped)${detail}`
    : `seed ${PROBE_MANIFEST_FILENAME}: kept ${report.kept} entries${report.repaired ? ` (${report.repaired} without their run-varying stdout)` : ''}, dropped ${report.dropped} unreplayable${detail}`;
}

/** How deep below the seed root a package root is looked for ('.' is depth 0). */
export const PACKAGE_ROOT_MAX_DEPTH = 4;
/** Directories read at most; the bound is on directories, never on files. */
export const PACKAGE_ROOT_MAX_DIRECTORIES = 2000;
const PACKAGE_MANIFEST_MAX_BYTES = 1024 * 1024;
/** The lockfile a root's install is frozen to when a directory holds several: npm's own precedence first. */
const LOCKFILE_PRECEDENCE: readonly PackageLockfile[] = ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/**
 * THE PACKAGE ROOTS OF A SEED, read on the server from the seed SOURCE at
 * launch — local and Compute runs alike, since both hold `seedRoot` as a host
 * path. A directory is a root when it holds a regular `package.json`; its
 * `lockfile` is the one its install is frozen to, or null. A package.json
 * without a lockfile that a listed root's workspace covers is that root's
 * member, installed by its install, and is not listed. A workspace is read
 * from the root's package.json `workspaces`, whatever the root's lockfile (a
 * lockfile-less npm workspace root installs its members itself), and from its
 * `pnpm-workspace.yaml` when pnpm owns the root (its lockfile is pnpm-lock.yaml
 * or there is none): a pnpm member installed standalone with npm fails on
 * `workspace:` dependencies, while npm, yarn and bun ignore that file
 * (review 2026-10-26).
 *
 * Entries are read SORTED and only the names package.json and the lockfiles
 * are looked at, so the list never depends on the filesystem's read order.
 * Never derived from the routing inventory (`readRoutingRepository`): its
 * 160-entry cut is taken in raw read order, and in run 2f2643d5 it had stopped
 * partway through `browser/`. Skipped as the seed copy skips them: every
 * `node_modules`, every dot-directory (the read-run copies under
 * `.atoma-runs/node_modules/<id>/` carry other runs' manifests; also
 * `.atoma-scratch` and `.git`), the routing reader's omitted build and vendor
 * trees, and links, which are never followed. Bounded by depth and by
 * directories read; `complete` is false when a bound, an unreadable directory,
 * a path longer than a receipt holds or the root cap cut it.
 */
export function packageRootsOf(seedRoot: string): { roots: PackageRoot[]; complete: boolean } {
  const roots: PackageRoot[] = [];
  const workspaces: { dir: string; patterns: RegExp[] }[] = [];
  let complete = true;
  let visited = 0;
  const pending: { relative: string; depth: number }[] = [{ relative: '', depth: 0 }];
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (++visited > PACKAGE_ROOT_MAX_DIRECTORIES) { complete = false; break; }
    let entries: Dirent[];
    try {
      entries = readdirSync(join(seedRoot, next.relative), { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      complete = false;
      continue;
    }
    const files = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
    if (files.has('package.json')) {
      const dir = next.relative || '.';
      const lockfile = LOCKFILE_PRECEDENCE.find(name => files.has(name)) ?? null;
      const member = lockfile === null && workspaces.some(({ dir: owner, patterns }) => {
        const inside = owner === '.' ? dir : dir.startsWith(`${owner}/`) ? dir.slice(owner.length + 1) : null;
        return inside !== null && patterns.some(pattern => pattern.test(inside));
      });
      if (!member) {
        if (roots.length >= MAX_PACKAGE_ROOTS) { complete = false; break; }
        roots.push({ dir, lockfile });
      }
      if (!member) {
        const patterns = [
          ...workspacePatterns(join(seedRoot, next.relative, 'package.json')),
          ...(files.has('pnpm-workspace.yaml') && (lockfile === null || lockfile === 'pnpm-lock.yaml')
            ? pnpmWorkspacePatterns(join(seedRoot, next.relative, 'pnpm-workspace.yaml')) : []),
        ];
        if (patterns.length > 0) workspaces.push({ dir, patterns });
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || OMIT_DIRECTORIES.has(entry.name)) continue;
      if (next.depth >= PACKAGE_ROOT_MAX_DEPTH) { complete = false; continue; }
      const relative = next.relative ? `${next.relative}/${entry.name}` : entry.name;
      // No root below it fits the receipt's schema.
      if (relative.length > MAX_PACKAGE_ROOT_DIR_LENGTH) { complete = false; continue; }
      pending.push({ relative, depth: next.depth + 1 });
    }
  }
  return { roots, complete };
}

/** A regular file within the manifest cap, as text; null when absent, a link or unreadable. */
function boundedManifestText(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > PACKAGE_MANIFEST_MAX_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Workspace globs as anchored matchers over member paths; negations are left out. */
function globMatchers(globs: readonly unknown[]): RegExp[] {
  return globs.flatMap((glob) => {
    if (typeof glob !== 'string' || glob.startsWith('!')) return [];
    const normalized = glob.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized) return [];
    const source = normalized.split('/').map(part => part === '**' ? '.*'
      : part.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('/');
    return [new RegExp(`^${source}$`)];
  });
}

/** A package.json's `workspaces` globs, as anchored matchers over member paths; none when unreadable. */
function workspacePatterns(manifestPath: string): RegExp[] {
  const text = boundedManifestText(manifestPath);
  if (text === null) return [];
  let declared: unknown;
  try {
    declared = (JSON.parse(text) as { workspaces?: unknown } | null)?.workspaces;
  } catch {
    return [];
  }
  return globMatchers(Array.isArray(declared) ? declared
    : declared && typeof declared === 'object' && Array.isArray((declared as { packages?: unknown }).packages)
      ? (declared as { packages: unknown[] }).packages : []);
}

/**
 * A `pnpm-workspace.yaml`'s `packages` globs, read by a line reader (no YAML
 * dependency): the block list under the top-level `packages:` key, or a flow
 * list on one line or several. A file without that key (pnpm 10 keeps its
 * settings there, `onlyBuiltDependencies`, even in a single-package
 * repository) is a root-only workspace: pnpm installs no member, so none is
 * left to it. Only a file that cannot be read, or a `packages` key whose
 * globs cannot be read, counts the whole subtree as the workspace: an npm
 * install inside a pnpm workspace is never right.
 */
function pnpmWorkspacePatterns(path: string): RegExp[] {
  const text = boundedManifestText(path);
  const globs: string[] = [];
  const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2');
  const flowItems = (list: string): string[] => list.replace(/^\s*\[/, '').replace(/\].*$/, '').split(',').map(unquote).filter(Boolean);
  let inPackages = false;
  let sawPackages = false;
  let flow: string | null = null;
  for (const line of (text ?? '').split(/\r?\n/)) {
    const content = line.replace(/\s+#.*$/, '');
    if (/^\s*(#|$)/.test(content)) continue;
    if (flow !== null) {
      flow += ` ${content}`;
      if (content.includes(']')) { globs.push(...flowItems(flow)); flow = null; }
      continue;
    }
    const item = inPackages ? /^\s*-\s+(.+)$/.exec(content) : null;
    if (item) { globs.push(unquote(item[1]!)); continue; }
    if (/^\S/.test(content)) {
      const key = /^packages\s*:\s*(.*)$/.exec(content);
      inPackages = key !== null;
      if (!key) continue;
      sawPackages = true;
      const value = key[1]!.trim();
      if (value.startsWith('[')) {
        if (value.includes(']')) globs.push(...flowItems(value));
        else flow = value;
      }
    }
  }
  const patterns = globMatchers(globs);
  if (patterns.length > 0) return patterns;
  return text === null || sawPackages ? [/^.*$/] : [];
}

/**
 * The launch receipt (`inputs.workspacePreparation`), built through its one
 * schema. A resumed run MERGES into the receipt its checkpoint saved: the
 * roots its launch listed stay, only `dependencies` changes, because the
 * checkpoint kept whatever was installed.
 */
export function launchWorkspacePreparation(input: { resume: boolean; saved?: unknown; seedRoot?: string | undefined }): WorkspacePreparation {
  if (input.resume) {
    const saved = workspacePreparationSchema.safeParse(input.saved);
    return workspacePreparationSchema.parse({ ...(saved.success ? saved.data : {}), dependencies: 'preserved-unverified' });
  }
  if (!input.seedRoot) return { dependencies: 'unverified' };
  const { roots, complete } = packageRootsOf(input.seedRoot);
  return workspacePreparationSchema.parse({ dependencies: 'excluded-from-seed', packageRoots: roots, packageRootsComplete: complete });
}

const SNAPSHOT_MAX_FILES = 400;
const SNAPSHOT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_MAX_LINE_BYTES = 512 * 1024;
/**
 * What is never compared: what publication leaves out (`.git`, `node_modules`,
 * `.atoma`, `.atoma-*`, as `src/projects/artifacts.ts` spells them) and what is
 * regenerated rather than authored. A cache sorting first would otherwise use
 * the whole cap before the deliverable is reached (adversarial review 2026-09-27).
 */
const SNAPSHOT_SKIPPED = new Set(['.git', 'node_modules', '.atoma', '.next', '.nuxt', '.venv', 'venv',
  '__pycache__', '.pytest_cache', '.cache', '.turbo', 'coverage']);

/** A name no workspace snapshot reads, at any depth; the read-only phase restore never touches one either. */
export function skippedBySnapshot(name: string): boolean {
  const lower = name.toLowerCase();
  return SNAPSHOT_SKIPPED.has(lower) || lower.startsWith('.atoma-');
}
const skipped = skippedBySnapshot;

/** One file, or undefined when it is not a regular file within the per-file cap. */
function snapshotFile(root: string, rel: string, budget: { bytes: number }): WorkspaceFileSnapshot | undefined {
  let stat;
  try { stat = lstatSync(join(root, rel)); } catch { return undefined; }
  if (!stat.isFile() || stat.size > SNAPSHOT_MAX_FILE_BYTES || stat.size > budget.bytes) return undefined;
  budget.bytes -= stat.size;
  const bytes = readFileSync(join(root, rel));
  const text = stat.size <= SNAPSHOT_MAX_LINE_BYTES && !bytes.includes(0) ? bytes.toString('utf8') : undefined;
  const lineHashes = text === undefined ? undefined : [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
    .map((line) => createHash('sha1').update(line).digest('hex').slice(0, 16));
  return { path: rel, bytes: stat.size, sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(lineHashes && text !== undefined ? { lineHashes, head: text.slice(0, 240) } : {}) };
}

/** Every regular file under `root`, in path order, without following links, up to `cap`. */
function walkFiles(root: string, cap: number): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  let truncated = false;
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (skipped(name)) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      let stat;
      try { stat = lstatSync(join(dir, name)); } catch { continue; }
      if (stat.isDirectory()) { walk(join(dir, name), rel); continue; }
      if (!stat.isFile()) continue;
      if (paths.length >= cap) { truncated = true; return; }
      paths.push(rel);
    }
  };
  walk(root, '');
  return { paths, truncated };
}

/**
 * The deliverable files a SEEDED run starts from, read before any model work
 * (`src/contracts/startingWorkspace.ts`). `truncated` says the file cap or
 * the byte budget cut it short, so the acceptor is told the comparison is
 * partial rather than handed a false all-clear.
 */
export function snapshotStartingWorkspace(root: string): StartingSnapshot {
  const walked = walkFiles(root, SNAPSHOT_MAX_FILES);
  const budget = { bytes: SNAPSHOT_MAX_TOTAL_BYTES };
  const files: WorkspaceFileSnapshot[] = [];
  let truncated = walked.truncated;
  for (const rel of walked.paths) {
    const file = snapshotFile(root, rel, budget);
    if (file) files.push(file); else truncated = true;
  }
  return { files, truncated };
}

/**
 * The same files read again where the run left them — exactly the starting
 * paths, whatever else the run added, so a new file can never push a
 * starting one out of the comparison — plus the new files, under their own cap.
 */
export function snapshotDeliveredWorkspace(root: string, start: StartingSnapshot): DeliveredSnapshot {
  const budget = { bytes: SNAPSHOT_MAX_TOTAL_BYTES };
  const unreadable: string[] = [];
  const files = start.files.flatMap((file) => {
    try {
      const snapshot = snapshotFile(root, file.path, budget);
      if (snapshot) return [snapshot];
      // Only a confirmed absent name establishes removal; a cap or a read
      // failure cannot say what happened to the starting file.
      lstatSync(join(root, file.path));
      unreadable.push(file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(file.path);
    }
    return [];
  });
  const known = new Set(start.files.map((file) => file.path));
  const walked = walkFiles(root, SNAPSHOT_MAX_FILES + known.size);
  const added: WorkspaceFileSnapshot[] = [];
  let addedTruncated = walked.truncated;
  for (const rel of walked.paths) {
    if (known.has(rel)) continue;
    if (added.length >= SNAPSHOT_MAX_FILES) { addedTruncated = true; break; }
    const file = snapshotFile(root, rel, budget);
    if (file) added.push(file); else addedTruncated = true;
  }
  return { files, added, addedTruncated, ...(unreadable.length ? { unreadable } : {}) };
}
