/**
 * Fresh application installs exercise the packaged worker-side generator.
 *
 * The three kinds run CONCURRENTLY, each in its own sandbox, read-run copy
 * and server port: one after the other they cost 86 s of the static CI job
 * (2026-10-24, ~28 s a kind on a 4-CPU runner that had nothing else to do),
 * and since the test half of CI became three shards that job is the longer
 * one. Every npm call below is therefore asynchronous — a `spawnSync` would
 * hold the event loop and serialise the kinds again.
 */
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { runShellTool } from '../dist/tools/builtin.js';
import { ToolSandbox } from '../dist/tools/sandbox.js';
import { buildWorkspaceArtifactManifest } from '../dist/projects/artifacts.js';
import { READ_RUNS_DIRECTORY, readRunCopyIntact, readRunCopyPath } from '../dist/contracts/readRuns.js';
import { checkReadRunCopies, materialiseReadRuns } from '../dist/run/readRuns.js';

const root = mkdtempSync(join(tmpdir(), 'atoma-application-smoke-'));
function npm(cwd, args) {
  return new Promise(resolve => {
    const child = spawn('npm', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.once('error', error => { clearTimeout(timeout); resolve({ status: null, error, stdout, stderr }); });
    child.once('exit', (status, signal) => { clearTimeout(timeout); resolve({ status, error: signal, stdout, stderr }); });
  });
}
async function run(cwd, args, passes = true) {
  const result = await npm(cwd, args);
  if (passes ? result.status !== 0 : result.status === 0 || result.status === null) {
    throw new Error(`npm ${args.join(' ')}: ${result.error ?? result.status}\n${result.stdout}\n${result.stderr}`);
  }
}
/**
 * An older run of the application as its saved manifest holds it: the
 * project's own files, configurations included, with a type error, floating
 * promises and a failing assertion; and the index the coordinator would hand
 * the run process for it.
 */
function brokenReadRun(cwd, dir) {
  cpSync(cwd, dir, { recursive: true, filter: source => basename(source) !== 'node_modules' });
  writeFileSync(join(dir, 'src/message.ts'), "export function greeting(name: string): string {\n  Promise.resolve(1);\n  const n: number = 'x';\n  return `Hello, ${name}${n}!`;\n}\n");
  writeFileSync(join(dir, 'src/old.ts'), 'export const broken: string = 42;\nPromise.resolve(1);\n');
  const test = join(dir, 'tests/message.test.ts');
  writeFileSync(test, readFileSync(test, 'utf8').replace("toBe('Hello, Ada!')", "toBe('Hello, an older run!')"));
  const { manifest, hash } = buildWorkspaceArtifactManifest({ workspaceRoot: dir });
  const runId = randomUUID();
  return { runId, index: { version: 1, orgId: randomUUID(), projectId: randomUUID(), runId: randomUUID(),
    readRuns: [{ runId, status: 'partial', endedAt: new Date().toISOString(), workspacePath: dir, manifestHash: hash, manifest }] } };
}
async function serve(cwd, browser) {
  const child = spawn(process.execPath, ['dist/server/server.js'], { cwd, env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server readiness timeout: ${stderr}`)), 10_000);
      let text = '';
      child.stdout.on('data', data => {
        text += data;
        const match = /LISTENING_ON_PORT=(\d+)/.exec(text);
        if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { message: 'Hello, world!' });
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
    if (browser) {
      const html = await (await fetch(base)).text();
      const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
      assert.ok(asset, 'built HTML references its bundled browser entry');
      const response = await fetch(new URL(asset, base));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
      assert.ok((await response.text()).length > 0);
    }
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
}
async function smoke(kind) {
  const sandbox = new ToolSandbox(join(root, kind));
  const result = await runShellTool({ sandbox }).execute({ command: 'atoma-scaffold', args: [kind] });
  assert.equal(result.exitCode, 0, result.stderr);
  const cwd = sandbox.root;
  await run(cwd, ['ci', '--include=dev', '--no-audit', '--no-fund']);
  await run(cwd, ['run', 'check']);
  // Copies of other runs' saved files sit under .atoma-runs/node_modules
  // (2026-10-17), which whole-tree tools skip: a broken one, placed by the
  // compiled host code, leaves check green with this skeleton's
  // configuration, with v1's (no `.atoma-*` lint ignore) and with Vitest's
  // default include, as an older or imported project has them.
  const { runId, index } = brokenReadRun(cwd, join(root, `${kind}-read-run`));
  const { identities } = materialiseReadRuns(cwd, index);
  await run(cwd, ['run', 'check']);
  const eslintConfig = readFileSync(join(cwd, 'eslint.config.js'), 'utf8');
  const vitestConfig = readFileSync(join(cwd, 'vitest.config.ts'), 'utf8');
  const v1 = eslintConfig.replace(", '.atoma-*/**'", '');
  assert.notEqual(v1, eslintConfig, 'the skeleton ignores .atoma-* in ESLint');
  writeFileSync(join(cwd, 'eslint.config.js'), v1);
  await run(cwd, ['run', 'check']);
  writeFileSync(join(cwd, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { environment: 'node' } });\n");
  await run(cwd, ['run', 'check']);
  // npm manages the root node_modules alone: a clean install leaves every copy as the host wrote it.
  await run(cwd, ['ci', '--include=dev', '--no-audit', '--no-fund']);
  assert.ok(readRunCopyIntact(checkReadRunCopies(cwd, index, identities)[0]), 'the checks and npm ci leave the copy intact');
  // The control: the same copy where copies sat before 2026-10-17 fails lint and tests, so the checks above prove something.
  renameSync(join(cwd, readRunCopyPath(runId)), join(cwd, READ_RUNS_DIRECTORY, runId));
  await run(cwd, ['run', 'lint'], false);
  await run(cwd, ['test'], false);
  rmSync(join(cwd, READ_RUNS_DIRECTORY), { recursive: true, force: true });
  writeFileSync(join(cwd, 'eslint.config.js'), eslintConfig);
  writeFileSync(join(cwd, 'vitest.config.ts'), vitestConfig);
  await run(cwd, ['run', 'build']);
  await serve(cwd, kind !== 'node');
  for (const file of ['src/message.ts', 'tests/message.test.ts']) {
    const path = join(cwd, file);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original + '\nexport const broken: string = 42;\n');
    await run(cwd, ['run', 'typecheck'], false);
    writeFileSync(path, original);
  }
  const path = join(cwd, 'tests/message.test.ts');
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, original + '\nPromise.resolve(1);\n');
  await run(cwd, ['run', 'lint'], false);
  writeFileSync(path, original.replace("toBe('Hello, Ada!')", "toBe('wrong')"));
  await run(cwd, ['test'], false);
  writeFileSync(path, original);
  console.log(`application skeleton ${kind}: install, check, a broken read-run copy left out under v2 and v1 lint and Vitest's default include, npm ci keeping it, build, built server, source/test type errors, floating promise and failing assertion verified`);
}
try {
  await Promise.all(['node', 'web', 'fullstack'].map(smoke));
} finally { rmSync(root, { recursive: true, force: true }); }
