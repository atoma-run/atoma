import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { withinReadOnlyPhase } from '../src/atoms/dispatch.js';
import { acceptRootResult, observedLayoutsBlock } from '../src/atoms/rootAcceptance.js';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { superviseLoop } from '../src/core/supervisor.js';
import { Atom } from '../src/core/atom.js';
import {
  DEFAULT_READ_ONLY_PHASE_LIMITS,
  readOnlyPhasesFor,
  restoreReadOnlyPhase,
  snapshotReadOnlyPhase,
} from '../src/run/readOnlyPhase.js';
import {
  READ_ONLY_RESTORED_PREFIX,
  READ_ONLY_TASK_LINE,
  renderRestorationsBlock,
  restorationDamaged,
  restorationMatters,
  staleObservations,
} from '../src/contracts/readOnlyPhase.js';
import { markLanded } from '../src/atoms/dispatch.js';
import { buildResultGateEnv, runResultGates } from '../src/atoms/resultGates.js';
import { llmVerdict, VALIDATION_SYSTEM_PROMPT } from '../src/atoms/verdict.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { makePlan, makeTools } from './helpers/factories.js';
import { jsonText, makeCtx } from './helpers.js';
import type { Plan, Result, RunContext, Task, Tool, ToolExecutor, Verdict } from '../src/core/types.js';

