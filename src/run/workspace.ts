import { dirname, basename, join } from 'node:path';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inheritProbeManifest, PROBE_MANIFEST_FILENAME } from '../contracts/probeManifest.js';
import type { DeliveredSnapshot, StartingSnapshot, WorkspaceFileSnapshot } from '../contracts/startingWorkspace.js';

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

export function prepareWorkspace(root: string, clean: boolean): void {
  ensureModuleResolutionBoundary(root);
  if (!existsSync(root)) return;
  const stale = readdirSync(root);
  if (stale.length === 0) return;
  if (!clean) {
    const shown = stale.slice(0, 8).join(', ');
    console.log(
      `⚠ workspace is not empty (${stale.length} entries: ${shown}${stale.length > 8 ? ', …' : ''})`
    );
    console.log(
      '  stale artefacts appear in verification evidence — pass --clean-workspace to archive them'
    );
    return;
  }
  // A monotonic suffix keeps repeated archives distinct without a clock
  // (and without ever overwriting an earlier archive).
  const parent = dirname(root);
  const base = basename(root);
  let n = 1;
  while (existsSync(join(parent, `${base}.prev${n}`))) n++;
  const archived = join(parent, `${base}.prev${n}`);
  renameSync(root, archived);
  console.log(`workspace archived: ${archived} (${stale.length} entries) — starting clean`);
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
 * reader can replay. The seed source is never modified.
 */
export function seedWorkspace(seedRoot: string, workspaceRoot: string): SeedReport {
  mkdirSync(workspaceRoot, { recursive: true });
  cpSync(seedRoot, workspaceRoot, { recursive: true });
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
  const files = start.files.flatMap((file) => snapshotFile(root, file.path, budget) ?? []);
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
  return { files, added, addedTruncated };
}
