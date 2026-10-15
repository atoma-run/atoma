#!/usr/bin/env tsx
/**
 * atoma assayer — judge learned recipes by execution (stage 4 of the
 * supervisor, docs/skill-assay-2026-10-15.md).
 *
 *   npm run assayer -- --once                 # assay the next pending recipe, exit
 *   npm run assayer -- --once --max 3         # up to three
 *   npm run assayer -- --skill <ns>/<id>      # this recipe now, even if already judged
 *   npm run assayer -- --dry-run --once       # name the cases and the runs; spend nothing
 *   npm run assayer                           # watch: one assay per poll when the machine is idle
 *
 * Spends the operator's model quota on ORDINARY RUNS — two per credited task,
 * with and without the recipe — and therefore never runs beside a run: the
 * same idle predicate and lease as the analyst. Each arm runs on copies of
 * the store and the catalog, in its own workspace and runs directory, with
 * learning off. The only write to the commons is the decision, and the only
 * decision with power is a retirement, under the pre-registered rule in
 * src/supervisor/assayer.ts. Records land under supervisor/assays/, one
 * `supervisor.assay` row per assay in the journal.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { skillsDirPath, storeDbPath } from '../core/stores.js';
import { mcpRunLockPath } from '../mcp/runLock.js';
import { PlatformEventLog } from '../platform/events.js';
import { openDb } from '../registry/db.js';
import { SkillRegistry } from '../skills/registry.js';
import { supervisorDirPath } from '../supervisor/paths.js';
import { ASSAY_DEFAULT_TIMEOUT_MS, ASSAY_MAX_CASES, ASSAYER_DEFAULT_POLL_MS, assayNext, pendingAssays, type AssayerOptions } from '../supervisor/assayer.js';
import { anyRunActive } from '../supervisor/activity.js';
import { parseCliArgs } from './args.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';

const USAGE = `atoma assayer — judge learned recipes by execution, never beside a run

usage:
  npm run assayer [-- --once [--max <n>]] [--skill <namespace>/<id>] [--dry-run]
                  [--cases <n>] [--timeout-ms <ms>] [--poll-ms <ms>]
                  [--runs <dir>] [--skills-dir <dir>] [--supervisor-dir <dir>] [--db <path>]

what it does:
  Picks a task recipe whose current surface (kind, when_to_use, body) has not
  been judged, takes up to --cases of the tasks it was credited on, and runs
  each task twice through the ordinary runner: once on a copy of the catalog
  holding the recipe, once on a copy without it. Store, workspace and runs
  directory are copies too, and learning is off. The verdict reads what the
  runs delivered; a recipe that delivered nothing on two or more matched
  cases where the run without it delivered is RETIRED from the catalog.
  Everything else is recorded and kept. Record: supervisor/assays/<recipe>/assay.json;
  journal: one supervisor.assay row.

what it does NOT do:
  Run beside a run or a deployment, change a recipe's body, credit or blame
  a recipe, or read anything model-authored as a fact.

provider:
  the three ATOMA_MODEL_L* pins and their credentials, as for any run.

flags:
  --once                 assay pending recipes (see --max), then exit
  --max <n>              recipes per --once (default 1)
  --skill <ns>/<id>      assay this recipe now, judged or not
  --dry-run              name the cases and the runs; spend nothing
  --cases <n>            credited tasks per recipe (default ${ASSAY_MAX_CASES})
  --timeout-ms <ms>      wall clock per arm run (default ${ASSAY_DEFAULT_TIMEOUT_MS})
  --poll-ms <ms>         watch-mode poll (default ${ASSAYER_DEFAULT_POLL_MS})
  --runs <dir>           operator runs directory, read for the idle predicate (default ATOMA_RUNS_DIR or ./runs)
  --skills-dir <dir>     the live catalog (default ATOMA_SKILLS_DIR or ./skills)
  --supervisor-dir <dir> where assays live (default ATOMA_SUPERVISOR_DIR or ./supervisor)
  --db <path>            the product store (default ATOMA_DB_PATH or ./atoma.db)
  --help                 show this help`;

function fail(message: string): never {
  process.stderr.write(`atoma assayer: ${message}\n`);
  process.exit(1);
}

function positiveNumber(raw: string | undefined, label: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`invalid ${label}="${raw}"`);
  return value;
}

async function main(): Promise<void> {
  applyCheckoutDotenvForSourceEntry();
  const args = parseCliArgs(process.argv, {
    booleanFlags: ['help', 'once', 'dry-run'],
    valueFlags: ['max', 'skill', 'cases', 'timeout-ms', 'poll-ms', 'runs', 'skills-dir', 'supervisor-dir', 'db'],
    undeclared: 'discard',
  });
  if (args.flags['help'] === 'true') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.undeclaredFlags.length > 0) fail(`unknown flag: ${args.undeclaredFlags[0]!}`);
  if (args.command !== null) fail(`unexpected argument: ${args.command}`);

  const repoRoot = process.cwd();
  const runsDir = resolve(args.flags['runs'] || process.env['ATOMA_RUNS_DIR'] || './runs');
  const skillsDir = resolve(skillsDirPath(args.flags['skills-dir']));
  const supervisorDir = args.flags['supervisor-dir'] ? resolve(args.flags['supervisor-dir']) : supervisorDirPath();
  const dbPath = resolve(args.flags['db'] || storeDbPath());
  if (!existsSync(dbPath)) fail(`no product store at ${dbPath}: nothing to assay`);
  const db = openDb(dbPath);
  const skills = new SkillRegistry(skillsDir, { db });
  const journal = PlatformEventLog.open(dbPath);
  const log = (line: string): void => void process.stdout.write(`[assayer ${new Date().toISOString()}] ${line}\n`);
  const warn = (line: string): void => void process.stderr.write(`[assayer ${new Date().toISOString()}] WARN ${line}\n`);
  const controller = new AbortController();
  const options: AssayerOptions = {
    repoRoot, dbPath, skillsDir, skills, runsDir, supervisorDir,
    leasePath: mcpRunLockPath(),
    timeoutMs: positiveNumber(args.flags['timeout-ms'], '--timeout-ms', ASSAY_DEFAULT_TIMEOUT_MS),
    maxCases: Math.max(1, Math.trunc(positiveNumber(args.flags['cases'], '--cases', ASSAY_MAX_CASES))),
    dryRun: args.flags['dry-run'] === 'true',
    journal: (input) => void journal.append(input),
    signal: controller.signal,
    log, warn,
  };
  process.stdout.write(
    `atoma assayer — recipes judged by execution, never beside a run\n` +
      `  store      ${dbPath}\n` +
      `  catalog    ${skillsDir}\n` +
      `  assays     ${supervisorDir}/assays\n` +
      `  pending    ${pendingAssays(skills).length} recipe surface(s)${options.dryRun ? ' (DRY-RUN)' : ''}\n`
  );

  const only = args.flags['skill'];
  if (only) {
    const [namespace, skillId] = only.split('/');
    if (!namespace || !skillId) fail(`--skill expects <namespace>/<id>, got "${only}"`);
    const result = await assayNext(options, { only: { namespace, skillId } });
    log(`${only}: ${result.outcome}${result.judgement ? ` (${result.judgement.verdict} → ${result.judgement.decision})` : ''}${result.detail ? `: ${result.detail}` : ''}`);
    process.exitCode = result.outcome === 'assayed' || result.outcome === 'dry-run' ? 0 : 1;
    return;
  }

  if (args.flags['once'] === 'true') {
    const max = Math.max(1, Math.trunc(positiveNumber(args.flags['max'], '--max', 1)));
    let failures = 0;
    for (let i = 0; i < max; i += 1) {
      const result = await assayNext(options);
      if (result.outcome === 'nothing-pending') { log('nothing pending'); break; }
      log(`${result.target?.namespace}/${result.target?.skillId}: ${result.outcome}${result.judgement ? ` (${result.judgement.verdict} → ${result.judgement.decision})` : ''}`);
      if (result.outcome === 'refused-active') break;
      if (result.outcome !== 'assayed' && result.outcome !== 'dry-run') failures += 1;
    }
    process.exitCode = failures > 0 ? 1 : 0;
    return;
  }

  const stop = (): void => { log('stopping'); controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const pollMs = positiveNumber(args.flags['poll-ms'], '--poll-ms', ASSAYER_DEFAULT_POLL_MS);
  log(`watching the catalog (poll ${pollMs}ms${options.dryRun ? ', DRY-RUN' : ''})`);
  while (!controller.signal.aborted) {
    if (!anyRunActive({ runsDir, leasePath: options.leasePath })) {
      const result = await assayNext(options);
      if (result.outcome !== 'nothing-pending') {
        log(`${result.target?.namespace}/${result.target?.skillId}: ${result.outcome}${result.judgement ? ` (${result.judgement.verdict} → ${result.judgement.decision})` : ''}`);
      }
      if (result.outcome === 'failed' || result.outcome === 'dry-run') break;
    }
    try { await delay(pollMs, undefined, { signal: controller.signal }); } catch { break; }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`atoma assayer: fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