/**
 * A phase a ROOT decomposition gives no `outputs` runs between a photograph
 * of the workspace and its restoration.
 *
 * Run 04ea696f (2026-09-30, deep): phase 1 fixed one label of index.html;
 * phase 2, "read-only verification" with no outputs, opened with `write_file`
 * of a whole new index.html — other title, other labels, a 25/45/60 select
 * where the page had 15/25/45 — and that page was delivered.
 * Run f793b338 (2026-09-27, short): the root cell's remediation plan had a
 * "read-only inspect" subtask with no outputs, and its molecule overwrote the
 * home page 23 times without reading it.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodRecursive(dir);
    } catch {
      // Best effort: a test that made a directory unreadable restores it here.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function chmodRecursive(dir: string): void {
  if (process.platform === 'win32') return;
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stats = lstatSync(path);
    if (stats.isDirectory()) chmodRecursive(path);
    else if (stats.isFile()) chmodSync(path, 0o644);
  }
}

function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-read-only-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');
const posix = process.platform !== 'win32';
const SQLITE_BYTES = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(84, 1)]);

describe('the photograph and restore of a read-only phase', () => {
  it('puts back changed, removed and replaced files, removes what the phase added, and reports each', () => {
    const root = workspace({ 'index.html': '<h1>Pomodoro</h1>', 'app.js': 'start()', 'assets/logo.svg': '<svg/>', 'style.css': 'a{color:red}' });
    const snapshot = snapshotReadOnlyPhase(root);
    writeFileSync(join(root, 'index.html'), '<h1>Another page</h1>');
    // Same size, within the same kernel tick: only the bytes can tell.
    writeFileSync(join(root, 'style.css'), 'a{color:tan}');
    rmSync(join(root, 'app.js'));
    rmSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets'), 'a file where a directory was');
    writeFileSync(join(root, 'notes.txt'), 'scratch the phase left');
    mkdirSync(join(root, 'tmp/deep'), { recursive: true });
    writeFileSync(join(root, 'tmp/deep/x.js'), 'x');

    const { paths, left, partial } = restoreReadOnlyPhase(snapshot);
    expect(read(root, 'index.html')).toBe('<h1>Pomodoro</h1>');
    expect(read(root, 'style.css')).toBe('a{color:red}');
    expect(read(root, 'app.js')).toBe('start()');
    expect(read(root, 'assets/logo.svg')).toBe('<svg/>');
    expect(existsSync(join(root, 'notes.txt'))).toBe(false);
    expect(existsSync(join(root, 'tmp'))).toBe(false);
    expect(paths).toEqual(expect.arrayContaining([
      { path: 'index.html', change: 'changed', before: 17, after: 21, restored: true },
      { path: 'style.css', change: 'changed', before: 12, after: 12, restored: true },
      { path: 'app.js', change: 'removed', before: 7, restored: true },
      { path: 'assets/', change: 'changed', restored: true },
      { path: 'assets/logo.svg', change: 'removed', before: 6, restored: true },
      { path: 'notes.txt', change: 'created', after: 22, restored: true },
      { path: 'tmp/', change: 'created', restored: true },
    ]));
    expect(paths).toHaveLength(7);
    expect(left).toEqual([]);
    expect(partial).toBe(false);
    // Nothing changed since: nothing to report.
    expect(restoreReadOnlyPhase(snapshotReadOnlyPhase(root)).paths).toEqual([]);
  });

  it('keeps what a phase that changed nothing recorded, and puts its probe manifest back with anything it changed', () => {
    const manifest = '{"version":1,"entries":[]}';
    const recorded = '{"version":1,"entries":[{"cmd":"node t.js","exitCode":0}]}';
    const root = workspace({ 'index.html': 'a', '.atoma-probes.json': manifest, 'node_modules/x/index.js': 'v1', '.git/HEAD': 'ref' });
    const quiet = snapshotReadOnlyPhase(root);
    writeFileSync(join(root, '.atoma-probes.json'), recorded);
    mkdirSync(join(root, '.atoma-scratch'));
    writeFileSync(join(root, '.atoma-scratch/rows.csv'), 'a,b');
    writeFileSync(join(root, 'node_modules/x/index.js'), 'v2');
    writeFileSync(join(root, '.git/HEAD'), 'other');
    expect(restoreReadOnlyPhase(quiet).paths).toEqual([]);
    expect(read(root, '.atoma-probes.json')).toBe(recorded);
    expect(read(root, '.atoma-scratch/rows.csv')).toBe('a,b');
    expect(read(root, 'node_modules/x/index.js')).toBe('v2');
    expect(read(root, '.git/HEAD')).toBe('other');

    // A server that rewrote its data file while the phase probed it is a side
    // effect: the file goes back, and the probes the phase recorded stay.
    const probed = snapshotReadOnlyPhase(root);
    writeFileSync(join(root, 'index.html'), 'the server rewrote this');
    const probedRecord = '{"version":1,"entries":[{"probe":"http","method":"GET","path":"/","status":200}]}';
    writeFileSync(join(root, '.atoma-probes.json'), probedRecord);
    const sideEffect = restoreReadOnlyPhase(probed);
    expect(read(root, 'index.html')).toBe('a');
    expect(sideEffect.written).toEqual([]);
    expect(read(root, '.atoma-probes.json')).toBe(probedRecord);

    // A phase that rewrote the page ITSELF recorded its probes against that
    // page: they go back with it (adversarial review 2026-09-30).
    const noisy = snapshotReadOnlyPhase(root);
    writeFileSync(join(root, 'index.html'), 'another page');
    writeFileSync(join(root, '.atoma-probes.json'), '{"version":1,"entries":[{"probe":"web","file":"index.html","smoke":"true"}]}');
    const { paths, written } = restoreReadOnlyPhase(noisy, { writes: ['./index.html'] });
    expect(read(root, 'index.html')).toBe('a');
    expect(read(root, '.atoma-probes.json')).toBe(probedRecord);
    expect(written).toEqual(['index.html']);
    expect(paths.map((path) => path.path)).toEqual(['index.html', '.atoma-probes.json']);
    expect(read(root, '.atoma-scratch/rows.csv')).toBe('a,b');
  });

  it.skipIf(!posix)('puts modes back, directories first, and follows no link the phase made to a path outside the workspace', () => {
    const outside = workspace({ 'app.js': 'HOST FILE', 'secret.txt': 'HOST SECRET' });
    const root = workspace({ 'assets/app.js': 'workspace app', 'index.html': 'page', 'run.sh': 'echo hi', 'docs/a.md': 'a' });
    chmodSync(join(root, 'run.sh'), 0o755);
    const snapshot = snapshotReadOnlyPhase(root);
    chmodSync(join(root, 'run.sh'), 0o600);
    // A directory the phase made read-only, holding a file it rewrote.
    writeFileSync(join(root, 'docs/a.md'), 'rewritten');
    chmodSync(join(root, 'docs'), 0o555);
    // A directory replaced by a link to a host directory holding a file of
    // the same name: following it would write the workspace's bytes there.
    rmSync(join(root, 'assets'), { recursive: true });
    symlinkSync(join(outside), join(root, 'assets'));
    // A file replaced by a link to a host file: writing through it would
    // overwrite the host file.
    rmSync(join(root, 'index.html'));
    symlinkSync(join(outside, 'secret.txt'), join(root, 'index.html'));
    // A link the phase added: removing it must not remove its target.
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));

    restoreReadOnlyPhase(snapshot);
    expect(read(outside, 'app.js')).toBe('HOST FILE');
    expect(read(outside, 'secret.txt')).toBe('HOST SECRET');
    expect(lstatSync(join(root, 'assets')).isDirectory()).toBe(true);
    expect(read(root, 'assets/app.js')).toBe('workspace app');
    expect(lstatSync(join(root, 'index.html')).isFile()).toBe(true);
    expect(read(root, 'index.html')).toBe('page');
    expect(existsSync(join(root, 'leak.txt'))).toBe(false);
    expect(statSync(join(root, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, 'docs')).mode & 0o777).not.toBe(0o555);
    expect(read(root, 'docs/a.md')).toBe('a');
  });

  it.skipIf(!posix || process.getuid?.() === 0)('puts the root mode back first, and a directory set to 000 (second review)', () => {
    const root = workspace({ 'index.html': 'page', 'docs/a.md': 'a' });
    const rootMode = statSync(root).mode & 0o777;
    const docsMode = statSync(join(root, 'docs')).mode & 0o777;
    const snapshot = snapshotReadOnlyPhase(root);
    writeFileSync(join(root, 'index.html'), 'rewritten');
    writeFileSync(join(root, 'docs/a.md'), 'rewritten');
    chmodSync(join(root, 'docs'), 0o000);
    chmodSync(root, 0o555);
    restoreReadOnlyPhase(snapshot);
    expect(statSync(root).mode & 0o777).toBe(rootMode);
    expect(read(root, 'index.html')).toBe('page');
    if (process.platform === 'linux') {
      expect(statSync(join(root, 'docs')).mode & 0o777).toBe(docsMode);
      expect(read(root, 'docs/a.md')).toBe('a');
      // A root the phase set to 000 cannot even be opened (third review).
      const again = snapshotReadOnlyPhase(root);
      writeFileSync(join(root, 'index.html'), 'rewritten again');
      chmodSync(root, 0o000);
      restoreReadOnlyPhase(again);
      expect(statSync(root).mode & 0o777).toBe(rootMode);
      expect(read(root, 'index.html')).toBe('page');
    }
  });

  it('puts a file back as a new file, never through a hard link, and removes every second name the phase made', () => {
    const root = workspace({ 'index.html': 'page', 'data.json': '{"notes":[]}', 'app.js': 'app' });
    const snapshot = snapshotReadOnlyPhase(root);
    rmSync(join(root, 'index.html'));
    linkSync(join(root, 'data.json'), join(root, 'index.html'));
    linkSync(join(root, 'data.json'), join(root, 'copy.json'));
    // A rename: the photographed inode under a new name, the old name gone.
    // With the old name put back, both are listed, and the new one is the
    // phase's (second review: ext4 also reuses a freed inode for a new file).
    renameSync(join(root, 'app.js'), join(root, 'app.bak.js'));
    const { paths } = restoreReadOnlyPhase(snapshot);
    expect(read(root, 'index.html')).toBe('page');
    expect(read(root, 'data.json')).toBe('{"notes":[]}');
    expect(read(root, 'app.js')).toBe('app');
    expect(existsSync(join(root, 'copy.json'))).toBe(false);
    expect(existsSync(join(root, 'app.bak.js'))).toBe(false);
    expect(paths).toContainEqual({ path: 'copy.json', change: 'created', after: 12, restored: true });
    expect(paths).toContainEqual({ path: 'app.bak.js', change: 'created', after: 3, restored: true });
  });

  it('reports what it could not keep, and deletes nothing in a directory it could not see whole', () => {
    const root = workspace({ 'big.bin': 'x'.repeat(64), 'a.txt': 'a' });
    const snapshot = snapshotReadOnlyPhase(root, { ...DEFAULT_READ_ONLY_PHASE_LIMITS, maxKeptFileBytes: 16 });
    writeFileSync(join(root, 'big.bin'), 'y'.repeat(64));
    expect(restoreReadOnlyPhase(snapshot).paths).toEqual([
      { path: 'big.bin', change: 'changed', before: 64, after: 64, restored: false, reason: 'larger than the photograph keeps' },
    ]);

    const many = workspace({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    const capped = snapshotReadOnlyPhase(many, { ...DEFAULT_READ_ONLY_PHASE_LIMITS, maxEntries: 2 });
    expect(capped.complete).toBe(false);
    writeFileSync(join(many, 'a.txt'), 'changed');
    writeFileSync(join(many, 'new.txt'), 'new');
    const restored = restoreReadOnlyPhase(capped);
    expect(restored.paths).toEqual([{ path: 'a.txt', change: 'changed', before: 1, after: 7, restored: true }]);
    expect(restored.partial).toBe(true);
    expect(read(many, 'a.txt')).toBe('a');
    expect(read(many, 'new.txt')).toBe('new');
  });

  it('says so when a photograph was partial, even when it restored nothing (adversarial review 2026-09-30)', () => {
    const root = workspace({ 'a.txt': 'a', 'b.txt': 'b' });
    const lines: string[] = [];
    const guard = readOnlyPhasesFor(root, (line) => lines.push(line), { ...DEFAULT_READ_ONLY_PHASE_LIMITS, maxEntries: 1 }).begin('verify', 1);
    writeFileSync(join(root, 'b.txt'), 'rewritten past the cap');
    const restoration = guard.end();
    expect(restoration).toMatchObject({ paths: [], partial: true });
    expect(restorationMatters(restoration)).toBe(true);
    expect(lines).toHaveLength(1);
  });

  it.skipIf(!posix || process.getuid?.() === 0)('photographs around a file it cannot read, and still removes what the phase added', () => {
    const root = workspace({ 'locked.txt': 'secret', 'index.html': 'page' });
    chmodSync(join(root, 'locked.txt'), 0o000);
    const snapshot = snapshotReadOnlyPhase(root);
    expect(snapshot.complete).toBe(true);
    writeFileSync(join(root, 'extra.html'), 'a page the verifier added');
    const { paths, partial } = restoreReadOnlyPhase(snapshot);
    expect(partial).toBe(false);
    expect(existsSync(join(root, 'extra.html'))).toBe(false);
    expect(paths).toEqual([{ path: 'extra.html', change: 'created', after: 25, restored: true }]);
  });

  it.skipIf(process.platform !== 'linux')('sees a file whose name is not UTF-8', () => {
    const root = workspace({ 'index.html': 'page' });
    const odd = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x66, 0xff, 0x2e, 0x74])]);
    writeFileSync(odd, 'original');
    const snapshot = snapshotReadOnlyPhase(root);
    writeFileSync(odd, 'rewritten');
    const added = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x67, 0xfe])]);
    writeFileSync(added, 'added');
    const { paths } = restoreReadOnlyPhase(snapshot);
    expect(readFileSync(odd, 'utf8')).toBe('original');
    expect(existsSync(added)).toBe(false);
    expect(paths.map((path) => path.change).sort()).toEqual(['changed', 'created']);
  });

  it('restores what it photographed before it removes what the phase added, on a budget of its own', () => {
    const root = workspace({ 'index.html': 'page' });
    const limits = { ...DEFAULT_READ_ONLY_PHASE_LIMITS, maxRemovedEntries: 10 };
    const snapshot = snapshotReadOnlyPhase(root, limits);
    mkdirSync(join(root, 'build'));
    for (let i = 0; i < 25; i += 1) writeFileSync(join(root, `build/f${i}.js`), 'x');
    writeFileSync(join(root, 'index.html'), 'rewritten');
    const { paths } = restoreReadOnlyPhase(snapshot);
    expect(read(root, 'index.html')).toBe('page');
    expect(paths).toContainEqual({ path: 'index.html', change: 'changed', before: 4, after: 9, restored: true });
    expect(paths).toContainEqual(expect.objectContaining({ path: 'build/', change: 'created', restored: false }));
  });

  it('leaves a SQLite database and its sidecars as they are, and says so without making the phase restored', () => {
    const root = workspace({ 'index.html': 'page' });
    writeFileSync(join(root, 'data.db'), SQLITE_BYTES);
    const lines: string[] = [];
    const guard = readOnlyPhasesFor(root, (line) => lines.push(line)).begin('verify the notes API', 1);
    writeFileSync(join(root, 'data.db'), Buffer.concat([SQLITE_BYTES, Buffer.from('a row the probes wrote')]));
    writeFileSync(join(root, 'data.db-wal'), 'wal frames a live connection still needs');
    const restoration = guard.end({ observations: ['observation-1'] });
    expect(readFileSync(join(root, 'data.db')).length).toBe(SQLITE_BYTES.length + 22);
    expect(existsSync(join(root, 'data.db-wal'))).toBe(true);
    expect(restoration.paths).toEqual([]);
    expect(restoration.left.map((path) => [path.path, path.change])).toEqual([['data.db', 'changed'], ['data.db-wal', 'created']]);
    expect(restorationMatters(restoration)).toBe(false);
    // Nothing was put back, so what the phase observed still counts.
    expect(restoration.observations).toEqual([]);
    expect(lines).toEqual([]);
    expect(renderRestorationsBlock([restoration])).toContain('left as they are: data.db (changed');

    // Second review: a database the photograph saw EMPTY went live during the
    // phase; replacing it lost its table under the live connection.
    writeFileSync(join(root, 'notes.db'), '');
    const empty = readOnlyPhasesFor(root, () => undefined).begin('verify again', 1);
    writeFileSync(join(root, 'notes.db'), SQLITE_BYTES);
    writeFileSync(join(root, 'notes.db-shm'), 'shared memory');
    const live = empty.end();
    expect(readFileSync(join(root, 'notes.db')).length).toBe(SQLITE_BYTES.length);
    expect(existsSync(join(root, 'notes.db-shm'))).toBe(true);
    expect(live.left.map((path) => path.path)).toEqual(expect.arrayContaining(['notes.db', 'notes.db-shm']));
  });



  it('tells a side effect of verifying from damage: only the phase\'s own writes make its evidence stale (second review)', () => {
    const root = workspace({ 'index.html': 'page', 'data.json': '[]' });
    const phases = readOnlyPhasesFor(root, () => undefined);
    const probing = phases.begin('verify the notes API', 1);
    writeFileSync(join(root, 'data.json'), '[{"id":1}]');
    const sideEffect = probing.end({ observations: ['http-1', 'browser-1'], writes: [] });
    expect(read(root, 'data.json')).toBe('[]');
    expect(restorationMatters(sideEffect)).toBe(true);
    expect(restorationDamaged(sideEffect)).toBe(false);
    expect(sideEffect.observations).toEqual(['http-1', 'browser-1']);
    expect(staleObservations([sideEffect]).size).toBe(0);
    const rewriting = phases.begin('verify the page', 1);
    mkdirSync(join(root, 'tmp'));
    writeFileSync(join(root, 'tmp/x.js'), 'x');
    const damage = rewriting.end({ observations: ['browser-2'], writes: ['/workspace/tmp/x.js'] });
    expect(damage.written).toEqual(['tmp/']);
    expect([...staleObservations([sideEffect, damage])]).toEqual(['browser-2']);
  });

  it('owns what its writes, its servers, its commands or its script touched, and nothing else (third review)', () => {
    const own = (record: Parameters<typeof restoreReadOnlyPhase>[1], change: (root: string) => void) => {
      const root = workspace({ 'data.json': '[]', 'server.js': 'v1', 'routes/notes.js': 'r1' });
      const snapshot = snapshotReadOnlyPhase(root);
      change(root);
      return restoreReadOnlyPhase(snapshot, record).written;
    };
    const serverWritesData = (root: string) => writeFileSync(join(root, 'data.json'), '[{"id":1}]');
    // A sanctioned scratch write is not the data file of the same name.
    expect(own({ writes: ['.atoma-scratch/data.json'] }, serverWritesData)).toEqual([]);
    expect(own({ writes: ['data.json'] }, serverWritesData)).toEqual(['data.json']);
    expect(own({ writes: ['/workspace/data.json'] }, serverWritesData)).toEqual(['data.json']);
    const patch = (root: string) => writeFileSync(join(root, 'server.js'), 'v2');
    expect(own({ serverEntries: ['./server.js'] }, patch)).toEqual(['server.js']);
    const shellPatch = (root: string) => writeFileSync(join(root, 'routes/notes.js'), 'r2');
    expect(own({ commands: ['{"command":"sed","args":["-i","s/a/b/","routes/notes.js"]}'] }, shellPatch)).toEqual(['routes/notes.js']);
    expect(own({ commands: ['{"command":"node","args":["test.js"]}'] }, serverWritesData)).toEqual([]);
    expect(own({ ownsEveryChange: true }, serverWritesData)).toEqual(['data.json']);
  });

  it('lists every execution, reports those that matter once each, and says when a phase could not be guarded', () => {
    const root = workspace({ 'index.html': 'page' });
    const lines: string[] = [];
    const phases = readOnlyPhasesFor(root, (line) => lines.push(line));
    const quiet = phases.begin('verify the page', 1).end();
    expect(quiet.paths).toEqual([]);
    const noisy = phases.begin('verify the page again', 1);
    writeFileSync(join(root, 'index.html'), 'rewritten');
    const first = noisy.end({ observations: ['e1', 'e2'], writes: ['index.html'] });
    expect(noisy.end()).toBe(first);
    expect(first.observations).toEqual(['e1', 'e2']);
    expect(first.written).toEqual(['index.html']);
    expect(restorationDamaged(first)).toBe(true);
    expect([...staleObservations([quiet, first])]).toEqual(['e1', 'e2']);
    expect(phases.restorations()).toEqual([quiet, first]);
    expect(lines).toEqual(['[read-only phase] "verify the page again": put back index.html (changed, 4 → 9 bytes; restored)']);

    const file = join(workspace(), 'not-a-directory');
    writeFileSync(file, 'x');
    const broken = readOnlyPhasesFor(file, () => undefined).begin('inspect', 2).end();
    expect(broken.unguarded).toBeDefined();
    const block = renderRestorationsBlock([quiet, first, broken]);
    expect(block).toContain('- phase "inspect": NOT guarded');
    expect(block).toContain('- phase "verify the page again": index.html (changed, 4 → 9 bytes; restored)');
    expect(block).toContain('- changed nothing: "verify the page"');
    expect(renderRestorationsBlock([])).toBe('');
  });
});

/** A workspace on disk, as the host sees the tools' writes. */
class DiskExecutor implements ToolExecutor {
  constructor(readonly root: string) {}
  has(name: string): boolean {
    return ['write_file', 'read_file', 'validate_html'].includes(name);
  }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const path = join(this.root, String(args['path']));
    if (name === 'write_file') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(args['content']));
      return { ok: true, path: args['path'] };
    }
    if (name === 'read_file') return { path: args['path'], content: readFileSync(path, 'utf8') };
    return { ok: true, url: 'http://localhost:5051/', errors: [], failedRequests: [], smokeResult: { ok: true } };
  }
}

