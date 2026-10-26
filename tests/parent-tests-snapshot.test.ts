import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { STALE_COPY_AGE_MS, runParentTests, snapshotProject, sweepStaleCopies } from '../src/tools/parentTests.js';
import { parentTestObservationSchema, type ParentTestSuite } from '../src/contracts/parentTests.js';

/**
 * The verification snapshot and the fixed harness, at the boundaries they
 * cross: the one worker process every lane shares, the copy, and the
 * coordinator process that must never run project code (review 2026-10-16,
 * group C-runner).
 */

const POSIX = process.platform !== 'win32';
const dirs: string[] = [];
const boxes: ToolSandbox[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
let privateTmp = '';
let savedTmp: string | undefined;

// Each test gets its own TMPDIR, so "nothing left behind" never counts a
// sibling test file's copies.
beforeEach(() => {
  savedTmp = process.env['TMPDIR'];
  privateTmp = mkdtempSync(path.join(tmpdir(), 'atoma-snapshot-tmp-'));
  dirs.push(privateTmp);
  process.env['TMPDIR'] = privateTmp;
});

afterEach(async () => {
  if (savedTmp === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmp;
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const server of servers.splice(0)) server.close();
  await Promise.all(boxes.splice(0).map(box => box.cleanup()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // The 100,001-directory fixture takes seconds to remove on a loaded machine.
}, 60_000);

function workspace(): { root: string; box: ToolSandbox } {
  const root = mkdtempSync(path.join(savedTmp ?? tmpdir(), 'atoma-snapshot-fixture-'));
  dirs.push(root);
  const box = new ToolSandbox(root);
  boxes.push(box);
  return { root, box };
}

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function manyFiles(root: string, count: number, bytes = 4096): void {
  const filler = 'x'.repeat(bytes);
  for (let index = 0; index < count; index++) {
    write(root, `node_modules/p${index % 40}/f${index}.js`, filler);
  }
}

function suite(source: string): ParentTestSuite {
  return { requirement: 'add returns the sum of its arguments', cwd: '.', source };
}

const ADD_SUITE = "import {test,expect} from 'vitest'; import {add} from './add.ts'; test('adds',()=>{expect(add(2,3)).toBe(5); expect(add(-2,1)).toBe(-1);});";

function verify(box: ToolSandbox, source: string, timeoutMs = 30_000): ReturnType<typeof runParentTests> {
  return runParentTests(box, [JSON.stringify(suite(source))], timeoutMs);
}

function acceptanceCopies(): string[] {
  return readdirSync(privateTmp).filter(name => name.startsWith('atoma-acceptance-'));
}

async function until(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

function copyStarted(): boolean {
  return acceptanceCopies().some(name => existsSync(path.join(privateTmp, name, 'project', 'node_modules')));
}

describe('the one worker process stays responsive while it copies', () => {
  it('answers a sibling read_file before the verification result, while the copy is still running', async () => {
    const { root } = workspace();
    write(root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
    manyFiles(root, 3000);
    const socketDir = mkdtempSync(path.join('/tmp', 'atoma-sock-'));
    dirs.push(socketDir);
    const socketPath = path.join(socketDir, 'w.sock');
    const server = createServer();
    servers.push(server);
    const connected = new Promise<Socket>(resolve => server.once('connection', resolve));
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const worker = fork(fileURLToPath(new URL('../src/tools/worker.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'],
      env: { PATH: process.env['PATH'], TMPDIR: privateTmp, ATOMA_WORKER_ROOT: root, ATOMA_WORKER_SOCKET: socketPath },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.push(worker);
    const socket = await connected;
    const replies: Array<{ id: number; ok: boolean; result?: unknown }> = [];
    let suiteWrittenWhenReadAnswered: boolean | undefined;
    let pending = '';
    let ready!: () => void;
    const isReady = new Promise<void>(resolve => { ready = resolve; });
    let finished!: () => void;
    const verified = new Promise<void>(resolve => { finished = resolve; });
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const message = JSON.parse(line) as { ready?: boolean; id?: number; ok?: boolean; result?: unknown };
        if (message.ready) ready();
        if (message.id === undefined) continue;
        if (message.id === 2) {
          // Checked synchronously: a copy that blocked the worker wrote the
          // suite in the same run as its end, before any read could answer.
          suiteWrittenWhenReadAnswered = acceptanceCopies().some(name =>
            existsSync(path.join(privateTmp, name, 'project', 'atoma.acceptance.test.ts')));
        }
        replies.push({ id: message.id, ok: message.ok ?? false, result: message.result });
        if (message.id === 1) finished();
      }
    });
    await isReady;
    const verifyRequest = { id: 1, name: 'run_shell', args: { command: 'atoma-verify', args: [JSON.stringify(suite(ADD_SUITE))], timeoutMs: 60_000 } };
    socket.write(`${JSON.stringify(verifyRequest)}\n`);
    await until(copyStarted);
    socket.write(`${JSON.stringify({ id: 2, name: 'read_file', args: { path: 'add.ts' } })}\n`);
    await verified;
    expect(replies.map(reply => reply.id)).toEqual([2, 1]);
    expect(suiteWrittenWhenReadAnswered).toBe(false);
    const observation = parentTestObservationSchema.parse(replies[1]!.result);
    expect(observation.status, observation.details).toBe('passed');
    expect(observation.snapshot?.files).toBeGreaterThanOrEqual(3000);
  }, 90_000);

  it('lets a timer and a sibling read run while snapshotProject copies', async () => {
    const root = realpathSync.native(workspace().root);
    write(root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
    manyFiles(root, 3000);
    const target = path.join(privateTmp, 'copy');
    const order: string[] = [];
    let siblingMs = Number.POSITIVE_INFINITY;
    setTimeout(() => order.push('timer'), 0);
    // Started once the copy is under way, so it competes with it for the pool.
    const sibling = until(() => existsSync(path.join(target, 'node_modules'))).then(async () => {
      const started = performance.now();
      await readFile(path.join(root, 'add.ts'));
      siblingMs = performance.now() - started;
      order.push('sibling read');
    });
    const receipt = await snapshotProject(root, target, new AbortController().signal);
    order.push('snapshot');
    await sibling;
    expect(order).toEqual(['timer', 'sibling read', 'snapshot']);
    expect(siblingMs).toBeLessThan(receipt.ms / 4);
    expect(receipt.files).toBe(3001);
  }, 60_000);
});

describe('containment and shape of the copy', () => {
  it('refuses a link that leaves through an excluded directory, without copying outside bytes', async () => {
    const { root, box } = workspace();
    const outside = workspace();
    write(outside.root, 'dir/secret', 'OUTSIDE');
    write(root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
    mkdirSync(path.join(root, '.git'));
    symlinkSync(path.join(outside.root, 'dir'), path.join(root, '.git', 'inner'));
    // The JS realpath read `.git/inner/..` as `.git`; the kernel walks out first.
    symlinkSync('.git/inner/..', path.join(root, 'up'));
    const observation = await verify(box, ADD_SUITE);
    expect(observation.cause).toBe('snapshot-link');
    expect(observation.details).toContain('"up"');
    expect(JSON.stringify(observation)).not.toContain('OUTSIDE');
    expect(acceptanceCopies()).toEqual([]);
  });

  it.skipIf(!POSIX)('skips a FIFO, directly or behind an internal link, as the publication inventory omits it, and returns instead of hanging', async () => {
    const direct = workspace();
    write(direct.root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
    execFileSync('mkfifo', [path.join(direct.root, 'pipe')]);
    const first = await verify(direct.box, ADD_SUITE);
    expect(first.status).toBe('passed');
    expect(first.details).toContain('skipped 1 unreachable');
    const behind = workspace();
    write(behind.root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
    mkdirSync(path.join(behind.root, 'sub'));
    execFileSync('mkfifo', [path.join(behind.root, 'sub', 'pipe')]);
    symlinkSync('sub/pipe', path.join(behind.root, 'link'));
    const second = await verify(behind.box, ADD_SUITE);
    expect(second.status).toBe('passed');
    expect(acceptanceCopies()).toEqual([]);
  }, 20_000);

  it.skipIf(!POSIX)('skips a link to a socket outside the project (Chromium\'s SingletonSocket, run 51c4e71d) and still refuses outside bytes', async () => {
    // The socket Chromium leaves under /tmp while a browser suite runs; the
    // link in the project's profile directory points at it.
    const socketDir = mkdtempSync(path.join('/tmp', 'atoma-chromium-'));
    const socketPath = path.join(socketDir, 'SingletonSocket');
    const server = createServer();
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      const { root, box } = workspace();
      write(root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
      mkdirSync(path.join(root, '.atoma-runtime', 'xe-browser-profile'), { recursive: true });
      symlinkSync(socketPath, path.join(root, '.atoma-runtime', 'xe-browser-profile', 'SingletonSocket'));
      symlinkSync(path.join(socketDir, 'gone'), path.join(root, '.atoma-runtime', 'xe-browser-profile', 'SingletonLock'));
      const observation = await verify(box, ADD_SUITE);
      expect(observation.status).toBe('passed');
      expect(observation.details).toContain('skipped 2 unreachable');
      // Bytes outside the project still refuse: a link to a file there is not byte-less.
      writeFileSync(path.join(socketDir, 'secret'), 'OUTSIDE');
      symlinkSync(path.join(socketDir, 'secret'), path.join(root, 'escape'));
      const refused = await verify(box, ADD_SUITE);
      expect(refused.cause).toBe('snapshot-link');
      expect(refused.details).toContain('"escape"');
      expect(acceptanceCopies()).toEqual([]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(socketDir, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!POSIX)('recreates internal links instead of following them: cycles, fan-out, pnpm, .bin and dead links', async () => {
    const { root, box } = workspace();
    write(root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
    write(root, 'vitest.config.ts', "throw new Error('project config must not execute');");
    // A directory link cycle and a 2^30 directory-link fan-out: one entry each, never walked.
    symlinkSync('.', path.join(root, 'cycle'));
    for (let level = 0; level < 30; level++) {
      mkdirSync(path.join(root, `d${level}`));
    }
    mkdirSync(path.join(root, 'd30'));
    for (let level = 0; level < 30; level++) {
      symlinkSync(`../d${level + 1}`, path.join(root, `d${level}`, 'a'));
      symlinkSync(`../d${level + 1}`, path.join(root, `d${level}`, 'b'));
    }
    // A pnpm layout: `foo` reaches its sibling `bar` only through the store's links.
    write(root, 'node_modules/.pnpm/bar@1/node_modules/bar/package.json', '{"name":"bar","main":"index.js"}');
    write(root, 'node_modules/.pnpm/bar@1/node_modules/bar/index.js', 'module.exports = { value: 1 };');
    write(root, 'node_modules/.pnpm/foo@1/node_modules/foo/package.json', '{"name":"foo","main":"index.js"}');
    write(root, 'node_modules/.pnpm/foo@1/node_modules/foo/index.js', "module.exports = { value: require('bar').value + 1 };");
    symlinkSync('../../bar@1/node_modules/bar', path.join(root, 'node_modules/.pnpm/foo@1/node_modules/bar'));
    symlinkSync('.pnpm/foo@1/node_modules/foo', path.join(root, 'node_modules/foo'));
    write(root, 'node_modules/tool/cli.js', '#!/usr/bin/env node\n');
    mkdirSync(path.join(root, 'node_modules/.bin'));
    symlinkSync('../tool/cli.js', path.join(root, 'node_modules/.bin/tool'));
    // No reachable content: skipped and counted, never a refusal.
    symlinkSync('missing-target', path.join(root, 'dangling'));
    symlinkSync('loop', path.join(root, 'loop'));
    const source = [
      "import {test,expect} from 'vitest';",
      "import {lstatSync,readlinkSync} from 'node:fs';",
      "import {createRequire} from 'node:module';",
      "import {add} from './add.ts';",
      "const require = createRequire(import.meta.url);",
      "test('layout',()=>{",
      '  expect(add(2,3)).toBe(5);',
      "  expect(require('foo').value).toBe(2);",
      "  expect(lstatSync('./node_modules/.bin/tool').isSymbolicLink()).toBe(true);",
      "  expect(readlinkSync('./node_modules/.bin/tool')).toBe('../tool/cli.js');",
      "  expect(lstatSync('./cycle').isSymbolicLink()).toBe(true);",
      '});',
    ].join('\n');
    const started = Date.now();
    const observation = await verify(box, source);
    expect(observation.status, observation.details).toBe('passed');
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(observation.snapshot?.skipped).toBe(2);
    expect(observation.snapshot?.links).toBe(64);
    expect(observation.details).toContain('Host: the snapshot skipped 2 unreachable entries');
    // Only what happened: no empty "copied 0 files that kept changing: " (run 760fef4c).
    expect(observation.details).not.toContain('kept changing');
    expect(acceptanceCopies()).toEqual([]);
  }, 40_000);

  it('bounds entries when they are listed and depth when it is entered', async () => {
    const wide = workspace();
    for (let index = 0; index <= 100_000; index++) {
      mkdirSync(path.join(wide.root, String(index)));
    }
    const tooWide = await verify(wide.box, ADD_SUITE);
    expect(tooWide.cause).toBe('snapshot-bounds');
    expect(tooWide.details).toBe('Verification snapshot exceeds 100000 entries, depth 128 or 512 MiB');
    const deep = workspace();
    mkdirSync(path.join(deep.root, ...Array.from({ length: 129 }, () => 'd')), { recursive: true });
    const tooDeep = await verify(deep.box, ADD_SUITE);
    expect(tooDeep.cause).toBe('snapshot-bounds');
    expect(acceptanceCopies()).toEqual([]);
  }, 120_000);
});

describe('one deadline and cleanup on every path', () => {
  it('reports a copy that outlives the window as snapshot-timeout and leaves no copy', async () => {
    const { root, box } = workspace();
    write(root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
    manyFiles(root, 2000);
    const observation = await verify(box, ADD_SUITE, 1);
    expect(observation.status).toBe('unavailable');
    expect(observation.cause).toBe('snapshot-timeout');
    expect(observation.details).toMatch(/^Verification timed out while copying the project snapshot \(\d+ entries in \d+ ms\)$/);
    expect(acceptanceCopies()).toEqual([]);
  });

  it.skipIf(!POSIX)('removes a copy of a read-only source directory', async () => {
    const { root, box } = workspace();
    write(root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
    write(root, 'frozen/data.txt', 'kept');
    chmodSync(path.join(root, 'frozen'), 0o555);
    try {
      const observation = await verify(box, ADD_SUITE);
      expect(observation.status, observation.details).toBe('passed');
      expect(acceptanceCopies()).toEqual([]);
    } finally {
      chmodSync(path.join(root, 'frozen'), 0o755);
    }
  });

  it('stops a copy the sandbox cleanup interrupts, spawns nothing and keeps no hook', async () => {
    const { root, box } = workspace();
    write(root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
    const baseline = box.cleanupHookCount();
    const finished = await verify(box, ADD_SUITE);
    expect(finished.status, finished.details).toBe('passed');
    expect(box.cleanupHookCount()).toBe(baseline);
    manyFiles(root, 3000);
    const running = verify(box, ADD_SUITE);
    await until(copyStarted);
    await box.cleanup();
    const stopped = await running;
    expect(stopped.status).toBe('unavailable');
    expect(stopped.cause).toBe('runner-error');
    expect(stopped.details).toBe('Verification stopped: the sandbox is shutting down');
    expect(box.trackedChildPids()).toEqual([]);
    expect(acceptanceCopies()).toEqual([]);
  }, 60_000);
});

describe('no project code runs in the coordinator', () => {
  const WRONG_ADD = 'export const add=(_a:number,_b:number)=>5;';
  // Run in the coordinator, it replaces the report and the exit code at exit.
  const FORGE = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('exit', () => {",
    "  writeFileSync(process.cwd() + '/atoma.report.json', JSON.stringify({ success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTests: 1, testResults: [{ assertionResults: [{ fullName: 'adds', status: 'passed', failureMessages: [] }] }] }));",
    '  process.exitCode = 0;',
    '});',
  ].join('\n');

  it('ignores a forging postcss.config.cjs', async () => {
    const { root, box } = workspace();
    write(root, 'add.ts', WRONG_ADD);
    write(root, 'postcss.config.cjs', `${FORGE}\nmodule.exports = { plugins: [] };`);
    const observation = await verify(box, ADD_SUITE);
    expect(observation.status, observation.details).toBe('failed');
  });

  it('ignores a forging package.json#postcss plugin', async () => {
    const { root, box } = workspace();
    write(root, 'add.ts', WRONG_ADD);
    write(root, 'package.json', JSON.stringify({ type: 'module', postcss: { plugins: { 'forge-plugin': {} } } }));
    write(root, 'node_modules/forge-plugin/package.json', '{"name":"forge-plugin","main":"index.js"}');
    write(root, 'node_modules/forge-plugin/index.js', `${FORGE}\nmodule.exports = () => ({ postcssPlugin: 'forge' });\nmodule.exports.postcss = true;`);
    const observation = await verify(box, ADD_SUITE);
    expect(observation.status, observation.details).toBe('failed');
  });

  it('never loads the project preprocessor for a CSS module import', async () => {
    const { root, box } = workspace();
    write(root, 'add.ts', `import styles from './styles.module.scss';\nexport const name = styles.button;\n${WRONG_ADD}`);
    write(root, 'styles.module.scss', '.button { color: red; }');
    for (const name of ['sass-embedded', 'sass']) {
      write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, main: 'index.js' }));
      write(root, `node_modules/${name}/index.js`, `${FORGE}\nmodule.exports = {};`);
    }
    const observation = await verify(box, ADD_SUITE);
    expect(observation.status, observation.details).toBe('failed');
  });

  // Second review 2026-10-16: the stub read the SPECIFIER's extension, so a
  // stylesheet reached through a name without one went to `vite:css`, which
  // loaded the project's forging preprocessor and turned a wrong `add` green.
  const forgingPreprocessors = (root: string): void => {
    for (const name of ['sass-embedded', 'sass']) {
      write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, main: 'index.js' }));
      write(root, `node_modules/${name}/index.js`, `${FORGE}\nmodule.exports = {};`);
    }
  };

  it('never loads the project preprocessor for a tsconfig paths alias naming a stylesheet', async () => {
    const { root, box } = workspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@theme': ['./t.scss'] } } }));
    write(root, 't.scss', '$c: red; body { color: $c; }');
    write(root, 'add.ts', `import '@theme';\n${WRONG_ADD}`);
    forgingPreprocessors(root);
    const observation = await verify(box, ADD_SUITE);
    expect(observation.status, observation.details).toBe('failed');
  });

  it.each([
    ['main', { main: 't.scss' }, 't.scss'],
    ['exports', { exports: { '.': './styles/t.scss' } }, 'styles/t.scss'],
  ])('never loads the project preprocessor for a package whose %s is a stylesheet', async (_kind, entry, file) => {
    const { root, box } = workspace();
    write(root, 'node_modules/theme/package.json', JSON.stringify({ name: 'theme', ...entry }));
    write(root, `node_modules/theme/${file}`, 'body { color: red; }');
    write(root, 'add.ts', `import 'theme';\n${WRONG_ADD}`);
    forgingPreprocessors(root);
    const observation = await verify(box, ADD_SUITE);
    expect(observation.status, observation.details).toBe('failed');
  });
});

describe('tsconfig paths and stylesheets', () => {
  it('resolves JSONC tsconfig aliases in application code, stubs stylesheets and still ignores project config', async () => {
    const { root, box } = workspace();
    write(root, 'tsconfig.base.json', [
      '{',
      '  // comments and trailing commas are tsconfig, not JSON',
      '  "compilerOptions": {',
      '    "baseUrl": ".",',
      '    "paths": { "@/*": ["src/*"], "#config": ["src/config.ts"], },',
      '  },',
      '}',
    ].join('\n'));
    write(root, 'tsconfig.json', '{ "extends": "./tsconfig.base.json", /* inside the project */ }');
    write(root, 'vitest.config.ts', "throw new Error('project config must not execute');");
    write(root, 'src/lib/add.ts', 'export const add=(a:number,b:number)=>a+b;');
    write(root, 'src/config.ts', 'export const offset = 0;');
    write(root, 'src/button.module.css', '.btn { color: red; }');
    write(root, 'src/global.css', 'body { margin: 0; }');
    write(root, 'src/use.ts', [
      "import { add as raw } from '@/lib/add';",
      "import { offset } from '#config';",
      "import styles from './button.module.css';",
      "import './global.css';",
      'export const add = (a: number, b: number) => raw(a, b) + offset;',
      'export const buttonClass = styles.btn;',
    ].join('\n'));
    const source = "import {test,expect} from 'vitest'; import {add,buttonClass} from './src/use.ts'; test('adds',()=>{expect(add(2,3)).toBe(5); expect(buttonClass).toBe('btn');});";
    const observation = await verify(box, source);
    expect(observation.status, observation.details).toBe('passed');
  });

  it('resolves an alias the suite imports itself, as the application code would', async () => {
    const scoped = workspace();
    write(scoped.root, 'tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["./src/*"]}},"include":["src"]}');
    write(scoped.root, 'src/x.ts', 'export const add=(a:number,b:number)=>a+b;');
    write(scoped.root, 'src/use.ts', "export { add } from '@/x';");
    const application = await verify(scoped.box, "import {test,expect} from 'vitest'; import {add} from './src/use.ts'; test('adds',()=>{expect(add(2,3)).toBe(5);});");
    expect(application.status, application.details).toBe('passed');
    // Until G2 this stayed red: "the suite module did not load".
    const suiteAlias = await verify(scoped.box, "import {test,expect} from 'vitest'; import {add} from '@/x'; test('adds',()=>{expect(add(2,3)).toBe(5);});");
    expect(suiteAlias.status, suiteAlias.details).toBe('passed');
  }, 45_000);

  it('resolves a solution-style alias and says which tsconfig decided', async () => {
    const solution = workspace();
    write(solution.root, 'tsconfig.json', '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}');
    write(solution.root, 'tsconfig.app.json', '{"compilerOptions":{"paths":{"@/*":["./src/*"]}},"include":["src"]}');
    write(solution.root, 'src/x.ts', 'export const add=(a:number,b:number)=>a+b;');
    const observation = await verify(solution.box, "import {test,expect} from 'vitest'; import {add} from '@/x'; test('adds',()=>{expect(add(2,3)).toBe(5);});");
    expect(observation.status, observation.details).toBe('passed');
    expect(JSON.parse(observation.details)).toContain("Host: suite alias '@/x' resolved via tsconfig.app.json");
  }, 45_000);

  it('resolves a nested package alias through the module the suite imports', async () => {
    const { root, box } = workspace();
    write(root, 'packages/app/tsconfig.json', '{"compilerOptions":{"paths":{"@app/*":["./src/*"]}},"include":["src"]}');
    write(root, 'packages/app/src/x.ts', 'export const add=(a:number,b:number)=>a+b;');
    write(root, 'packages/app/src/use.ts', "export { add } from '@app/x';");
    const source = [
      "import {test,expect} from 'vitest';",
      "import {add as viaUse} from './packages/app/src/use.ts';",
      "import {add} from '@app/x';",
      "test('adds',()=>{",
      '  expect(add(2,3)).toBe(5);',
      '  expect(viaUse).toBe(add);',
      '});',
    ].join('\n');
    const observation = await verify(box, source);
    expect(observation.status, observation.details).toBe('passed');
  }, 45_000);

  it('lets a paths alias to project source beat a package of the same name, for the suite as for the subject', async () => {
    const { root, box } = workspace();
    write(root, 'tsconfig.json', '{"compilerOptions":{"paths":{"lib":["./src/lib.ts"]}},"include":["src"]}');
    write(root, 'src/lib.ts', "export const source = 'project';");
    write(root, 'src/use.ts', "export { source } from 'lib';");
    write(root, 'node_modules/lib/package.json', '{"name":"lib","main":"index.js"}');
    write(root, 'node_modules/lib/index.js', "exports.source = 'package';");
    const source = [
      "import {test,expect} from 'vitest';",
      "import {source as viaUse} from './src/use.ts';",
      "import {source} from 'lib';",
      "test('agree',()=>{",
      "  expect(viaUse).toBe('project');",
      "  expect(source).toBe('project');",
      '});',
    ].join('\n');
    const observation = await verify(box, source);
    expect(observation.status, observation.details).toBe('passed');
  }, 45_000);

  it('never loads the project preprocessor for a stylesheet alias the suite imports', async () => {
    const { root, box } = workspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@theme': ['./t.scss'] } }, include: ['src'] }));
    write(root, 't.scss', '$c: red; body { color: $c; }');
    write(root, 'add.ts', 'export const add=(_a:number,_b:number)=>5;');
    for (const name of ['sass-embedded', 'sass']) {
      write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, main: 'index.js' }));
      write(root, `node_modules/${name}/index.js`, [
        "const { writeFileSync } = require('node:fs');",
        "process.on('exit', () => {",
        "  writeFileSync(process.cwd() + '/atoma.report.json', JSON.stringify({ success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTests: 1, testResults: [{ assertionResults: [{ fullName: 'adds', status: 'passed', failureMessages: [] }] }] }));",
        '  process.exitCode = 0;',
        '});',
        'module.exports = {};',
      ].join('\n'));
    }
    const observation = await verify(box, "import {test,expect} from 'vitest'; import '@theme'; import {add} from './add.ts'; test('adds',()=>{expect(add(-2,1)).toBe(-1);});");
    expect(observation.status, observation.details).toBe('failed');
  }, 45_000);

  it('never passes on a suite alias that leaves the project, and shows none of its bytes', async () => {
    const { root, box } = workspace();
    const outside = workspace();
    write(outside.root, 'secret.ts', "export const secret = 'OUTSIDE_BYTES';");
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@out/*': [`${outside.root}/*`] } }, include: ['src'] }));
    const observation = await verify(box, "import {test,expect} from 'vitest'; import {secret} from '@out/secret'; test('reads',()=>{expect(secret).toBe('OUTSIDE_BYTES');});");
    expect(observation.status).not.toBe('passed');
    expect(JSON.stringify(observation)).not.toContain('export const secret');
  }, 45_000);

  it('never passes on an alias that leaves the project, and shows none of its bytes', async () => {
    const { root, box } = workspace();
    const outside = workspace();
    write(outside.root, 'secret.ts', "export const secret = 'OUTSIDE_BYTES';");
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@out/*': [`${outside.root}/*`], '@up/*': ['../outside/*'] } } }));
    write(root, 'src/use.ts', "export { secret } from '@out/secret';");
    const source = "import {test,expect} from 'vitest'; import {secret} from './src/use.ts'; test('reads',()=>{expect(secret).toBe('OUTSIDE_BYTES');});";
    const observation = await verify(box, source);
    expect(observation.status).not.toBe('passed');
    expect(JSON.stringify(observation)).not.toContain('export const secret');
  });

  it('never passes on a stylesheet that does not exist', async () => {
    const { root, box } = workspace();
    write(root, 'add.ts', "import './missing.css';\nexport const add=(a:number,b:number)=>a+b;");
    const observation = await verify(box, ADD_SUITE);
    expect(observation.status).not.toBe('passed');
  });
});

describe('snapshot isolation', () => {
  it.skipIf(!POSIX)('keeps writes through node_modules and its links inside the copy', async () => {
    const { root, box } = workspace();
    write(root, 'node_modules/pkg/index.js', 'module.exports = 1;');
    symlinkSync('pkg', path.join(root, 'node_modules/alias'));
    const source = [
      "import {test,expect} from 'vitest';",
      "import {writeFileSync,readFileSync} from 'node:fs';",
      "test('writes',()=>{",
      "  writeFileSync('./node_modules/pkg/index.js','changed');",
      "  writeFileSync('./node_modules/alias/extra.js','through the link');",
      "  expect(readFileSync('./node_modules/pkg/extra.js','utf8')).toBe('through the link');",
      '});',
    ].join('\n');
    const observation = await verify(box, source);
    expect(observation.status, observation.details).toBe('passed');
    expect(readFileSync(path.join(root, 'node_modules/pkg/index.js'), 'utf8')).toBe('module.exports = 1;');
    expect(existsSync(path.join(root, 'node_modules/pkg/extra.js'))).toBe(false);
  });

  it('copies through a concurrent appender and unlinker without becoming unavailable', async () => {
    const { root, box } = workspace();
    write(root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
    manyFiles(root, 2000);
    write(root, 'dev.log', '');
    for (let index = 0; index < 400; index++) {
      write(root, `churn/f${index}.txt`, 'x'.repeat(2048));
    }
    let next = 0;
    const appender = setInterval(() => appendFileSync(path.join(root, 'dev.log'), 'line\n'), 1);
    const unlinker = setInterval(() => {
      for (let step = 0; step < 4 && next < 400; step++) {
        unlinkSync(path.join(root, 'churn', `f${next}.txt`));
        next += 1;
      }
    }, 1);
    try {
      const observation = await verify(box, ADD_SUITE);
      expect(['passed', 'failed']).toContain(observation.status);
      expect(observation.details).not.toContain('ENOENT');
    } finally {
      clearInterval(appender);
      clearInterval(unlinker);
    }
  }, 60_000);
});

describe('copies a hard exit left behind', () => {
  const DEAD = 999_999;
  const ALIVE = 888_888;
  const hourAgo = (Date.now() - 60 * 60 * 1000) / 1000;

  function copy(name: string, aged = true): string {
    const directory = path.join(privateTmp, name);
    mkdirSync(path.join(directory, 'project'), { recursive: true });
    if (aged) utimesSync(directory, hourAgo, hourAgo);
    return directory;
  }

  it('removes only a dead owner\'s copy at least ten minutes old, of this runner\'s own name', async () => {
    const removable = copy(`atoma-acceptance-${DEAD}-a1B2c3`);
    const kept = [
      copy(`atoma-acceptance-${ALIVE}-a1B2c3`),
      copy(`atoma-acceptance-${DEAD}-fresh1`, false),
      copy(`atoma-acceptance-${process.pid}-a1B2c3`),
      copy('atoma-acceptance-a1B2c3'),
      copy('atoma-acceptance-image-a1B2c3'),
    ];
    const target = copy('link-target');
    writeFileSync(path.join(target, 'kept.txt'), 'kept');
    const link = path.join(privateTmp, `atoma-acceptance-${DEAD}-link12`);
    symlinkSync(target, link);
    lutimesSync(link, hourAgo, hourAgo);
    const file = path.join(privateTmp, `atoma-acceptance-${DEAD}-file12`);
    writeFileSync(file, 'a file, not a copy');
    utimesSync(file, hourAgo, hourAgo);

    const removed = await sweepStaleCopies(privateTmp, { alive: (pid) => pid === ALIVE });

    expect(removed).toBe(1);
    expect(existsSync(removable)).toBe(false);
    for (const directory of kept) expect(existsSync(directory), directory).toBe(true);
    expect(readFileSync(path.join(target, 'kept.txt'), 'utf8')).toBe('kept');
    expect(existsSync(link)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(STALE_COPY_AGE_MS).toBe(10 * 60 * 1000);
  });

  it('removes at most 32 copies per sweep', async () => {
    for (let index = 0; index < 40; index++) copy(`atoma-acceptance-${DEAD}-n${String(index).padStart(5, '0')}`);
    const removed = await sweepStaleCopies(privateTmp, { alive: () => false });
    expect(removed).toBe(32);
    expect(acceptanceCopies()).toHaveLength(8);
  });

  it.skipIf(!POSIX)('ends the orphaned coordinator and removes the copy on a later verification', async () => {
    const { root, box } = workspace();
    write(root, 'add.ts', 'export const add=(a:number,b:number)=>a+b;');
    const busy = [
      "import {test} from 'vitest';",
      "test('spins', () => {",
      '  const end = Date.now() + 60_000;',
      '  while (Date.now() < end) {',
      '    // the test thread is busy; the coordinator is not',
      '  }',
      '});',
    ].join('\n');
    const script = path.join(privateTmp, 'hard-exit-runner.mts');
    writeFileSync(script, [
      "const { ToolSandbox } = await import(process.env['SANDBOX_MODULE']!);",
      "const { runParentTests } = await import(process.env['RUNNER_MODULE']!);",
      "await runParentTests(new ToolSandbox(process.env['FIXTURE_ROOT']!), [process.env['SUITE']!], 90_000);",
    ].join('\n'));
    const runner = fork(script, [], {
      execArgv: ['--import', 'tsx'],
      env: {
        PATH: process.env['PATH'],
        TMPDIR: privateTmp,
        FIXTURE_ROOT: root,
        SUITE: JSON.stringify(suite(busy)),
        SANDBOX_MODULE: new URL('../src/tools/sandbox.ts', import.meta.url).href,
        RUNNER_MODULE: new URL('../src/tools/parentTests.ts', import.meta.url).href,
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.push(runner);
    const prefix = `atoma-acceptance-${runner.pid}-`;
    const coordinators = (): string[] => execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line.includes(prefix) && line.includes('parentTestWorker'));
    await until(() => coordinators().length > 0, 60_000);
    const copyName = acceptanceCopies().find(name => name.startsWith(prefix))!;
    expect(copyName).toMatch(/^atoma-acceptance-\d+-[A-Za-z0-9]{6}$/);

    runner.kill('SIGKILL');
    await new Promise(resolve => runner.once('exit', resolve));
    // The pipe's end, not the window: well under the 120 s window plus 5 s.
    await until(() => coordinators().length === 0, 20_000);
    expect(acceptanceCopies()).toContain(copyName);

    const aged = (Date.now() - STALE_COPY_AGE_MS - 60_000) / 1000;
    utimesSync(path.join(privateTmp, copyName), aged, aged);
    const later = await verify(box, ADD_SUITE);
    expect(later.status, later.details).toBe('passed');
    await until(() => !acceptanceCopies().includes(copyName), 20_000);
  }, 120_000);
});
