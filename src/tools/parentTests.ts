import { constants, existsSync, lstatSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, stat, symlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { parentTestSuiteDigest, parentTestSuiteSchema, type ParentTestCause, type ParentTestObservation } from '../contracts/parentTests.js';
import type { Logger } from '../core/types.js';
import { OutsideRootError, ToolSandbox, containedIn, kernelRealpathAsync, openContained, sandboxChildEnv } from './sandbox.js';

const reportSchema = z.object({
  success: z.boolean(), numPassedTests: z.number(), numFailedTests: z.number(),
  numPendingTests: z.number(), numTodoTests: z.number().default(0), numTotalTests: z.number(),
  testResults: z.array(z.object({ message: z.string().optional(), assertionResults: z.array(z.object({
    fullName: z.string(), status: z.string(), failureMessages: z.array(z.string()),
  })) })),
});

/** A failure whose cause the runner knows; anything else thrown is `runner-error`. */
class TypedFailure extends Error {
  constructor(readonly failure: ParentTestCause, message: string) { super(message); }
}

/** Names never copied, at any depth. */
const EXCLUDED = ['.git', '.atoma-scratch', '.atoma-skeleton'].map(name => Buffer.from(name));
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 128;
const MAX_BYTES = 512 * 1024 * 1024;
const CHUNK = 256 * 1024;
/** Re-reads of a file whose size or times moved while it was copied. */
const TORN_RETRIES = 3;
const BOUNDS = 'Verification snapshot exceeds 100000 entries, depth 128 or 512 MiB';
const PROC_FD = process.platform === 'linux' && existsSync('/proc/self/fd');
const SEP = Buffer.from(path.sep);
const SLASH = Buffer.from('/');
const NUL = Buffer.from([0]);
/** The entry is gone, or became a link, after the listing named it: a concurrent writer, not a violation. */
const VANISHED = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

/**
 * I/O slots shared by EVERY snapshot in this process. One container worker
 * serves every lane, and libuv's pool (4 threads by default) also carries
 * their reads and `dns.lookup`: the snapshot keeps at least one thread free
 * for them. At most three: in the worker's 2-CPU envelope the copy is CPU
 * bound, and eight slots measured slower with 3x the event-loop stalls
 * (2026-10-16, records/reviews/parent-tests-review-fixes-2026-10-16.md).
 */
export const SNAPSHOT_SLOTS = Math.min(3, Math.max(1, (Number(process.env['UV_THREADPOOL_SIZE']) || 4) - 1));

class Slots {
  private free: number;
  private readonly waiting: Array<() => void> = [];
  constructor(count: number) { this.free = count; }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>(resolve => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}
const slots = new Slots(SNAPSHOT_SLOTS);

/** What a snapshot copied; `digest` covers exactly the bytes and links written. */
export interface SnapshotReceipt {
  readonly digest: string;
  readonly entries: number;
  readonly files: number;
  readonly bytes: number;
  readonly links: number;
  readonly skipped: number;
  readonly unstable: number;
  readonly unstablePaths: readonly string[];
  readonly ms: number;
}

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const shown = (rel: Buffer): string => JSON.stringify(rel.toString().slice(0, 300));
const posix = (rel: Buffer): Buffer => path.sep === '/' ? rel : Buffer.from(rel.toString().split(path.sep).join('/'));
const excluded = (name: Buffer): boolean => EXCLUDED.some(candidate => candidate.equals(name));
const childOf = (parent: Buffer, name: Buffer, separator: Buffer): Buffer =>
  parent.length === 0 ? name : Buffer.concat([parent, separator, name]);
const readFailure = (rel: Buffer, error: unknown): Error =>
  new Error(`Verification could not read ${shown(rel)}: ${errno(error) ?? String(error).slice(0, 200)}`);

/**
 * A bounded, asynchronous copy of `root` into `target`: verification cannot
 * mutate the delivered workspace, and the copy never stalls the process that
 * serves every other lane's tool calls (review 2026-10-16, point 4).
 * `root` is a kernel realpath; `target` must not exist yet.
 *
 *  - Every directory and file is opened with `openContained`: proven inside
 *    `root` by the kernel before a byte is read or a name listed.
 *  - A link is NEVER followed. One whose kernel realpath lies inside is
 *    recreated in the copy, relative, pointing at its target's copied path,
 *    which the walk copies on its own pass (pnpm layouts keep working, and a
 *    link cycle or a directory-link fan-out costs one entry). One that
 *    resolves outside refuses the snapshot; one with no reachable target,
 *    or a target under an excluded name, is skipped and counted.
 *  - Any other non-regular file refuses. Entries (files, directories and
 *    links), depth and bytes are bounded before they are copied.
 *  - Each file is read once: the same chunks feed the hash and the copy. A
 *    file that moved while it was read is re-read, then kept and counted as
 *    unstable: the snapshot is consistent per file, never across files.
 */
export async function snapshotProject(
  root: string, target: string, signal: AbortSignal, onProgress?: (entries: number) => void,
): Promise<SnapshotReceipt> {
  const started = performance.now();
  const realRoot = Buffer.from(root);
  const records: Array<{ rel: Buffer; record: Buffer }> = [];
  let entries = 0, files = 0, bytes = 0, links = 0, skipped = 0, unstable = 0;
  const unstablePaths: string[] = [];
  const buffers: Buffer[] = [];
  const inflight = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const guard = (): void => {
    if (failure) throw failure.error;
    signal.throwIfAborted();
  };

  const copyFile = async (source: Buffer, copy: Buffer, rel: Buffer): Promise<void> => {
    let input: FileHandle;
    try {
      input = await openContained(source, constants.O_RDONLY, realRoot);
    } catch (error) {
      if (error instanceof OutsideRootError) throw new TypedFailure('snapshot-link', `Verification cannot copy links outside the project: ${shown(rel)}`);
      if (VANISHED.has(errno(error) ?? '')) { skipped += 1; return; }
      throw readFailure(rel, error);
    }
    let output: FileHandle | undefined;
    const buffer = buffers.pop() ?? Buffer.allocUnsafe(CHUNK);
    try {
      let before = await input.stat({ bigint: true });
      // Listed as a file, now a directory: replaced since the listing, like a vanished entry.
      if (before.isDirectory()) { skipped += 1; return; }
      if (!before.isFile()) throw new TypedFailure('snapshot-special-file', `Verification snapshot contains a non-regular file: ${shown(rel)}`);
      let accounted = 0;
      const account = (size: number): void => {
        if (size <= accounted) return;
        bytes += size - accounted;
        accounted = size;
        if (bytes > MAX_BYTES) throw new TypedFailure('snapshot-bounds', BOUNDS);
      };
      account(Number(before.size));
      output = await open(copy, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        (Number(before.mode) & 0o777) | 0o600);
      for (let attempt = 0; ; attempt += 1) {
        const size = Number(before.size);
        const hash = createHash('sha256');
        let total = 0;
        if (attempt > 0) await output.truncate(0);
        while (total < size) {
          signal.throwIfAborted();
          const { bytesRead } = await input.read(buffer, 0, Math.min(CHUNK, size - total), total);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead));
          await output.write(buffer, 0, bytesRead, total);
          total += bytesRead;
        }
        // A write during the read moves the size or the times; a shorter read means it shrank.
        const after = await input.stat({ bigint: true });
        const stable = total === size && after.size === before.size && after.mtimeNs === before.mtimeNs &&
          after.ctimeNs === before.ctimeNs && after.ino === before.ino;
        if (stable || attempt >= TORN_RETRIES) {
          if (!stable) {
            unstable += 1;
            if (unstablePaths.length < 5) unstablePaths.push(shown(rel));
          }
          records.push({ rel, record: Buffer.concat([rel, NUL, Buffer.from('F'), NUL, Buffer.from(hash.digest('hex')), NUL]) });
          files += 1;
          return;
        }
        before = after;
        account(Number(after.size));
      }
    } finally {
      buffers.push(buffer);
      await Promise.all([input.close().catch(() => undefined), output?.close().catch(() => undefined)]);
    }
  };

  const schedule = async (work: () => Promise<void>): Promise<void> => {
    while (inflight.size >= 4 * SNAPSHOT_SLOTS) await Promise.race(inflight);
    guard();
    const task: Promise<void> = slots.run(work)
      .catch((error: unknown) => { failure ??= { error }; })
      .finally(() => inflight.delete(task));
    inflight.add(task);
  };

  const link = async (source: Buffer, copy: Buffer, rel: Buffer): Promise<void> => {
    let real: Buffer;
    try {
      real = await slots.run(() => kernelRealpathAsync(source));
    } catch (error) {
      if (VANISHED.has(errno(error) ?? '')) { skipped += 1; return; }
      throw readFailure(rel, error);
    }
    if (!containedIn(real, realRoot)) throw new TypedFailure('snapshot-link', `Verification cannot copy links outside the project: ${shown(rel)}`);
    const targetRel = real.length === realRoot.length ? Buffer.alloc(0) : real.subarray(realRoot.length + 1);
    if (targetRel.toString().split(path.sep).some(part => EXCLUDED.some(name => name.toString() === part))) { skipped += 1; return; }
    if (process.platform === 'win32') {
      // A Windows link needs privileges the worker does not hold: a junction
      // (absolute, inside the copy) for a directory, the bytes for a file.
      const isDirectory = (await slots.run(() => stat(real))).isDirectory();
      if (!isDirectory) { await schedule(() => copyFile(source, copy, rel)); return; }
      const copyTarget = Buffer.concat([Buffer.from(target), SEP, targetRel]);
      await slots.run(() => symlink(copyTarget, copy, 'junction'));
    } else {
      // latin1 maps bytes to code units one to one: a non-UTF-8 name survives the split.
      const from = rel.toString('latin1').split('/').slice(0, -1);
      const to = targetRel.length ? targetRel.toString('latin1').split('/') : [];
      let common = 0;
      while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
      const relative = [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/') || '.';
      await slots.run(() => symlink(Buffer.from(relative, 'latin1'), copy));
    }
    links += 1;
    records.push({ rel, record: Buffer.concat([rel, NUL, Buffer.from('L'), NUL, posix(targetRel), NUL]) });
  };

  const walk = async (directory: Buffer, copyDirectory: Buffer, rel: Buffer, depth: number): Promise<void> => {
    guard();
    let listed: Dirent<Buffer>[];
    try {
      listed = await slots.run(async () => {
        if (process.platform === 'win32') {
          // Windows opens no directory descriptor: the kernel realpath is the check.
          if (!containedIn(await kernelRealpathAsync(directory), realRoot)) throw new OutsideRootError('listed outside the root');
          return await readdir(directory, { withFileTypes: true, encoding: 'buffer' });
        }
        const handle = await openContained(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0), realRoot);
        try {
          return await readdir(PROC_FD ? `/proc/self/fd/${handle.fd}` : directory, { withFileTypes: true, encoding: 'buffer' });
        } finally {
          await handle.close();
        }
      });
    } catch (error) {
      if (error instanceof OutsideRootError) throw new TypedFailure('snapshot-link', `Verification cannot copy links outside the project: ${shown(rel)}`);
      if (depth > 0 && VANISHED.has(errno(error) ?? '')) { skipped += 1; return; }
      throw readFailure(rel, error);
    }
    // Counted when listed, before any is copied: a flat directory over the bound costs one listing.
    const kept = listed.filter(entry => !excluded(entry.name));
    entries += kept.length;
    onProgress?.(entries);
    if (entries > MAX_ENTRIES) throw new TypedFailure('snapshot-bounds', BOUNDS);
    for (const entry of kept) {
      guard();
      const source = Buffer.concat([directory, SEP, entry.name]);
      const copy = Buffer.concat([copyDirectory, SEP, entry.name]);
      const entryRel = childOf(rel, entry.name, SLASH);
      if (entry.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) throw new TypedFailure('snapshot-bounds', BOUNDS);
        // Owner-only and never chmodded to the source mode: a 0o555 source
        // directory must not make the final removal fail.
        await slots.run(() => mkdir(copy, { mode: 0o700 }));
        await walk(source, copy, entryRel, depth + 1);
      } else if (entry.isSymbolicLink()) {
        await link(source, copy, entryRel);
      } else if (entry.isFile()) {
        await schedule(() => copyFile(source, copy, entryRel));
      } else {
        throw new TypedFailure('snapshot-special-file', `Verification snapshot contains a non-regular file: ${shown(entryRel)}`);
      }
    }
  };

  try {
    await mkdir(target, { mode: 0o700 });
    await walk(realRoot, Buffer.from(target), Buffer.alloc(0), 0);
  } catch (error) {
    failure ??= { error };
  }
  // No write may still be in flight when the caller removes the copy.
  await Promise.allSettled([...inflight]);
  if (failure) throw failure.error;
  // Code-unit order, never locale order: the digest must not depend on the host's locale.
  records.sort((a, b) => Buffer.compare(a.rel, b.rel));
  const digest = createHash('sha256');
  for (const { record } of records) digest.update(record);
  return {
    digest: digest.digest('hex'), entries, files, bytes, links, skipped, unstable, unstablePaths,
    ms: Math.round(performance.now() - started),
  };
}