function tool(name: string): Tool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } };
}

const reply = (value: unknown) => ({ text: JSON.stringify(value), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } });

/**
 * Answers by role and tier. Every molecule writes index.html with the first
 * words of its task, so what the workspace holds at the end is decided by
 * which phases kept their writes.
 */
function roleLlm(opts: { l2: string; l1: string; l3Plan?: unknown; l2Prefilter: 'reuse' | 'escalate'; l2Plan?: unknown }) {
  const validations: string[] = [];
  const llm = {
    async complete(req: { role?: string; actor?: { tier?: number }; userContent: string; executor?: ToolExecutor }) {
      const tier = req.actor?.tier;
      switch (req.role) {
        case 'prefilter':
          if (tier === 3) return reply({ kind: 'reuse', target: opts.l2, confidence: 'high', reasoning: 'fits' });
          return opts.l2Prefilter === 'reuse'
            ? reply({ kind: 'reuse', target: opts.l1, confidence: 'high', reasoning: 'fits' })
            : reply({ kind: 'escalate', reasoning: 'plan it' });
        case 'plan':
          if (tier === 3) return { ...reply(null), text: JSON.stringify([{ strategy: 'reuse', target: opts.l2, reasoning: 'fits' }, opts.l3Plan]) };
          if (tier === 2) return { ...reply(null), text: JSON.stringify([{ strategy: 'reuse', target: opts.l1, reasoning: 'fits' }, opts.l2Plan]) };
          return reply({ reasoning: 'r', proposedAction: 'act', expectedOutput: 'e' });
        case 'execute': {
          const task = /Task: (.*)/.exec(req.userContent)?.[1] ?? 'unknown';
          await req.executor!.execute('write_file', { path: 'index.html', content: `written by: ${task}` });
          return reply({ output: { files: ['index.html'] }, summary: `done: ${task}` });
        }
        case 'validate-result':
          validations.push(req.userContent);
          return reply({ approved: true, reasoning: 'ok' });
        default:
          return reply({ approved: true, reasoning: 'ok' });
      }
    },
  };
  return { llm: llm as unknown as RunContext['llm'], validations };
}

