import { constants, cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { parentTestSuiteSchema, type ParentTestObservation } from '../contracts/parentTests.js';
import { ToolSandbox, sandboxChildEnv } from './sandbox.js';

const reportSchema = z.object({
  success: z.boolean(), numPassedTests: z.number(), numFailedTests: z.number(),
  numPendingTests: z.number(), numTodoTests: z.number().default(0), numTotalTests: z.number(),
  testResults: z.array(z.object({ message: z.string().optional(), assertionResults: z.array(z.object({
    fullName: z.string(), status: z.string(), failureMessages: z.array(z.string()),
  })) })),
});

/** A bounded, link-checked copy: verification cannot mutate the delivered workspace. */
function copyProject(root: string, target: string): string {
  const digest = createHash('sha256');
  let files = 0, bytes = 0;
  cpSync(root, target, { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE,
    filter: source => {
      const relative = path.relative(root, source);
      if (relative.split(path.sep).some(part => ['.git', '.atoma-scratch', '.atoma-skeleton'].includes(part))) return false;
      const real = realpathSync(source);
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error('Verification cannot copy links outside the project');
      const stat = lstatSync(real);
      if (stat.isFile()) {
        if (++files > 100_000 || (bytes += stat.size) > 512 * 1024 * 1024) throw new Error('Verification snapshot exceeds 100000 files or 512 MiB');
      } else if (!stat.isDirectory()) throw new Error('Verification snapshot contains a non-regular file');
      return true;
    },
  });
  // Bind the receipt to the bytes actually copied, never a pre-copy read.
  const hashCopy = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) hashCopy(file);
      else if (entry.isFile()) digest.update(path.relative(target, file)).update('\0').update(readFileSync(file)).update('\0');
      else throw new Error('Verification copy contains a non-regular file');
    }
  };
  hashCopy(target);
  return digest.digest('hex');
}

/** Fixed harness through run_shell; it never executes package scripts or project config. */
export async function runParentTests(sandbox: ToolSandbox, argv: readonly string[], timeoutMs: number): Promise<ParentTestObservation> {
  if (argv.length !== 1) throw new Error('atoma-verify requires one JSON suite');
  const suite = parentTestSuiteSchema.parse(JSON.parse(argv[0]!));
  const suiteDigest = createHash('sha256').update(JSON.stringify(suite)).digest('hex');
  const root = realpathSync(sandbox.resolve(suite.cwd));
  const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'atoma-acceptance-')));
  const project = path.join(temp, 'project');
  let observation: ParentTestObservation = { suiteDigest, workspaceDigest: '', status: 'unavailable', passed: 0, failed: 0, skipped: 0, details: '' };
  try {
    observation = { ...observation, workspaceDigest: copyProject(root, project) };
    // Stop Vite's workspace discovery at this disposable project.
    writeFileSync(path.join(project, 'pnpm-workspace.yaml'), 'packages: []\n');
    if (!existsSync(path.join(project, 'package.json'))) writeFileSync(path.join(project, 'package.json'), '{"type":"module"}');
    const source = path.join(project, 'atoma.acceptance.test.ts');
    const report = path.join(project, 'atoma.report.json');
    // The copy may carry old lookalike files. Their bytes are never authoritative.
    rmSync(source, { force: true }); rmSync(report, { force: true });
    writeFileSync(source, suite.source, { flag: 'wx' });
    const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './parentTestWorker.ts' : './parentTestWorker.js', import.meta.url));
    if (!existsSync(worker)) throw new Error('Compiled acceptance worker is unavailable; build the tool runtime first');
    const modules = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))));
    const outcome = await new Promise<{ code: number | null; details: string }>(resolve => {
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
      const timer = setTimeout(kill, timeoutMs);
      child.once('error', error => { clearTimeout(timer); kill(); resolve({ code: null, details: error.message }); });
      child.once('close', code => { clearTimeout(timer); kill(); resolve({ code, details: output }); });
    });
    if (!existsSync(report)) return { ...observation, details: `Runner produced no report: ${outcome.details}` };
    if (readFileSync(source, 'utf8') !== suite.source) return { ...observation, details: 'Acceptance source changed during verification' };
    if (lstatSync(report).size > 8 * 1024 * 1024) throw new Error('Verification report exceeds 8 MiB');
    const parsed = reportSchema.parse(JSON.parse(readFileSync(report, 'utf8')));
    const skipped = parsed.numPendingTests + parsed.numTodoTests;
    const passed = outcome.code === 0 && parsed.success && parsed.numTotalTests > 0 &&
      parsed.numPassedTests === parsed.numTotalTests && parsed.numFailedTests === 0 && skipped === 0;
    return { ...observation, status: passed ? 'passed' : 'failed', passed: parsed.numPassedTests,
      failed: parsed.numFailedTests, skipped,
      details: JSON.stringify(parsed.testResults.flatMap(module => [module.message ?? '',
        ...module.assertionResults.map(test => ({ name: test.fullName, status: test.status, failures: test.failureMessages })),
      ])).slice(0, 8000),
    };
  } catch (error) {
    return { ...observation, details: String(error).slice(0, 2000) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
