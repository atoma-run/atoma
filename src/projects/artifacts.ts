import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';
import {
  artifactFileSchema,
  artifactManifestSchema,
  sha256Schema,
  OMITTED_ARTIFACT_ENTRIES,
  type ArtifactFile,
  type ArtifactManifest,
  type ArtifactPolicyCode,
  type OmittedArtifact,
  type OmittedArtifacts,
} from '../contracts/artifactInventory.js';

/**
 * Machine-owned publication manifest builder.
 *
 * The input is the accepted root plan's structured `outputs` list. We never
 * infer files from model prose, tool-event payloads, or the whole workspace.
 * A declared path is either a bounded regular file inside the real workspace
 * or the publication is refused with a precise policy error.
 */

export interface ArtifactLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathChars: number;
}

export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = WORKSPACE_LIMITS;

export type { ArtifactPolicyCode } from '../contracts/artifactInventory.js';

export class ArtifactPolicyError extends Error {
  constructor(
    readonly code: ArtifactPolicyCode,
    message: string
  ) {
    super(message);
    this.name = 'ArtifactPolicyError';
  }
}

export interface BuiltArtifactManifest {
  readonly manifest: ArtifactManifest;
  readonly hash: string;
  /** Workspace inventories only: the byte-less entries left out, if any. */
  readonly omitted?: OmittedArtifacts;
}

function resolvedLimits(overrides: Partial<ArtifactLimits> | undefined): ArtifactLimits {
  const limits = { ...DEFAULT_ARTIFACT_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ArtifactPolicyError('limit', `${name} must be a positive safe integer`);
    }
  }
  return limits;
}