function registryWithTiers() {
  const reg = new AtomRegistry(openDb(':memory:'));
  const seed = { description: 'seed', systemPrompt: 'sys', tools: [], params: {}, createdBy: 'test' };
  const l3Type = reg.create(3, seed);
  const l2Type = reg.create(2, seed);
  const l1Type = reg.create(1, { ...seed, tools: [tool('write_file'), tool('validate_html')] });
  return { reg, l3Type, l2Type, l1Type };
}

function runCtx(root: string, llm: RunContext['llm']): RunContext {
  return { ...makeCtx(), llm, tools: new DiskExecutor(root), readOnlyPhases: readOnlyPhasesFor(root, () => undefined) };
}

const fixThenVerify = (l2: string, mode: 'sequential' | 'concat' = 'sequential') => ({
  reasoning: 'fix, then verify',
  subtasks: [
    { description: 'fix the long-break label in index.html', preferredChild: l2, outputs: ['index.html'] },
    { description: 'verify the page in the browser', preferredChild: l2 },
  ],
  aggregation: { mode },
  expectedOutput: 'a fixed, verified page',
});

describe('a read-only phase in a run', () => {
  it("puts back what the tissue's outputless phase wrote, before its result is judged, and credits its cell nothing (run 04ea696f)", async () => {
    const { reg, l3Type, l2Type, l1Type } = registryWithTiers();
    const root = workspace({ 'index.html': 'the seeded page' });
    const { llm, validations } = roleLlm({ l2: l2Type.name, l1: l1Type.name, l2Prefilter: 'reuse', l3Plan: fixThenVerify(l2Type.name) });
    const ctx = runCtx(root, llm);
    await L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS).handle({ description: 'fix the label, keep the page' }, ctx);

    expect(read(root, 'index.html')).toBe('written by: fix the long-break label in index.html');
    const restorations = ctx.readOnlyPhases!.restorations();
    expect(restorations).toHaveLength(1);
    expect(restorations[0]).toMatchObject({ phase: 'verify the page in the browser', attempt: 1,
      paths: [{ path: 'index.html', change: 'changed', restored: true }] });
    // The tissue's judgement of the verification phase reads the restoration,
    // and the task line says the phase is read-only.
    const phaseVerdict = validations.find((text) => text.includes('(tier 3)') && text.includes('Task: verify the page in the browser'));
    expect(phaseVerdict).toContain(READ_ONLY_RESTORED_PREFIX);
    expect(phaseVerdict).toContain(READ_ONLY_TASK_LINE);
    expect(validations.filter((text) => text.includes('Task: fix the long-break')).every((text) => !text.includes(READ_ONLY_TASK_LINE))).toBe(true);
    // Second review: the cell judging the molecule INSIDE that phase knows it
    // is read-only too, so a failure it reports is a finding, not a fix to coach.
    const inner = validations.filter((text) => text.includes('(tier 2)') && text.includes('Task: verify the page in the browser'));
    expect(inner.length).toBeGreaterThan(0);
    expect(inner.every((text) => text.includes(READ_ONLY_TASK_LINE))).toBe(true);
    // One success for the fixing phase; none for the restored one, neither
    // for its cell nor for the molecule that rewrote the page (third review).
    expect(reg.getByName(l2Type.name)!.successes).toBe(1);
    expect(reg.getByName(l1Type.name)!.successes).toBe(1);
  });

  it('leaves a one-phase plan, a parallel plan, and a one-phase plan routing split in two alone', async () => {
    for (const shape of ['one-phase', 'parallel'] as const) {
      const { reg, l3Type, l2Type, l1Type } = registryWithTiers();
      const root = workspace({ 'index.html': 'the seeded page' });
      const plan = shape === 'parallel'
        ? fixThenVerify(l2Type.name, 'concat')
        : { reasoning: 'one phase', subtasks: [{ description: 'build the page', preferredChild: l2Type.name }], aggregation: { mode: 'sequential' }, expectedOutput: 'a page' };
      const { llm } = roleLlm({ l2: l2Type.name, l1: l1Type.name, l2Prefilter: 'reuse', l3Plan: plan });
      const ctx = runCtx(root, llm);
      await L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS).handle({ description: 'change the page' }, ctx);
      expect(read(root, 'index.html')).toMatch(/^written by: /);
      expect(ctx.readOnlyPhases!.restorations()).toEqual([]);
    }

    // Adversarial review 2026-09-30: `routeCrossBucketVerification` split
    // this ONE phase into a browser half and a shell half, both were marked,
    // and every byte the run built was put back.
    const reg = new AtomRegistry(openDb(':memory:'));
    const seed = { description: 'seed', systemPrompt: 'sys', tools: [] as Tool[], params: {}, createdBy: 'test' };
    const l3Type = reg.create(3, seed);
    const scribe = reg.create(2, seed);
    reg.create(2, { ...seed, tools: [tool('validate_html')] });
    reg.create(2, { ...seed, tools: [tool('run_shell'), tool('start_node_server')] });
    const l1Type = reg.create(1, { ...seed, tools: [tool('write_file'), tool('validate_html')] });
    const root = workspace({ 'index.html': 'the seeded page' });
    const onePhase = { reasoning: 'one phase', expectedOutput: 'a notes page', subtasks: [{ preferredChild: scribe.name,
      description: 'Build the notes page in index.html. Confirm it in a real browser. Then make node test.js exit 0.' }] };
    const { llm } = roleLlm({ l2: scribe.name, l1: l1Type.name, l2Prefilter: 'reuse', l3Plan: onePhase });
    const ctx = runCtx(root, llm);
    await L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS).handle({ description: 'build the notes page' }, ctx);
    expect(ctx.readOnlyPhases!.restorations()).toEqual([]);
    expect(read(root, 'index.html')).toMatch(/^written by: /);
  });

  it("guards a root cell's own sequential decomposition, never its prefilter reuse nor a cell below a tissue (run f793b338)", async () => {
    const rootCell = async (reg: AtomRegistry, type: ReturnType<AtomRegistry['create']>, task: Task, ctx: RunContext) => {
      const cell = L2Atom.fromType(type, reg);
      await cell.execute(task, await cell.plan(task, ctx), ctx);
    };
    const inspectThenFix = (l1: string) => ({
      reasoning: 'inspect, then fix',
      subtasks: [
        { description: 'fix index.html from the brief', preferredChild: l1, outputs: ['index.html'] },
        { description: 'read-only inspect index.html and list what is missing', preferredChild: l1 },
      ],
      aggregation: { mode: 'sequential' },
      expectedOutput: 'a fixed page',
    });

    const planned = registryWithTiers();
    const root = workspace({ 'index.html': 'the home page' });
    const { llm, validations } = roleLlm({ l2: planned.l2Type.name, l1: planned.l1Type.name, l2Prefilter: 'escalate', l2Plan: inspectThenFix(planned.l1Type.name) });
    const ctx = runCtx(root, llm);
    await rootCell(planned.reg, planned.l2Type, { description: 'repair the home page' }, ctx);
    expect(read(root, 'index.html')).toBe('written by: fix index.html from the brief');
    expect(ctx.readOnlyPhases!.restorations().map((restoration) => restoration.phase)).toEqual(['read-only inspect index.html and list what is missing']);
    expect(validations.some((text) => text.includes(READ_ONLY_RESTORED_PREFIX) && text.includes('read-only inspect'))).toBe(true);
    // The molecule is credited for the fix, not for the inspection the runtime had to put back.
    expect(planned.reg.getByName(planned.l1Type.name)!.successes).toBe(1);

    // The same plan below a tissue runs inside the tissue's phase: a fork.
    const nested = registryWithTiers();
    const nestedRoot = workspace({ 'index.html': 'page' });
    const nestedLlm = roleLlm({ l2: nested.l2Type.name, l1: nested.l1Type.name, l2Prefilter: 'escalate', l2Plan: inspectThenFix(nested.l1Type.name) });
    const nestedCtx = runCtx(nestedRoot, nestedLlm.llm);
    await rootCell(nested.reg, nested.l2Type, { description: 'a phase of the tissue' }, forkBranch(nestedCtx, 'phase-1'));
    expect(read(nestedRoot, 'index.html')).toBe('written by: read-only inspect index.html and list what is missing');
    expect(nestedCtx.readOnlyPhases!.restorations()).toEqual([]);

    // A short run's usual shape: the root cell hands the whole goal to one
    // molecule. That dispatch writes, as it always has.
    const single = registryWithTiers();
    const singleRoot = workspace({ 'index.html': 'page' });
    const reused = roleLlm({ l2: single.l2Type.name, l1: single.l1Type.name, l2Prefilter: 'reuse' });
    const singleCtx = runCtx(singleRoot, reused.llm);
    await rootCell(single.reg, single.l2Type, { description: 'extend the page' }, singleCtx);
    expect(read(singleRoot, 'index.html')).toBe('written by: extend the page');
    expect(singleCtx.readOnlyPhases!.restorations()).toEqual([]);
  });
});

