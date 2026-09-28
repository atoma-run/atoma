import Database from 'better-sqlite3';
import { runCommand } from '../src/supervisor/session.js';
import { writeCodexStub } from './supervisorCodexFixture.js';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformEventKind } from '../src/contracts/platformEvents.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { PlatformEventLog } from '../src/platform/events.js';
import { EXAMPLE_MEND_REQUEST } from '../src/contracts/supervisorMend.js';
import { acquireRunLeaseWithoutRecovery, peekRunLease } from '../src/mcp/runLock.js';
import {
  mendFinding,
  mendInputFromRequest,
  mendRecordPath,
  pendingMends,
  CANDIDATES_MENDABLE_SINCE,
  processMends,
  runMenderLoop,
  type MendRecord,
  type MenderOptions,
} from '../src/supervisor/mender.js';

/**
 * THE MENDER, ACROSS EVERY BOUNDARY IT SHIPS WITH (supervisor stage 3): a
 * real git repository with a real bare remote, a real worktree, real
 * stash/commit/push, a real SQLite journal — and stubs in place of the three
 * external programs (claude, gh, npm), substituted through the command seams
 * so no shell shim is needed on any platform.
 *
 * What these hold:
 *   - the happy path ends in a pushed branch, a PR request, a record and a
 *     `mender.pr_opened` row, with the worktree gone and the model's argv
 *     restricted as designed;
 *   - the harness refuses what the model may not ship — a forbidden path, a
 *     test that already passes on the unfixed code, a red check — and then
 *     nothing reaches the remote, and the journal says `mender.refused`;
 *   - a decline, a duplicate and an active run all stop before any quota or
 *     any push is spent, and only the decline is a row.
 */

const RUN_ID = '2026-09-05T10-00-00-000-deadbeef';
const TIMEOUT_MS = 90_000;