/** Canonical Git path or a fail-closed policy error. */
export function normalizeArtifactPath(raw: string, maxPathChars = DEFAULT_ARTIFACT_LIMITS.maxPathChars): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxPathChars) {
    throw new ArtifactPolicyError('path', 'artifact path is empty or exceeds the path limit');
  }
  if (raw.includes('\0') || raw.includes('\\')) {
    throw new ArtifactPolicyError('path', `artifact path is not portable: ${JSON.stringify(raw)}`);
  }
  if (raw !== raw.trim()) {
    throw new ArtifactPolicyError('path', `artifact path has leading or trailing whitespace: ${JSON.stringify(raw)}`);
  }
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new ArtifactPolicyError('path', `artifact path must be relative: ${JSON.stringify(raw)}`);
  }
  if (raw.split('/').includes('..')) {
    throw new ArtifactPolicyError('path', `artifact path contains traversal: ${JSON.stringify(raw)}`);
  }
  const canonical = path.posix.normalize(raw.replace(/^\.\//, ''));
  if (
    canonical === '.' ||
    canonical === '..' ||
    canonical.startsWith('../') ||
    canonical.includes('/../') ||
    canonical.length > maxPathChars
  ) {
    throw new ArtifactPolicyError('path', `artifact path leaves the workspace: ${JSON.stringify(raw)}`);
  }
  return canonical;
}

/**
 * Filenames that usually hold a credential.
 *
 * EXPORTED because the result preview must apply the same list when it
 * materialises a workspace copy: publication and preview are two ways for
 * workspace bytes to leave the run that made them, and a file this refuses to
 * publish must not become readable by serving it instead. One list, two
 * consumers — never a second copy that drifts.
 */
export function secretLike(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (lower === '.env' || (lower.startsWith('.env.') && !lower.endsWith('.example'))) return true;
  if (
    [
      '.npmrc',
      '.netrc',
      '.pypirc',
      'credentials',
      'credentials.json',
      'secrets',
      '.secrets',
      'id_rsa',
      'id_ed25519',
    ].includes(lower)
  ) {
    return true;
  }
  if (/^(?:secret|secrets)\.(?:json|ya?ml|toml|txt)$/i.test(segment)) return true;
  return /\.(?:pem|key|p12|pfx|keystore)$/i.test(segment);
}

/** Internal, dependency, VCS and likely-secret paths never cross publication. */
export function assertPublishableArtifactPath(canonicalPath: string): void {
  const segments = canonicalPath.split('/');
  if (
    segments.length >= 2 &&
    segments[0]!.toLowerCase() === '.github' &&
    segments[1]!.toLowerCase() === 'workflows'
  ) {
    throw new ArtifactPolicyError(
      'excluded',
      `GitHub Actions workflow publication requires the GitHub App Workflows permission, which the MVP does not grant: ${canonicalPath}`
    );
  }
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (
      lower === '.git' ||
      lower === 'node_modules' ||
      lower === '__pycache__' ||
      lower === '.atoma' ||
      lower.startsWith('.atoma-') ||
      secretLike(segment)
    ) {
      throw new ArtifactPolicyError(
        'excluded',
        `artifact path is excluded from publication: ${canonicalPath}`
      );
    }
  }
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

export interface WorkspacePath {
  readonly root: string;
  readonly realRoot: string;
  readonly canonical: string;
  readonly absolute: string;
}

/**
 * Which canonical paths a caller refuses, as a parameter.
 *
 * The PATH JAIL below — traversal, every symlink component, the real-path
 * re-check — is one rule and must never be written twice. What legitimately
 * differs between callers is the EXCLUSION LIST: publication refuses
 * `.atoma-*` because a probe manifest is not a deliverable, while the preview
 * classifier must READ `.atoma-probes.json` to learn what the run built. So
 * the jail is shared and the exclusion is injected.
 *
 * The default is `assertPublishableArtifactPath`, so every existing
 * publication call site keeps byte-identical behaviour.
 */
export type WorkspacePathPolicy = (canonicalPath: string) => void;

export function resolveWorkspaceFile(
  workspaceRoot: string,
  declaredPath: string,
  limits: ArtifactLimits,
  assertPath: WorkspacePathPolicy = assertPublishableArtifactPath
): WorkspacePath {
  const root = path.resolve(workspaceRoot);
  let rootStat: Stats;
  try {
    rootStat = lstatSync(root);
  } catch {
    // No path in the message: it becomes a publication error that every role
    // of the organisation reads (2026-09-25 review, 2.2).
    throw new ArtifactPolicyError('missing', 'the run workspace no longer exists on this host');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ArtifactPolicyError('special', 'workspace root must be a real directory');
  }
  const realRoot = realpathSync(root);
  const canonical = normalizeArtifactPath(declaredPath, limits.maxPathChars);
  assertPath(canonical);
  const absolute = path.resolve(root, ...canonical.split('/'));
  const lexicalRelative = path.relative(root, absolute);
  if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    throw new ArtifactPolicyError('path', `artifact path escapes workspace: ${canonical}`);
  }

  // Reject every symlink component, even one whose final target happens to
  // remain inside the workspace. Publication must have one unambiguous byte
  // source and must not change meaning when a link is retargeted.
  let cursor = root;
  for (const segment of canonical.split('/')) {
    cursor = path.join(cursor, segment);
    let stat: Stats;
    try {
      stat = lstatSync(cursor);
    } catch {
      throw new ArtifactPolicyError('missing', `declared artifact does not exist: ${canonical}`);
    }
    if (stat.isSymbolicLink()) {
      throw new ArtifactPolicyError('symlink', `artifact path contains a symlink: ${canonical}`);
    }
  }

  const real = realpathSync(absolute);
  const realRelative = path.relative(realRoot, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new ArtifactPolicyError('path', `artifact real path escapes workspace: ${canonical}`);
  }
  return { root, realRoot, canonical, absolute };
}

export interface ReadArtifact {
  readonly file: ArtifactFile;
  readonly bytes: Buffer;
}

/**
 * Read one workspace file through a stable file descriptor, refusing anything
 * that changes underneath the read.
 *
 * Exported for the result preview, which needs exactly these guarantees on
 * `.atoma-probes.json` and `package.json` — a classifier that decided a run's
 * kind from a file swapped mid-read would persist an immutable descriptor
 * about bytes that never existed. `assertPath` is the only axis a caller may
 * vary; see `WorkspacePathPolicy`.
 */