class Scripted extends Atom {
  readonly tier = 2 as const;
  readonly model = 'test';
  constructor(private readonly onExecute: () => Promise<Result>, private readonly judge: (result: Result) => Verdict) {
    super({ name: 'scripted', ordinal: 1, systemPrompt: '', tools: makeTools(['write_file']), params: {} });
  }
  async plan(): Promise<Plan> { return makePlan(); }
  async execute(): Promise<Result> { return this.onExecute(); }
  async validatePlan(): Promise<Verdict> { return { approved: true, reasoning: 'ok' }; }
  async validateResult(_child: Atom, result: Result): Promise<Verdict> { return this.judge(result); }
}

const done = (summary: string): Result => ({ output: summary, summary, trace: [], producedBy: { tier: 1, name: 'leaf', viaFallback: false } });

describe('where a read-only phase is guarded', () => {
  it("surrounds the child's executions and the parent's fallback, and every validation reads the result it returns", async () => {
    const root = workspace({ 'index.html': 'page' });
    const ctx: RunContext = { ...makeCtx(), readOnlyPhases: readOnlyPhasesFor(root, () => undefined) };
    const task: Task = { description: 'verify the page', readOnly: true };
    const judged: string[] = [];
    const child = new Scripted(async () => {
      writeFileSync(join(root, 'index.html'), 'child rewrite');
      return done('child verified');
    }, () => ({ approved: true, reasoning: 'ok' }));
    // Every result is refused, with a new reason each time, until the loop
    // runs out of executions and the parent falls back.
    const parent = new Scripted(async () => {
      writeFileSync(join(root, 'index.html'), 'fallback rewrite');
      return done('fallback verified');
    }, (result) => {
      judged.push(result.summary);
      return { approved: false, reasoning: `rejected ${judged.length}`, scope: 'ephemeral', modifications: {} };
    });
    const result = await superviseLoop(parent as never, child, task, ctx, {
      applyByScope: async (current) => current,
      branchOnEscalation: async () => undefined,
      aroundExecute: (execute) => withinReadOnlyPhase(ctx, task, execute),
    });
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every((summary) => summary.startsWith(READ_ONLY_RESTORED_PREFIX))).toBe(true);
    expect(result.summary.startsWith(READ_ONLY_RESTORED_PREFIX)).toBe(true);
    expect(result.readOnlyRestoration?.summary).toBe('fallback verified');
    expect(read(root, 'index.html')).toBe('page');
  });

  it('restores on a throw and passes the error on, and runs untouched without the capability or the mark', async () => {
    const root = workspace({ 'index.html': 'page' });
    const ctx: RunContext = { ...makeCtx(), readOnlyPhases: readOnlyPhasesFor(root, () => undefined) };
    const failure = new Error('provider down');
    await expect(withinReadOnlyPhase(ctx, { description: 'verify', readOnly: true }, async () => {
      writeFileSync(join(root, 'index.html'), 'half written');
      throw failure;
    })).rejects.toBe(failure);
    expect(read(root, 'index.html')).toBe('page');

    await withinReadOnlyPhase(ctx, { description: 'build' }, async () => {
      writeFileSync(join(root, 'index.html'), 'built');
      return done('built');
    });
    expect(read(root, 'index.html')).toBe('built');
    const bare = await withinReadOnlyPhase(makeCtx(), { description: 'verify', readOnly: true }, async () => done('as is'));
    expect(bare.summary).toBe('as is');
    expect(await withinReadOnlyPhase(ctx, { description: 'verify', readOnly: true }, async () => null)).toBeNull();
  });

  it('stops the Node servers an execution started whenever the disk was put back, and only then (second review)', async () => {
    for (const shape of ['damage', 'side effect', 'nothing'] as const) {
      const root = workspace({ 'server.js': 'broken', 'data.json': '[]' });
      const shells: unknown[] = [];
      const base: ToolExecutor = {
        has: (name) => ['write_file', 'start_node_server', 'run_shell'].includes(name),
        async execute(name, args) {
          if (name === 'write_file') {
            writeFileSync(join(root, String(args['path'])), String(args['content']));
            return { ok: true };
          }
          if (name === 'run_shell') {
            shells.push(args);
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          return { ok: true, url: 'http://localhost:40123/', port: 40123, entry: 'server.js', pid: 4242, servedFrom: root };
        },
      };
      const attestations = createAttestationLog();
      const ctx: RunContext = { ...makeCtx(), attempt: 1, attestations, readOnlyPhases: readOnlyPhasesFor(root, () => undefined),
        tools: attestingExecutor(base, attestations, 'phase-2', undefined, 1) };
      await withinReadOnlyPhase(ctx, { description: 'verify the notes API', readOnly: true }, async () => {
        if (shape === 'damage') await ctx.tools!.execute('write_file', { path: 'server.js', content: 'fixed' });
        if (shape === 'side effect') writeFileSync(join(root, 'data.json'), '[{"id":1}]');
        await ctx.tools!.execute('start_node_server', { entry: 'server.js' });
        return done('verified');
      });
      expect(read(root, 'server.js')).toBe('broken');
      expect(read(root, 'data.json')).toBe('[]');
      expect(shells).toEqual(shape === 'nothing' ? [] : [expect.objectContaining({ command: 'node', args: expect.arrayContaining(['4242']) })]);
      const [restoration] = ctx.readOnlyPhases!.restorations();
      expect(restorationDamaged(restoration!)).toBe(shape === 'damage');
    }
  });

  it('reads a banner beneath the restoration only while the restoration line still leads the summary', async () => {
    const restoredResult: Result = {
      ...done('[READ-ONLY PHASE RESTORED — … and a fix it reports was undone.] [INTERNAL VALIDATION FAILED — x] y'),
      readOnlyRestoration: { restoration: { phase: 'verify', attempt: 1, paths: [], left: [], partial: true, observations: [], written: [] },
        summary: '[INTERNAL VALIDATION FAILED — x] y' },
    };
    const landed = markLanded(restoredResult, [{ description: 'document the page' }]);
    const ctx = makeCtx();
    const gates = await runResultGates(buildResultGateEnv({ task: { description: 'build and verify' }, result: landed, childName: 'leaf',
      childToolNames: ['write_file', 'validate_html'], ctx }), new Set());
    expect(landed.summary.startsWith('INCOMPLETE')).toBe(true);
    expect(gates.rejection).toBeNull();
  });

  it('reads the banners beneath the restoration, and treats a read-only failure as a finding, never a fault to fix (adversarial review 2026-09-30)', async () => {
    const root = workspace({ 'data.json': '[]' });
    const ctx: RunContext = { ...makeCtx(), readOnlyPhases: readOnlyPhasesFor(root, () => undefined) };
    const banner = '[INTERNAL VALIDATION FAILED — smoke ok:false] the select offers 25/45/60 where the brief says 15/25/45';
    const readOnly: Task = { description: 'verify the page in a real browser', readOnly: true };
    const restored = await withinReadOnlyPhase(ctx, readOnly, async () => {
      writeFileSync(join(root, 'data.json'), '[{"id":1}]');
      return done(banner);
    });
    expect(restored.summary.startsWith(READ_ONLY_RESTORED_PREFIX)).toBe(true);
    const gate = (task: Task, result: Result) => runResultGates(buildResultGateEnv({ task, result, childName: 'leaf',
      childToolNames: ['write_file', 'validate_html'], ctx }), (ctx.mechanicalResultRejections ??= new Set()));
    for (let i = 0; i < 3; i += 1) {
      const verdict = await gate(readOnly, restored);
      expect(verdict.rejection).toBeNull();
      expect(verdict.reviewFindings.map((finding) => finding.gateId)).toContain('read-only-validation-failed');
    }
    // The same banner on work that may change files is still refused.
    const writable = await gate({ description: 'fix the page' }, done(banner));
    expect(writable.rejection?.gateId).toBe('internal-validation-failed');
  });

  it("counts none of a restored execution's observations at root acceptance (adversarial review 2026-09-30)", async () => {
    const root = workspace({ 'index.html': '<body style="width:900px">overflows at 375</body>' });
    const sha = (path: string) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    const base: ToolExecutor = {
      has: (name) => ['write_file', 'read_file', 'validate_html'].includes(name),
      async execute(name, args) {
        if (name === 'write_file') {
          writeFileSync(join(root, String(args['path'])), String(args['content']));
          return { ok: true };
        }
        if (name === 'read_file') return { content: read(root, String(args['path'])) };
        return { ok: true, url: 'http://127.0.0.1:1/', errors: [], failedRequests: [], smokeResult: { ok: true },
          interactionLog: ['click #start'], document: { path: 'index.html', sha256: sha('index.html') }, viewport: { width: 375, height: 667 } };
      },
    };
    const attestations = createAttestationLog();
    const phases = readOnlyPhasesFor(root, () => undefined);
    const mock = makeCtx();
    const ctx: RunContext = { ...mock, attempt: 1, attestations, readOnlyPhases: phases,
      tools: attestingExecutor(base, attestations, 'phase-2', undefined, 1) };
    await withinReadOnlyPhase(ctx, { description: 'verify the page at 375 px', readOnly: true }, async () => {
      await ctx.tools!.execute('write_file', { path: 'index.html', content: '<body style="max-width:100%">fixed</body>' });
      await ctx.tools!.execute('validate_html', { path: 'index.html', viewport: { width: 375, height: 667 } });
      return done('fixed the overflow, verified at 375 px');
    });
    expect(read(root, 'index.html')).toContain('overflows at 375');
    expect(attestations.forAttempt(1).some((record) => record.observation.kind === 'browser')).toBe(true);
    // Unfiltered, the layout is there; root acceptance filters it out below.
    expect(observedLayoutsBlock(ctx)).toContain('index.html at 375x667');

    mock.llm.enqueueText(jsonText({ approved: false, reasoning: 'the page overflows at 375 px', criteria: [{ id: 'c1', met: false }] }));
    const actor = new Scripted(async () => done('x'), () => ({ approved: true, reasoning: 'ok' }));
    const info = await acceptRootResult({ actor, task: { description: 'fix the overflow at 375 px' },
      result: done('2 sequential phases — final: fixed'), ctx: { ...ctx, tools: base }, floor: [], phaseCoverage: [],
      checklist: [{ id: 'c1', behaviour: 'no horizontal overflow at 375 px wide', check: { kind: 'review' } }],
      checklistOrigin: { source: 'user', digest: 'a'.repeat(64) } });
    expect(info.checklist?.[0]?.layouts).toEqual([{ width: 375, status: 'not-laid-out', observationRefs: [] }]);
    const prompt = mock.llm.calls.at(-1)!.userContent;
    expect(prompt).not.toContain('index.html at 375x667');
    expect(prompt).toContain('READ-ONLY PHASES');
    expect(prompt).toContain('- phase "verify the page at 375 px": index.html (changed');
  });

  it('reaches every fork, so a phase of any lane records into the one list the acceptor reads', () => {
    const phases = readOnlyPhasesFor(workspace(), () => undefined);
    const root: RunContext = { ...makeCtx(), readOnlyPhases: phases };
    expect(forkBranch(forkBranch(root, 'phase-1'), 'subtask-1').readOnlyPhases).toBe(phases);
    expect(forkBranch(makeCtx(), 'phase-1').readOnlyPhases).toBeUndefined();
  });

  it('tells every validator what the runtime writes, and marks the task of a read-only phase', async () => {
    expect(VALIDATION_SYSTEM_PROMPT).toContain(`"${READ_ONLY_RESTORED_PREFIX} …"`);
    expect(VALIDATION_SYSTEM_PROMPT).toContain('"Task mode: READ-ONLY PHASE"');
    expect(READ_ONLY_TASK_LINE.startsWith('Task mode: READ-ONLY PHASE')).toBe(true);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    const child = new Scripted(async () => done('x'), () => ({ approved: true, reasoning: 'ok' }));
    const ask = (task: Task) => llmVerdict({ ctx, model: 'test', supervisorName: 'cell', supervisorTier: 2, subject: 'RESULT',
      child, task, payload: { output: null, summary: 'verified' } });
    await ask({ description: 'verify the page', readOnly: true });
    await ask({ description: 'build the page' });
    expect(ctx.llm.calls[0]!.userContent).toContain(READ_ONLY_TASK_LINE);
    expect(ctx.llm.calls[1]!.userContent).not.toContain(READ_ONLY_TASK_LINE);
  });
});
