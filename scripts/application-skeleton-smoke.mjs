/** Fresh application installs exercise the packaged worker-side generator. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { runShellTool } from '../dist/tools/builtin.js';
import { ToolSandbox } from '../dist/tools/sandbox.js';

const root = mkdtempSync(join(tmpdir(), 'atoma-application-smoke-'));
function run(cwd, args, passes = true) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', timeout: 120_000, env: process.env });
  if (passes ? result.status !== 0 : result.status === 0 || result.status === null) {
    throw new Error(`npm ${args.join(' ')}: ${result.error ?? result.status}\n${result.stdout}\n${result.stderr}`);
  }
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
try {
  for (const kind of ['node', 'web', 'fullstack']) {
    const sandbox = new ToolSandbox(join(root, kind));
    const result = await runShellTool({ sandbox }).execute({ command: 'atoma-scaffold', args: [kind] });
    assert.equal(result.exitCode, 0, result.stderr);
    const cwd = sandbox.root;
    run(cwd, ['ci', '--include=dev', '--no-audit', '--no-fund']);
    run(cwd, ['run', 'check']);
    // Read-only copies of other runs live under .atoma-runs (2026-10-17): the
    // whole-tree lint, the typecheck and the tests must leave a broken one out.
    const copy = join(cwd, '.atoma-runs', '00000000-0000-4000-8000-000000000000');
    mkdirSync(join(copy, 'src'), { recursive: true });
    mkdirSync(join(copy, 'tests'), { recursive: true });
    writeFileSync(join(copy, 'src/old.ts'), 'export const broken: string = 42;\nPromise.resolve(1);\n');
    writeFileSync(join(copy, 'tests/old.test.ts'), "import { expect, test } from 'vitest';\ntest('old', () => { expect(1).toBe(2); });\n");
    run(cwd, ['run', 'check']);
    rmSync(join(cwd, '.atoma-runs'), { recursive: true, force: true });
    run(cwd, ['run', 'build']);
    await serve(cwd, kind !== 'node');
    for (const file of ['src/message.ts', 'tests/message.test.ts']) {
      const path = join(cwd, file);
      const original = readFileSync(path, 'utf8');
      writeFileSync(path, original + '\nexport const broken: string = 42;\n');
      run(cwd, ['run', 'typecheck'], false);
      writeFileSync(path, original);
    }
    const path = join(cwd, 'tests/message.test.ts');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original + '\nPromise.resolve(1);\n');
    run(cwd, ['run', 'lint'], false);
    writeFileSync(path, original.replace("toBe('Hello, Ada!')", "toBe('wrong')"));
    run(cwd, ['test'], false);
    writeFileSync(path, original);
    console.log(`application skeleton ${kind}: install, check, a broken .atoma-runs copy left out, build, built server, source/test type errors, floating promise and failing assertion verified`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