export function secureReadWorkspaceFile(
  workspaceRoot: string,
  declaredPath: string,
  limits: ArtifactLimits,
  assertPath: WorkspacePathPolicy = assertPublishableArtifactPath
): ReadArtifact {
  const target = resolveWorkspaceFile(workspaceRoot, declaredPath, limits, assertPath);
  const before = lstatSync(target.absolute);
  if (!before.isFile()) {
    throw new ArtifactPolicyError('special', `artifact is not a regular file: ${target.canonical}`);
  }
  if (before.size > limits.maxFileBytes) {
    throw new ArtifactPolicyError(
      'limit',
      `artifact exceeds ${limits.maxFileBytes} bytes: ${target.canonical}`
    );
  }

  let fd: number | null = null;
  try {
    fd = openSync(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new ArtifactPolicyError('changed', `artifact changed while it was opened: ${target.canonical}`);
    }

    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > limits.maxFileBytes) {
        throw new ArtifactPolicyError(
          'limit',
          `artifact grew beyond ${limits.maxFileBytes} bytes: ${target.canonical}`
        );
      }
      const bytes = chunk.subarray(0, count);
      chunks.push(bytes);
      hash.update(bytes);
    }

    const afterFd = fstatSync(fd);
    const afterPath = lstatSync(target.absolute);
    if (
      total !== afterFd.size ||
      !sameIdentity(opened, afterFd) ||
      !sameIdentity(afterFd, afterPath) ||
      afterPath.isSymbolicLink()
    ) {
      throw new ArtifactPolicyError('changed', `artifact changed while it was read: ${target.canonical}`);
    }

    return {
      file: artifactFileSchema.parse({
        path: target.canonical,
        size: total,
        sha256: hash.digest('hex'),
        mode: (opened.mode & 0o111) !== 0 ? '100755' : '100644',
      }),
      bytes: Buffer.concat(chunks, total),
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function buildWorkspaceArtifactManifest(input: {
  readonly workspaceRoot: string;
  readonly limits?: Partial<ArtifactLimits>;
  readonly delivery?: import('../contracts/taskExecution.js').DeliveryKind;
  readonly allowEmpty?: boolean;
}): BuiltArtifactManifest {
  try {
    return inventoryWorkspace(input);
  } catch (error) {
    // Filesystem errors must not expose control-plane paths to a member.
    if (error instanceof ArtifactPolicyError) {
      throw new ArtifactPolicyError(error.code, error.message.replaceAll(path.resolve(input.workspaceRoot), '<workspace>'));
    }
    throw new ArtifactPolicyError('changed', 'finished workspace could not be inventoried');
  }
}

/** Where tool workers, previews and hosting mount a workspace
 * (`src/launcher/workerProfile.ts`): an absolute link a tool wrote under it
 * names a workspace path in that container, whatever this host calls it. */
const CONTAINER_WORKSPACE_MOUNT = '/workspace';

function contains(base: string, candidate: string): boolean {
  const relative = path.posix.relative(base, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}

/**
 * An entry holding no bytes, which no reader of a copy could tell from an
 * absent one: a socket, a FIFO, or a symbolic link whose target exists
 * nowhere (Chromium's `SingletonLock` -> `host-pid`, `SingletonSocket` ->
 * `/tmp/...`, run 40c20c5d). A link naming a workspace path, in this
 * namespace or the container's, is judged by whether that path exists HERE:
 * the workspace is one volume everywhere. Anything else is stat-ed once,
 * never opened or read. A link that resolves is not byte-less and refuses.
 */
function byteLessEntry(root: string, realRoot: string, name: string, absolute: string, stat: Stats): OmittedArtifact['kind'] | null {
  if (stat.isSocket()) return 'socket';
  if (stat.isFIFO()) return 'fifo';
  if (!stat.isSymbolicLink()) return null;
  const target = readlinkSync(absolute);
  for (const view of [root, realRoot, CONTAINER_WORKSPACE_MOUNT]) {
    const named = path.posix.resolve(view, path.posix.dirname(name), target);
    if (!contains(view, named)) continue;
    const inside = path.posix.relative(view, named);
    if (!inside || existsSync(path.join(root, ...inside.split('/')))) return null;
  }
  try {
    statSync(absolute);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' ? 'dangling-symlink' : null;
  }
}

/** One bounded line naming what an inventory left out. Paths are JSON-quoted:
 * a model may name a file with a newline, and the run log is parsed. */
export function describeOmittedArtifacts(omitted: OmittedArtifacts): string {
  const listed = omitted.entries.map(entry => `${JSON.stringify(entry.path)} (${entry.kind})`).join(', ');
  const more = omitted.count > omitted.entries.length ? `, and ${omitted.count - omitted.entries.length} more` : '';
  return `[atoma projects] workspace inventory left out ${omitted.count} entr${omitted.count === 1 ? 'y' : 'ies'} holding no bytes, never published: ${listed}${more}`;
}

/** Append that line to the run's log, beside its other host records. Never throws. */
export function recordOmittedArtifacts(logPath: string, runId: string, omitted: OmittedArtifacts | undefined): void {
  if (!omitted) return;
  const line = describeOmittedArtifacts(omitted);
  try { appendFileSync(logPath, `${line}\n`); }
  catch (error) { process.stderr.write(`[atoma projects] omitted entries not logged for ${runId}: ${String(error)}\n`); }
}

/** Inventory the finished workspace, using the publication jail and exclusions.
 * Plans are intentions, not an inventory: child work and generated assets may
 * add files the root plan did not name. Never infer dependencies from source.
 */
function inventoryWorkspace(input: {
  readonly workspaceRoot: string;
  readonly limits?: Partial<ArtifactLimits>;
  readonly delivery?: import('../contracts/taskExecution.js').DeliveryKind;
  readonly allowEmpty?: boolean;
}): BuiltArtifactManifest {
  const limits = resolvedLimits(input.limits);
  const root = path.resolve(input.workspaceRoot);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ArtifactPolicyError('special', 'workspace root must be a real directory');
  }
  const realRoot = realpathSync(root);
  const files: string[] = [];
  const omitted: OmittedArtifact[] = [];
  const directories = [''];
  let visited = 0;
  while (directories.length) {
    const relative = directories.pop()!;
    const directory = relative
      ? resolveWorkspaceFile(root, relative, limits).absolute
      : root;
    const handle = opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (++visited > limits.maxFiles * 4) {
          throw new ArtifactPolicyError('limit', 'workspace inventory exceeds the entry limit');
        }
        const name = normalizeArtifactPath(relative ? `${relative}/${entry.name}` : entry.name, limits.maxPathChars);
        try {
          assertPublishableArtifactPath(name);
        } catch (error) {
          if (error instanceof ArtifactPolicyError && error.code === 'excluded') continue;
          throw error;
        }
        // A byte-less entry is left out and reported, never followed or read.
        const entryPath = path.join(directory, entry.name);
        const byteLess = byteLessEntry(root, realRoot, name, entryPath, lstatSync(entryPath));
        if (byteLess) {
          omitted.push({ path: name, kind: byteLess });
          continue;
        }
        // Reuse the path jail even for directories; never descend through a
        // symlink or silently publish half an application after a refusal.
        const target = resolveWorkspaceFile(root, name, limits);
        const stat = lstatSync(target.absolute);
        if (stat.isDirectory()) directories.push(name);
        else if (stat.isFile()) {
          files.push(name);
          if (files.length > limits.maxFiles) throw new ArtifactPolicyError('limit', 'workspace exceeds the artifact count limit');
        } else throw new ArtifactPolicyError('special', `artifact is not a regular file: ${name}`);
      }
    } finally {
      handle.closeSync();
    }
  }
  if (!files.length && input.delivery !== 'text' && !input.allowEmpty) {
    throw new ArtifactPolicyError('empty', 'finished workspace contains no publishable files');
  }
  const inventory = files.length
    ? buildArtifactManifest({ ...input, declaredPaths: files, limits }).manifest
    : { version: 1, files: [], totalBytes: 0 };
  const manifest = artifactManifestSchema.parse({
    ...inventory, source: 'workspace', ...(input.delivery ? { delivery: input.delivery } : {}),
  });
  omitted.sort((a, b) => a.path.localeCompare(b.path));
  return {
    manifest,
    hash: artifactManifestHash(manifest),
    ...(omitted.length ? { omitted: { count: omitted.length, entries: omitted.slice(0, OMITTED_ARTIFACT_ENTRIES) } } : {}),
  };
}