const dirs: string[] = [];
afterEach(() => {
  closeStoreHandles();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

interface Fixture {
  root: string;
  bare: string;
  repo: string;
  supervisor: string;
  runs: string;
  stubs: string;
  ghLog: string;
  claudeArgs: string;
  journal: PlatformEventLog;
  options: (overrides?: Partial<MenderOptions>, env?: Record<string, string>) => MenderOptions;
}

/** A repository with one source file, one bare remote, one verdict and one journal. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'atoma-mender-'));
  dirs.push(root);
  const bare = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const supervisor = join(root, 'supervisor');
  const runs = join(root, 'runs');
  const stubs = join(root, 'stubs');
  mkdirSync(runs);
  mkdirSync(stubs);
  git(root, ['init', '--bare', '-b', 'main', bare]);
  git(root, ['clone', '-q', bare, repo]);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.hooksPath', join(root, 'no-hooks')]);
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'src', 'adder.mjs'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(join(repo, 'tests', '.keep'), '');
  writeFileSync(join(repo, 'package.json'), '{ "name": "fixture", "type": "module" }\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);

  mkdirSync(join(supervisor, 'verdicts'), { recursive: true });
  writeFileSync(
    join(supervisor, 'verdicts', `${RUN_ID}.json`),
    JSON.stringify({
      schema: 'atoma.supervisor.verdict/v1',
      runId: RUN_ID,
      runStatus: 'failed',
      runAssessment: { grade: 'deficient', summary: 'The adder subtracts.' },
      findings: [
        {
          kind: 'mechanism_candidate',
          title: 'Add an arithmetic sanity gate',
          detail: 'analysed before candidates became mendable, so never mended here',
          evidence: [],
          confidence: 'high',
          proposedFix: { where: 'src/', what: 'gate', checkedIntentionalChoices: 'AGENTS.md' },
        },
        {
          kind: 'defect',
          title: 'add() subtracts its operands',
          detail: 'The adder returns a - b.',
          evidence: [
            { ref: 'src/adder.mjs:1', quote: 'a - b' },
            { ref: 'supervisor/work/x/events.ndjson:9', quote: 'UNTRUSTED TRACE TEXT' },
          ],
          proposedFix: { where: 'src/adder.mjs', what: 'Return a + b.', checkedIntentionalChoices: 'src/AGENTS.md — no recorded shortcut.' },
          confidence: 'high',
        },
      ],
      _meta: { analysedAt: '2026-09-05T10:05:00.000Z' },
    })
  );

  const ghLog = join(root, 'gh.log');
  const claudeArgs = join(root, 'claude-args.json');
  // The model stand-in. STUB_MODE picks what it "does" to the worktree; the
  // structured report is what a real `claude -p --json-schema` wrapper carries.
  writeFileSync(
    join(stubs, 'claude.mjs'),
    `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.env.STUB_MODE ?? 'fix';
writeFileSync(process.env.STUB_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));
if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 60_000));
const cwd = process.cwd();
const failingTest = "import { add } from '../src/adder.mjs';\\nif (add(1, 2) !== 3) { console.error('add(1,2) !== 3'); process.exit(1); }\\n";
let report = { schema: 'atoma.supervisor.mend/v1', outcome: 'fixed', title: 'make add() add', summary: 'add() returned a - b; it now returns a + b, and the test proves it.', checkedIntentionalChoices: 'src/AGENTS.md read; not a recorded shortcut.', regressionTests: ['tests/adder.test.mjs'] };
if (['fix', 'forbidden', 'notest', 'no-mechanism'].includes(mode)) writeFileSync(join(cwd, 'src', 'adder.mjs'), 'export const add = (a, b) => a + b;\\n');
if (mode === 'fix' || mode === 'forbidden') writeFileSync(join(cwd, 'tests', 'adder.test.mjs'), failingTest);
if (mode === 'no-mechanism') writeFileSync(join(cwd, 'tests', 'adder.test.mjs'), 'process.exit(0);\\n');
if (mode === 'forbidden') writeFileSync(join(cwd, 'package.json'), '{ "name": "tampered" }\\n');
if (mode === 'declined') report = { ...report, outcome: 'declined', declineReason: 'the remedy is a new gate — a design choice for a person' };
process.stdout.write(JSON.stringify({ type: 'result', structured_output: report, total_cost_usd: 0.42, duration_ms: 1234, num_turns: 3, modelUsage: { 'claude-sonnet-5': { costUSD: 0.4, inputTokens: 10, outputTokens: 5 } } }));
`
  );
  // The test runner stand-in: run each test file as a node script.
  writeFileSync(
    join(stubs, 'test.mjs'),
    `
import { spawnSync } from 'node:child_process';
let failed = false;
for (const file of process.argv.slice(2)) if (spawnSync(process.execPath, [file], { stdio: 'inherit' }).status !== 0) failed = true;
process.exit(failed ? 1 : 0);
`
  );
  writeFileSync(
    join(stubs, 'check.mjs'),
    `
import { appendFileSync } from 'node:fs';
if (process.env.STUB_CHECK_LOG) appendFileSync(process.env.STUB_CHECK_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(process.env.STUB_CHECK_FAIL === '1' ? 1 : 0);
`
  );
  writeFileSync(join(stubs, 'noop.mjs'), `process.exit(0);\n`);
  writeFileSync(
    join(stubs, 'gh.mjs'),
    `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'list' && args.some((arg) => arg.includes('headRefName'))) {
  if (process.env.STUB_GH_OPEN_MENDS === 'fail') { process.stderr.write('HTTP 502'); process.exit(1); }
  process.stdout.write(process.env.STUB_GH_OPEN_MENDS ?? '[]'); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write(process.env.STUB_GH_LIST ?? '[]'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'create') { process.stdout.write('https://github.com/example/atoma/pull/42\\n'); process.exit(0); }
process.exit(2);
`
  );
  const journal = PlatformEventLog.open(join(root, 'atoma.db'));
  const options: Fixture['options'] = (overrides = {}, env = {}) => {
    // Stub behaviour rides the environment the child processes inherit.
    process.env['STUB_GH_LOG'] = ghLog;
    process.env['STUB_CLAUDE_ARGS'] = claudeArgs;
    process.env['STUB_CHECK_LOG'] = join(root, 'check-args.jsonl');
    delete process.env['STUB_MODE'];
    delete process.env['STUB_CHECK_FAIL'];
    delete process.env['STUB_GH_LIST'];
    delete process.env['STUB_GH_OPEN_MENDS'];
    Object.assign(process.env, env);
    return {
      executeUntrusted: runCommand,
      repo,
      runsDir: runs,
      supervisorDir: supervisor,
      leasePath: join(root, 'no-such-lease.db'),
      provider: { selector: 'api:anthropic:claude-sonnet-5', transport: 'claude', model: 'claude-sonnet-5', baseUrl: null, authToken: 'sk-ant-test', source: 'mender' },
      commands: {
        claude: join(stubs, 'claude.mjs'),
        gh: join(stubs, 'gh.mjs'),
        install: join(stubs, 'noop.mjs'),
        test: join(stubs, 'test.mjs'),
        check: join(stubs, 'check.mjs'),
      },
      base: 'main',
      remote: 'origin',
      minConfidence: 'high',
      budgetUsd: 5,
      timeoutMs: 60_000,
      maxDiffLines: 600,
      dryRun: false,
      force: false,
      keepWorktree: false,
      idleGate: true,
      waitForIdle: false,
      pollMs: 100,
      journal: (input) => void journal.append(input),
      log: () => {},
      warn: () => {},
      ...overrides,
    };
  };
  return { root, bare, repo, supervisor, runs, stubs, ghLog, claudeArgs, journal, options };
}

function record(f: Fixture): MendRecord | null {
  const path = mendRecordPath(join(f.supervisor, 'mender'), RUN_ID, 1);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as MendRecord) : null;
}

function remoteBranches(f: Fixture): string[] {
  return git(f.bare, ['branch', '--list', 'mender/*'])
    .split('\n')
    .map((line) => line.replace('*', '').trim())
    .filter(Boolean);
}

function worktrees(f: Fixture): string[] {
  const dir = join(f.repo, '.worktrees');
  return existsSync(dir) ? readdirSync(dir) : [];
}

function journalKinds(f: Fixture): PlatformEventKind[] {
  return f.journal
    .list({ limit: 50 })
    .events.map((event) => event.kind)
    .reverse();
}

async function mendPending(f: Fixture, options: MenderOptions): Promise<{ failures: number; records: MendRecord[] }> {
  return processMends(pendingMends(options, [RUN_ID]), options);
}

describe('the mender, end to end against a real repository', () => {
  it.skipIf(process.platform === 'win32')('mends through a ChatGPT Codex session, verifies the regression and publishes via the harness', async () => {
    const f = fixture();
    const home = join(f.root, 'codex-home'); mkdirSync(home);
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'initial' } }));
    const stub = join(f.stubs, 'codex.mjs');
    writeCodexStub(stub, { log: join(f.root, 'codex.jsonl'), edit: true, report: {
      schema: 'atoma.supervisor.mend/v1', outcome: 'fixed', title: 'make add() add', summary: 'Return the sum.',
      checkedIntentionalChoices: 'src/AGENTS.md read.', regressionTests: ['tests/adder.test.mjs'],
    } });
    const options = f.options();
    const result = await mendPending(f, { ...options,
      provider: { selector: 'sub:openai:gpt-5.6-sol', transport: 'codex', codexHome: home, model: 'gpt-5.6-sol', source: 'mender', baseUrl: null, authToken: null },
      commands: { ...options.commands, codex: stub },
    });
    expect(result.failures).toBe(0);
    expect(result.records[0]).toMatchObject({ outcome: 'pr-opened', mendCostUsd: null, verification: { testFailedBefore: true, checkPassed: true } });
    expect(remoteBranches(f)).toHaveLength(1);
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain('rotated');
  }, TIMEOUT_MS);

  it('turns a cited defect into a pushed branch, a pull request and a journal row, then cleans up', async () => {
    const f = fixture();
    const { failures } = await mendPending(f, f.options());
    expect(failures).toBe(0);

    const rec = record(f)!;
    expect(rec).toMatchObject({ outcome: 'pr-opened', prUrl: 'https://github.com/example/atoma/pull/42', mendCostUsd: 0.42 });
    expect(rec.verification).toMatchObject({ testFailedBefore: true, checkPassed: true, testFiles: ['tests/adder.test.mjs'] });
    // The mechanism candidate at index 0 predates CANDIDATES_MENDABLE_SINCE and was never touched.
    expect(existsSync(mendRecordPath(join(f.supervisor, 'mender'), RUN_ID, 0))).toBe(false);

    const [branch] = remoteBranches(f);
    expect(branch).toBe('mender/deadbeef-1-add-subtracts-its-operands');
    const message = git(f.bare, ['log', '-1', '--format=%B%n--author:%an', branch!]);
    expect(message).toMatch(/^fix\(adder\): make add\(\) add/);
    expect(message).toContain('Regression test fails before the fix: yes');
    expect(message).toContain('Full check: CI, on the pull request');
    expect(message).toMatch(/Defect-Key: [0-9a-f]{12}/);
    // The harness check is handed the change it verifies: the full check
    // cannot run on the production host (scripts/check-changed.mjs).
    const checked = readFileSync(join(f.root, 'check-args.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(checked).toEqual([['src/adder.mjs', 'tests/adder.test.mjs']]);
    expect(message).toContain('--author:atoma mender');
    expect(git(f.bare, ['show', `${branch!}:src/adder.mjs`])).toContain('a + b');
    expect(git(f.bare, ['show', 'main:src/adder.mjs'])).toContain('a - b');

    const ghCalls = readFileSync(f.ghLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(ghCalls[0]!.slice(0, 2)).toEqual(['pr', 'list']);
    const create = ghCalls.find((call) => call[1] === 'create')!;
    expect(create[create.indexOf('--base') + 1]).toBe('main');
    expect(create[create.indexOf('--head') + 1]).toBe(branch);
    const body = readFileSync(create[create.indexOf('--body-file') + 1]!, 'utf8');
    expect(body).toContain('Defect-Key:');
    expect(body).not.toContain('UNTRUSTED TRACE TEXT');
    expect(body).toContain('withheld from the mender by design');

    // The model's own leash, as passed on its command line.
    const args = JSON.parse(readFileSync(f.claudeArgs, 'utf8')) as string[];
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--allowedTools') + 1]).not.toMatch(/git (push|commit)|gh/);
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('5');
    expect(args.at(-1)).toContain('add() subtracts its operands');
    expect(args.at(-1)).not.toContain('UNTRUSTED TRACE TEXT');

    // The journal: started, then opened — facts only.
    expect(journalKinds(f)).toEqual(['mender.started', 'mender.pr_opened']);
    const opened = f.journal.list({ kind: 'mender.pr_opened' }).events[0]!;
    expect(opened.runId).toBe(RUN_ID);
    expect(opened.actorType).toBe('system');
    expect(opened.detail).toMatchObject({ stage: 'mender', prUrl: 'https://github.com/example/atoma/pull/42', branch, changedFiles: 2 });
    expect(JSON.stringify(opened)).not.toContain('make add() add');

    expect(worktrees(f)).toEqual([]);
    expect(existsSync(join(f.supervisor, 'mender.lock'))).toBe(false);
    expect(readFileSync(join(f.supervisor, 'mender.jsonl'), 'utf8')).toContain('"outcome":"pr-opened"');
  }, TIMEOUT_MS);

  it('refuses a change outside the allowlist, pushes nothing and journals the refusal', async () => {
    const f = fixture();
    const { failures } = await mendPending(f, f.options({}, { STUB_MODE: 'forbidden' }));
    expect(failures).toBe(1);
    const rec = record(f)!;
    expect(rec.outcome).toBe('refused');
    expect(rec.problems?.join()).toContain('package.json');
    expect(remoteBranches(f)).toEqual([]);
    expect(worktrees(f)).toHaveLength(1);
    expect(readFileSync(f.ghLog, 'utf8')).not.toContain('"create"');
    expect(journalKinds(f)).toEqual(['mender.started', 'mender.refused']);
    expect(f.journal.list({ kind: 'mender.refused' }).events[0]!.detail).toMatchObject({ worktreeKept: true });
  }, TIMEOUT_MS);

  it('refuses a fix whose test already passes on the unfixed code', async () => {
    const f = fixture();
    await mendPending(f, f.options({}, { STUB_MODE: 'no-mechanism' }));
    expect(record(f)!.outcome).toBe('refused');
    expect(record(f)!.problems?.join()).toMatch(/passes on the unfixed code/);
    expect(remoteBranches(f)).toEqual([]);
  }, TIMEOUT_MS);

  it('refuses a fix with no regression test', async () => {
    const f = fixture();
    await mendPending(f, f.options({}, { STUB_MODE: 'notest' }));
    expect(record(f)!.problems?.join()).toMatch(/no regression test/);
    expect(remoteBranches(f)).toEqual([]);
  }, TIMEOUT_MS);

  it('refuses when the harness check is red after the fix', async () => {
    const f = fixture();
    await mendPending(f, f.options({}, { STUB_CHECK_FAIL: '1' }));
    expect(record(f)!.outcome).toBe('refused');
    expect(record(f)!.problems?.join()).toMatch(/harness check is red/);
    expect(remoteBranches(f)).toEqual([]);
  }, TIMEOUT_MS);

  // The repository requires a CLA check that resolves a commit's AUTHOR to an
  // account: the default mender author is nobody's, so its pull requests could
  // never be green. The named person authors; the harness still commits, and
  // the trailer still says what wrote the change.
  it('authors the commit as the configured person and keeps the provenance trailer', async () => {
    const f = fixture();
    const { failures } = await mendPending(f, f.options({ gitAuthor: 'Ada Reviewer <ada@example.invalid>' }));
    expect(failures).toBe(0);
    const [branch] = remoteBranches(f);
    const commit = git(f.bare, ['log', '-1', '--format=%an <%ae>%n%cn%n%B', branch!]);
    expect(commit.split('\n')[0]).toBe('Ada Reviewer <ada@example.invalid>');
    expect(commit.split('\n')[1]).not.toBe('Ada Reviewer');
    expect(commit).toContain('Authored-By: atoma mender');
  }, TIMEOUT_MS);

  it('records and journals a decline without touching the remote', async () => {
    const f = fixture();
    const { failures } = await mendPending(f, f.options({}, { STUB_MODE: 'declined' }));
    expect(failures).toBe(0);
    expect(record(f)!.outcome).toBe('declined');
    expect(record(f)!.report?.declineReason).toMatch(/design choice/);
    expect(remoteBranches(f)).toEqual([]);
    expect(worktrees(f)).toEqual([]);
    expect(journalKinds(f)).toEqual(['mender.started', 'mender.declined']);
  }, TIMEOUT_MS);

  it('skips a defect that already has an open pull request, spending nothing and journaling nothing', async () => {
    const f = fixture();
    await mendPending(
      f,
      f.options({}, { STUB_GH_LIST: JSON.stringify([{ number: 7, url: 'https://github.com/example/atoma/pull/7', title: 'earlier' }]) })
    );
    expect(record(f)).toMatchObject({ outcome: 'skipped-duplicate', duplicateOf: ['https://github.com/example/atoma/pull/7'] });
    expect(existsSync(f.claudeArgs)).toBe(false);
    expect(remoteBranches(f)).toEqual([]);
    expect(journalKinds(f)).toEqual([]);
  }, TIMEOUT_MS);

  it('refuses to start beside a live run', async () => {
    const f = fixture();
    writeFileSync(
      join(f.runs, 'index.json'),
      JSON.stringify([{ id: 'live-1', label: 'live', startedAt: new Date().toISOString(), lastEventAt: Date.now(), inFlight: true }])
    );
    const { failures } = await mendPending(f, f.options());
    expect(failures).toBe(1);
    expect(record(f)).toBeNull();
    expect(existsSync(f.claudeArgs)).toBe(false);
    expect(worktrees(f)).toEqual([]);
    expect(existsSync(join(f.supervisor, 'mender.lock'))).toBe(false);
    expect(journalKinds(f)).toEqual([]);
  }, TIMEOUT_MS);

  it('mends a dispatched request file exactly like a local verdict, and the PR names the requester', async () => {
    const f = fixture();
    const request = {
      ...EXAMPLE_MEND_REQUEST,
      runId: RUN_ID,
      findingIndex: 1,
      finding: {
        ...EXAMPLE_MEND_REQUEST.finding,
        title: 'add() subtracts its operands',
        proposedFix: { ...EXAMPLE_MEND_REQUEST.finding.proposedFix, where: 'src/adder.mjs' },
      },
      instance: 'atoma.example.com',
    };
    const { failures } = await processMends([mendInputFromRequest(request)], f.options());
    expect(failures).toBe(0);
    expect(record(f)).toMatchObject({ outcome: 'pr-opened', prUrl: 'https://github.com/example/atoma/pull/42' });
    expect(remoteBranches(f)).toEqual(['mender/deadbeef-1-add-subtracts-its-operands']);
    const ghCalls = readFileSync(f.ghLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    const create = ghCalls.find((call) => call[1] === 'create')!;
    const body = readFileSync(create[create.indexOf('--body-file') + 1]!, 'utf8');
    expect(body).toContain('requested by: atoma.example.com');
    expect(journalKinds(f)).toEqual(['mender.started', 'mender.pr_opened']);
  }, TIMEOUT_MS);

  it('proceeds beside a live run only when the idle gate is explicitly off', async () => {
    const f = fixture();
    writeFileSync(
      join(f.runs, 'index.json'),
      JSON.stringify([{ id: 'live-1', label: 'live', startedAt: new Date().toISOString(), lastEventAt: Date.now(), inFlight: true }])
    );
    const { failures } = await mendPending(f, f.options({ idleGate: false }));
    expect(failures).toBe(0);
    expect(record(f)?.outcome).toBe('pr-opened');
  }, TIMEOUT_MS);

  it('reserves the product slot through every executable phase and releases it afterwards', async () => {
    const f = fixture();
    const options = f.options();
    let phases = 0;
    const executeUntrusted: typeof runCommand = async (...args) => {
      phases++;
      expect(peekRunLease(options.leasePath)?.runId).toBe(`mender:${RUN_ID}`);
      expect(() => acquireRunLeaseWithoutRecovery('product-run', options.leasePath)).toThrow(/occupied/);
      if (phases === 1) {
        const probe = await runCommand(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
          `import { acquireRunLeaseWithoutRecovery } from './src/mcp/runLock.ts';
           try { acquireRunLeaseWithoutRecovery('other-process', ${JSON.stringify(options.leasePath)}); process.exit(12); }
           catch (error) { if (error.name !== 'RunLockBusyError') throw error; }`,
        ], { cwd: process.cwd(), timeoutMs: 10_000 });
        expect(probe.code).toBe(0);
      }
      return options.executeUntrusted!(...args);
    };
    await mendPending(f, { ...options, executeUntrusted });
    expect(record(f)?.outcome).toBe('pr-opened');
    expect(phases).toBeGreaterThan(2);
    expect(peekRunLease(options.leasePath)).toBeNull();
  }, TIMEOUT_MS);

  it('resumes an existing verdict and retries a deferred finding without a restart', async () => {
    const f = fixture();
    const controller = new AbortController();
    const options = f.options({ pollMs: 20 }, { STUB_MODE: 'declined' });
    const lease = acquireRunLeaseWithoutRecovery('analyst:other', options.leasePath);
    let polls = 0;
    const timer = setInterval(() => {
      polls++;
      if (polls === 3) lease.release();
      if (existsSync(mendRecordPath(join(f.supervisor, 'mender'), RUN_ID, 1))) controller.abort();
    }, 30);
    const deadline = setTimeout(() => controller.abort(), 30_000);
    try {
      await runMenderLoop({ options, signal: controller.signal });
      expect(record(f)?.outcome).toBe('declined');
    } finally {
      controller.abort();
      lease.release();
      clearInterval(timer);
      clearTimeout(deadline);
    }
  }, TIMEOUT_MS);

  it.skipIf(process.platform === 'win32')('mends over a run slot a killed stage left behind, and says so', async () => {
    // 2026-09-27: a SIGKILLed mender's row refused deployments and every
    // analysis for 2 h 10. After a reboot its pid may be any process's — the
    // new mender's own included (this test's, here): the idle predicate reads
    // birth identity, or the stage never reaches the reclaim.
    const f = fixture();
    const warnings: string[] = [];
    const options = f.options({ warn: (line) => warnings.push(line) }, { STUB_MODE: 'declined' });
    acquireRunLeaseWithoutRecovery('warm-up', options.leasePath).release();
    const db = new Database(options.leasePath);
    db.prepare(
      `INSERT INTO mcp_run_lease (singleton, token, run_id, owner_pid, child_pgid, acquired_at, owner_fingerprint)
       VALUES (1, 'killed', 'mender:killed', ?, NULL, ?, 'linux:another-boot:1')`
    ).run(process.pid, new Date().toISOString());
    db.close();
    // Its file lock survived the same reboot and names this very pid.
    mkdirSync(f.supervisor, { recursive: true });
    writeFileSync(join(f.supervisor, 'mender.lock'), JSON.stringify({ pid: process.pid, fingerprint: 'linux:another-boot:1' }));

    await mendPending(f, options);

    expect(record(f)?.outcome).toBe('declined');
    expect(warnings.some((line) => line.startsWith('reclaimed the run slot from mender:killed'))).toBe(true);
    expect(peekRunLease(options.leasePath)).toBeNull();
  }, TIMEOUT_MS);

  it('ends an attempt at a stop, keeps the finding pending, and resumes it on the next start', async () => {
    // A stop used to wait for the whole attempt — three hours allowed — and a
    // SIGKILL instead left the run slot held by a dead process, refusing
    // deployments and the analyst for 2 h 10 (2026-09-27).
    const f = fixture();
    const controller = new AbortController();
    const options = f.options({ signal: controller.signal }, { STUB_MODE: 'slow' });
    const watching = setInterval(() => {
      if (existsSync(f.claudeArgs)) controller.abort(new Error('the mender service is stopping'));
    }, 20);
    try {
      const { records } = await mendPending(f, options);
      expect(records.map((entry) => entry.outcome)).toEqual(['interrupted']);
    } finally {
      clearInterval(watching);
    }
    expect(record(f)).toMatchObject({ outcome: 'interrupted', reason: expect.stringMatching(/next start resumes it/) });
    expect(remoteBranches(f)).toEqual([]);
    expect(peekRunLease(options.leasePath)).toBeNull();
    // Nothing for anyone to act on: the start is journaled, the stop is not.
    expect(journalKinds(f)).toEqual(['mender.started']);

    const next = f.options({}, { STUB_MODE: 'declined' });
    expect(pendingMends(next, [RUN_ID]).map((item) => item.index)).toEqual([1]);
    await mendPending(f, next);
    expect(record(f)?.outcome).toBe('declined');
  }, TIMEOUT_MS);

  it('starts no mend while the review backlog is full, and resumes once a person merged one', async () => {
    // Each mend holds the one run slot for about twenty minutes. Past the rate
    // a person merges, a pull request only queues while member runs and
    // deployments are refused behind it (2026-09-27).
    const f = fixture();
    const controller = new AbortController();
    const lines: string[] = [];
    const mendRow = (n: number) => ({ headRefName: `mender/run${n}-1-fix`, isCrossRepository: false });
    const options = f.options(
      { pollMs: 20, maxOpenPullRequests: 3, log: (line) => lines.push(line) },
      {
        STUB_MODE: 'declined',
        // A person's branch never counts toward the mender's backlog, nor
        // does a fork's branch named like one: the repository is public.
        STUB_GH_OPEN_MENDS: JSON.stringify([
          mendRow(1), mendRow(2), mendRow(3),
          { headRefName: 'feature/x', isCrossRepository: false },
          { headRefName: 'mender/forged-1-fix', isCrossRepository: true },
        ]),
      }
    );
    const openListings = (): number => (existsSync(f.ghLog) ? readFileSync(f.ghLog, 'utf8') : '')
      .split('\n').filter((line) => line.includes('headRefName')).length;
    let merged = false;
    const timer = setInterval(() => {
      if (!merged && openListings() >= 4) {
        merged = true;
        process.env['STUB_GH_OPEN_MENDS'] = JSON.stringify([mendRow(1), mendRow(2)]);
      }
      if (record(f)) controller.abort();
    }, 10);
    const deadline = setTimeout(() => controller.abort(), 30_000);
    try {
      await runMenderLoop({ options, signal: controller.signal });
      expect(openListings()).toBeGreaterThanOrEqual(4);
      expect(record(f)?.outcome).toBe('declined');
      // Held for several polls, said once.
      expect(lines.filter((line) => line.includes('no mend starts until a person merges'))).toEqual([
        '3 mender pull request(s) are open (limit 3); no mend starts until a person merges or closes one',
      ]);
      expect(lines).toContain('review back-pressure released');
    } finally {
      controller.abort();
      clearInterval(timer);
      clearTimeout(deadline);
    }
  }, TIMEOUT_MS);

  it('holds the review gate when GitHub cannot say how many mender pull requests are open', async () => {
    const f = fixture();
    const controller = new AbortController();
    const lines: string[] = [];
    const options = f.options(
      { pollMs: 20, log: (line) => lines.push(line) },
      { STUB_MODE: 'declined', STUB_GH_OPEN_MENDS: 'fail' }
    );
    const timer = setInterval(() => {
      const listings = (existsSync(f.ghLog) ? readFileSync(f.ghLog, 'utf8') : '')
        .split('\n').filter((line) => line.includes('headRefName')).length;
      if (listings >= 3) controller.abort();
    }, 10);
    const deadline = setTimeout(() => controller.abort(), 30_000);
    try {
      await runMenderLoop({ options, signal: controller.signal });
      expect(record(f)).toBeNull();
      expect(existsSync(f.claudeArgs)).toBe(false);
      expect(lines).toContain('GitHub cannot say how many mender pull requests are open; no mend starts until it can');
    } finally {
      controller.abort();
      clearInterval(timer);
      clearTimeout(deadline);
    }
  }, TIMEOUT_MS);

  it('takes a confident candidate only from a verdict analysed since candidates became mendable', () => {
    // The service resumes every unrecorded finding after a restart: without the
    // cut-off, three weeks of backlog held the run slot back to back and the
    // next deployment was refused (2026-09-27).
    const f = fixture();
    const options = f.options();
    expect(pendingMends(options, [RUN_ID]).map((item) => item.index)).toEqual([1]);
    const path = join(f.supervisor, 'verdicts', `${RUN_ID}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { _meta: { analysedAt: string } };
    stored._meta.analysedAt = new Date(Date.parse(CANDIDATES_MENDABLE_SINCE) + 60_000).toISOString();
    writeFileSync(path, JSON.stringify(stored));
    expect(pendingMends(options, [RUN_ID]).map((item) => [item.index, item.finding.kind]))
      .toEqual([[0, 'mechanism_candidate'], [1, 'defect']]);
  });

  it('does not run the same finding twice unless forced', async () => {
    const f = fixture();
    await mendPending(f, f.options({}, { STUB_MODE: 'declined' }));
    rmSync(f.claudeArgs);
    const options = f.options({}, { STUB_MODE: 'declined' });
    expect(pendingMends(options, [RUN_ID])).toEqual([]);
    await mendPending(f, options);
    expect(existsSync(f.claudeArgs)).toBe(false);
  }, TIMEOUT_MS);

  it('dry-run prepares the worktree, prints the leash and spends nothing', async () => {
    const f = fixture();
    const lines: string[] = [];
    const options = f.options({ dryRun: true, log: (line) => lines.push(line) });
    const work = pendingMends(options, [RUN_ID]);
    const rec = await mendFinding(work[0]!, options);
    expect(rec?.outcome).toBe('dry-run');
    expect(lines.join('\n')).toContain('dry-run: would spawn');
    expect(lines.join('\n')).toContain('--restricted');
    expect(existsSync(f.claudeArgs)).toBe(false);
    expect(worktrees(f)).toEqual([]);
    expect(journalKinds(f)).toEqual([]);
  }, TIMEOUT_MS);
});

describe('verification cannot change the proposed patch', () => {
  it('refuses a successful check that writes a forbidden file', async () => {
    const f = fixture();
    writeFileSync(join(f.stubs, 'check.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('package.json', '{}');\n");
    await mendPending(f, f.options());
    expect(record(f)?.outcome).toBe('refused');
    expect(record(f)?.problems?.join()).toContain('package.json');
    expect(remoteBranches(f)).toEqual([]);
  }, TIMEOUT_MS);

  it('refuses a successful check that silently rewrites an allowed source file', async () => {
    const f = fixture();
    writeFileSync(join(f.stubs, 'check.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('src/adder.mjs', 'export const add = () => 0;');\n");
    await mendPending(f, f.options());
    expect(record(f)?.outcome).toBe('refused');
    expect(remoteBranches(f)).toEqual([]);
  }, TIMEOUT_MS);
});


describe('publisher hooks cannot execute proposal code', () => {
  it('does not run a pre-push hook with publisher authority', async () => {
    const f = fixture();
    const hooks = join(f.root, 'publisher-hooks');
    mkdirSync(hooks);
    const marker = join(f.root, 'publisher-hook-ran');
    const hook = join(hooks, 'pre-push');
    writeFileSync(hook, '#!/bin/sh\ntouch "' + marker + '"\n');
    chmodSync(hook, 0o755);
    git(f.repo, ['config', 'core.hooksPath', hooks]);
    await mendPending(f, f.options());
    expect(record(f)?.outcome).toBe('pr-opened');
    expect(existsSync(marker)).toBe(false);
    expect(remoteBranches(f)).toHaveLength(1);
  }, TIMEOUT_MS);
});