/** Why the one deadline's controller fired. */
class VerificationStop extends Error {
  constructor(readonly why: 'deadline' | 'cleanup') { super(why); }
}

/** Fixed harness through run_shell; it never executes package scripts or project config. */
export async function runParentTests(sandbox: ToolSandbox, argv: readonly string[], timeoutMs: number, logger?: Logger): Promise<ParentTestObservation> {
  if (argv.length !== 1) throw new Error('atoma-verify requires one JSON suite');
  const suite = parentTestSuiteSchema.parse(JSON.parse(argv[0]!));
  const suiteDigest = parentTestSuiteDigest(suite);
  // ONE deadline covers the copy and the run: the window is the caller's, never twice.
  const deadline = Date.now() + timeoutMs;
  const generation = sandbox.cleanupGeneration;
  const root = (await kernelRealpathAsync(sandbox.resolve(suite.cwd))).toString();
  const temp = (await kernelRealpathAsync(await mkdtemp(path.join(tmpdir(), 'atoma-acceptance-')))).toString();
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(new VerificationStop('deadline')), Math.max(1, deadline - Date.now()));
  deadlineTimer.unref();
  // Scoped to this call: the disposer below removes it on every path.
  const dispose = sandbox.onCleanup(() => controller.abort(new VerificationStop('cleanup')));
  const project = path.join(temp, 'project');
  // The snapshot path is random per run: failure text keeps it out, so the
  // same failure repeats byte-identically and the repeat tracker can see it.
  const normalize = (text: string): string => text.split(project).join('.').split(temp).join('.');
  let observation: ParentTestObservation = { suiteDigest, workspaceDigest: '', status: 'unavailable', passed: 0, failed: 0, skipped: 0, details: '' };
  const copyStarted = Date.now();
  let copied = 0;
  try {
    let receipt: SnapshotReceipt;
    try {
      receipt = await snapshotProject(root, project, controller.signal, (entries) => { copied = entries; });
    } catch (error) {
      if (controller.signal.reason instanceof VerificationStop && error === controller.signal.reason) throw stopFailure(controller.signal.reason, copied, Date.now() - copyStarted);
      throw error;
    }
    logger?.info(`[tool:atoma-verify] snapshot ${receipt.entries} entries, ${receipt.files} files, ${receipt.bytes} bytes, ` +
      `${receipt.links} links, ${receipt.skipped} skipped, ${receipt.unstable} unstable in ${receipt.ms} ms`);
    observation = { ...observation, workspaceDigest: receipt.digest, snapshot: {
      entries: receipt.entries, files: receipt.files, bytes: receipt.bytes, links: receipt.links,
      skipped: receipt.skipped, unstable: receipt.unstable, ms: receipt.ms,
    } };
    // From here to `spawn`, no await: the checks below see the state the spawn sees.
    // Stop Vite's workspace discovery at this disposable project.
    writeFileSync(path.join(project, 'pnpm-workspace.yaml'), 'packages: []\n');
    if (!existsSync(path.join(project, 'package.json'))) writeFileSync(path.join(project, 'package.json'), '{"type":"module"}');
    const source = path.join(project, 'atoma.acceptance.test.ts');
    const report = path.join(project, 'atoma.report.json');
    // The copy may carry old lookalike files. Their bytes are never authoritative.
    rmSync(source, { force: true }); rmSync(report, { force: true });
    writeFileSync(source, suite.source, { flag: 'wx' });
    const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './parentTestWorker.ts' : './parentTestWorker.js', import.meta.url));
    if (!existsSync(worker)) throw new TypedFailure('worker-missing', 'Compiled acceptance worker is unavailable; build the tool runtime first');
    const modules = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))));
    // A cleanup that started during the copy has already killed the children
    // it knew about; a child spawned after it would outlive the sandbox.
    if (sandbox.cleanupGeneration !== generation) throw stopFailure(new VerificationStop('cleanup'), copied, Date.now() - copyStarted);
    if (controller.signal.aborted) throw stopFailure(controller.signal.reason as VerificationStop, copied, Date.now() - copyStarted);
    const childWindowMs = Math.max(1, deadline - Date.now());
    let timedOut = false;
    const outcome = await new Promise<{ code: number | null; details: string; spawnError?: string }>(resolve => {
      // Node permissions complement the existing container boundary: no child
      // processes, live workspace reads/writes, or parent environment. Vitest
      // threads receive filesystem permissions but cannot create more workers,
      // child processes or load native addons. The coordinator alone uses
      // its installed native compiler. The container remains the OS boundary.
      const child = spawn(process.execPath, [
        '--permission', `--allow-fs-read=${project}`, `--allow-fs-read=${modules}`,
        `--allow-fs-read=${path.dirname(worker)}`,
        `--allow-fs-read=${path.resolve(path.dirname(worker), '../../node_modules')}`,
        `--allow-fs-read=${path.resolve(path.dirname(worker), '../../package.json')}`,
        `--allow-fs-write=${project}`,
        '--allow-worker', '--allow-addons', worker, project,
      ], { cwd: project, env: sandboxChildEnv({ HOME: project, TMPDIR: project, NODE_ENV: 'test' }),
        detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      sandbox.trackChild(child);
      let output = '';
      const collect = (data: Buffer) => { output = (output + data.toString()).slice(-6000); };
      child.stdout?.on('data', collect); child.stderr?.on('data', collect);
      const kill = () => {
        try { if (child.pid && child.pid > 1) process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited / Windows */ }
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, childWindowMs);
      child.once('error', error => { clearTimeout(timer); kill(); resolve({ code: null, details: output, spawnError: error.message }); });
      child.once('close', code => { clearTimeout(timer); kill(); resolve({ code, details: output }); });
    });
    const tail = normalize(outcome.details).slice(-6000);
    const withOutput = tail ? { output: tail } : {};
    if (outcome.spawnError) {
      return { ...observation, ...withOutput, cause: 'runner-error', details: `The runner could not start: ${normalize(outcome.spawnError).slice(0, 1000)}` };
    }
    // Checked before the report: code that rewrites the suite owns whatever report follows.
    if (!existsSync(source) || readFileSync(source, 'utf8') !== suite.source) {
      return { ...observation, ...withOutput, cause: 'source-changed', details: 'The acceptance source changed or vanished during verification' };
    }
    if (!existsSync(report)) {
      return timedOut
        ? { ...observation, ...withOutput, cause: 'timeout', details: `The runner was killed after ${timeoutMs} ms` }
        : { ...observation, ...withOutput, cause: 'exited-without-report', details: `The runner exited with code ${String(outcome.code)} and wrote no report` };
    }
    if (lstatSync(report).size > 8 * 1024 * 1024) {
      return { ...observation, ...withOutput, cause: 'report-oversize', details: 'The verification report exceeds 8 MiB' };
    }
    let parsed: z.infer<typeof reportSchema>;
    try {
      parsed = reportSchema.parse(JSON.parse(readFileSync(report, 'utf8')));
    } catch (error) {
      return { ...observation, ...withOutput, cause: 'report-invalid', details: `The verification report is not the expected shape: ${normalize(String(error)).slice(0, 1000)}` };
    }
    const skipped = parsed.numPendingTests + parsed.numTodoTests;
    const passed = outcome.code === 0 && parsed.success && parsed.numTotalTests > 0 &&
      parsed.numPassedTests === parsed.numTotalTests && parsed.numFailedTests === 0 && skipped === 0;
    // Host notes are array elements, so the details stay one JSON array.
    const notes: string[] = [];
    if (receipt.skipped > 0 || receipt.unstable > 0) {
      notes.push(`Host: the snapshot skipped ${receipt.skipped} unreachable entries and copied ${receipt.unstable} files that kept changing: ${receipt.unstablePaths.join(', ')}`);
    }
    if (parsed.numTotalTests === 0 && parsed.testResults.some(module => module.message?.trim())) {
      notes.push('Host: the suite module did not load; no test ran.');
    }
    // A report carries the assertion outcomes; the raw tail would only repeat them.
    return { ...observation, status: passed ? 'passed' : 'failed', cause: 'ran', passed: parsed.numPassedTests,
      failed: parsed.numFailedTests, skipped,
      details: normalize(JSON.stringify([...notes, ...parsed.testResults.flatMap(module => [module.message ?? '',
        ...module.assertionResults.map(test => ({ name: test.fullName, status: test.status, failures: test.failureMessages })),
      ])])).slice(0, 8000),
    };
  } catch (error) {
    return error instanceof TypedFailure
      ? { ...observation, cause: error.failure, details: normalize(error.message).slice(0, 2000) }
      : { ...observation, cause: 'runner-error', details: normalize(String(error)).slice(0, 2000) };
  } finally {
    clearTimeout(deadlineTimer);
    dispose();
    try {
      await rm(temp, { recursive: true, force: true });
    } catch (error) {
      logger?.warn(`[tool:atoma-verify] the verification copy could not be removed: ${String(error).slice(0, 300)}`);
    }
  }
}

function stopFailure(stop: VerificationStop, entries: number, ms: number): TypedFailure {
  return stop.why === 'deadline'
    ? new TypedFailure('snapshot-timeout', `Verification timed out while copying the project snapshot (${entries} entries in ${ms} ms)`)
    : new TypedFailure('runner-error', 'Verification stopped: the sandbox is shutting down');
}