export function artifactManifestHash(manifest: ArtifactManifest): string {
  const parsed = artifactManifestSchema.parse(manifest);
  return createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
}

export function buildArtifactManifest(input: {
  readonly workspaceRoot: string;
  readonly declaredPaths: readonly string[];
  readonly limits?: Partial<ArtifactLimits>;
}): BuiltArtifactManifest {
  const limits = resolvedLimits(input.limits);
  if (input.declaredPaths.length === 0) {
    throw new ArtifactPolicyError('empty', 'no artifact paths were declared by the accepted plan');
  }
  // Bound work before canonical deduplication too: ten thousand repetitions
  // of one path are still ten thousand untrusted input entries to inspect.
  if (input.declaredPaths.length > limits.maxFiles * 4) {
    throw new ArtifactPolicyError('limit', 'too many declared artifact paths');
  }
  const canonical = [
    ...new Set(
      input.declaredPaths.map((declaredPath) =>
        normalizeArtifactPath(declaredPath, limits.maxPathChars)
      )
    ),
  ].sort((a, b) => a.localeCompare(b));
  if (canonical.length === 0) {
    throw new ArtifactPolicyError('empty', 'no publishable artifact paths were declared');
  }
  if (canonical.length > limits.maxFiles) {
    throw new ArtifactPolicyError('limit', `artifact count exceeds ${limits.maxFiles}`);
  }

  const files: ArtifactFile[] = [];
  let totalBytes = 0;
  for (const declaredPath of canonical) {
    const read = secureReadWorkspaceFile(input.workspaceRoot, declaredPath, limits);
    totalBytes += read.file.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ArtifactPolicyError(
        'limit',
        `artifact bytes exceed the ${limits.maxTotalBytes}-byte total limit`
      );
    }
    files.push(read.file);
  }
  const manifest = artifactManifestSchema.parse({ version: 1, files, totalBytes });
  return { manifest, hash: artifactManifestHash(manifest) };
}

/**
 * Re-read every manifest file through O_NOFOLLOW and compare the complete
 * entry. Call immediately before creating Git blobs; a changed byte, mode,
 * inode or path is a refusal, never a silently revised publication.
 */
export function revalidateArtifactManifest(input: {
  readonly workspaceRoot: string;
  readonly manifest: ArtifactManifest;
  readonly expectedHash?: string;
  readonly limits?: Partial<ArtifactLimits>;
}): BuiltArtifactManifest {
  const expected = artifactManifestSchema.parse(input.manifest);
  const expectedHash = input.expectedHash
    ? sha256Schema.parse(input.expectedHash)
    : artifactManifestHash(expected);
  if (artifactManifestHash(expected) !== expectedHash) {
    throw new ArtifactPolicyError('hash', 'artifact manifest hash does not match its contents');
  }
  const rebuilt = expected.source === 'workspace'
    ? buildWorkspaceArtifactManifest({ ...input, delivery: expected.delivery, allowEmpty: expected.files.length === 0 })
    : buildArtifactManifest({
        workspaceRoot: input.workspaceRoot,
        declaredPaths: expected.files.map((file) => file.path),
        ...(input.limits ? { limits: input.limits } : {}),
      });
  if (rebuilt.hash !== expectedHash || JSON.stringify(rebuilt.manifest) !== JSON.stringify(expected)) {
    throw new ArtifactPolicyError('changed', 'artifact files changed after the manifest was recorded');
  }
  return rebuilt;
}

/**
 * Read one exact manifest entry for upload. It performs the same stable-fd
 * checks as manifest construction and refuses a byte or mode mismatch.
 */
export function readManifestArtifact(input: {
  readonly workspaceRoot: string;
  readonly expected: ArtifactFile;
  readonly limits?: Partial<ArtifactLimits>;
}): Buffer {
  const expected = artifactFileSchema.parse(input.expected);
  const actual = secureReadWorkspaceFile(
    input.workspaceRoot,
    expected.path,
    resolvedLimits(input.limits)
  );
  if (JSON.stringify(actual.file) !== JSON.stringify(expected)) {
    throw new ArtifactPolicyError('changed', `artifact no longer matches its manifest: ${expected.path}`);
  }
  return actual.bytes;
}
