#!/usr/bin/env node
/**
 * `npm run check:changed -- <file>…` — `npm run check` scoped to one change.
 *
 * The mender's harness runs this after a model's fix, inside a disposable
 * container of 4 GiB and one CPU. The original sizing measurement on
 * 2026-09-28 used a 2 GiB container on a 4 GB host: the
 * type-aware lint of the whole tree peaks at 3.5 GiB resident and aborted at
 * the container's 1536 MiB heap after 191 s, and the suite alone took 18
 * minutes on its one worker, on a desktop core faster than the host's, of a
 * mend's 30-minute phase. So the docs check and the typecheck run whole, as in
 * `npm run check`, ESLint covers the changed files (three of them peak at
 * 1.1 GiB). Tests include the changed test files and tests statically related
 * to other changed files. Deleted files and global configuration changes
 * select the full suite. Dynamic imports and subprocess dependencies still
 * require explicit regression tests. CI runs the full
 * `npm run check` on the pushed branch and on the pull request, and the
 * ruleset on `main` requires it before any merge.
 *
 * `node scripts/check-changed.mjs --json <file>…` emits one JSON object;
 * through npm, use `npm run --silent check:changed -- --json <file>…`.
 * Schema v1 contains the overall status/exitCode and ordered steps with
 * command, args, status, durationMs, exitCode, signal, error, stdout/stderr
 * tails (24,000 UTF-16 units each), and explicit truncation flags. After a
 * failure, remaining steps are marked skipped. Logs remain diagnostic text;
 * consumers need not infer success from them. The default streams live logs.
 * Dependency-free, like every script `docs:check` may run before a build.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LINTABLE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /^tests\/.*\.test\.[cm]?[jt]sx?$/;

/**
 * The commands, in order, for a set of changed repository paths. A deleted
 * path is not linted but selects the full suite; an empty change still gets
 * the whole-tree docs and typecheck steps.
 *
 * @param {readonly string[]} files
 * @param {(file: string) => boolean} [exists]
 * @returns {Array<[string, string[]]>}
 */
export function changedCheckSteps(files, exists = existsSync) {
  const present = [...new Set(files)].filter((file) => exists(file));
  const lintable = present.filter((file) => LINTABLE.test(file));
  const tests = present.filter((file) => TEST_FILE.test(file));
  const related = present.filter((file) => !TEST_FILE.test(file));
  const fullSuite = files.some((file) => !exists(file)) || present.some((file) =>
    /^(package(?:-lock)?\.json|vitest\.config\.[^/]+|tsconfig[^/]*\.json)$/.test(file));
  return [
    ['npm', ['run', 'docs:check']],
    ['npm', ['run', 'typecheck']],
    ...(lintable.length > 0 ? [['npx', ['eslint', ...lintable]]] : []),
    ...(fullSuite ? [['npx', ['vitest', 'run']]] : [
      ...(tests.length > 0 ? [['npx', ['vitest', 'run', ...tests]]] : []),
      ...(related.length > 0 ? [['npx', ['vitest', 'related', '--run', '--passWithNoTests', ...related]]] : []),
    ]),
  ];
}

/** Bound captured diagnostics without terminating an otherwise valid check. */
const OUTPUT_LIMIT = 24_000;

/**
 * @param {string} command
 * @param {string[]} args
 * @param {boolean} json
 */
async function runStep(command, args, json) {
  const started = performance.now();
  let stdout = '', stderr = '';
  let stdoutTruncated = false, stderrTruncated = false;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: process.platform === 'win32',
    });
    child.stdout?.setEncoding('utf8').on('data', (chunk) => {
      stdoutTruncated ||= stdout.length + chunk.length > OUTPUT_LIMIT;
      stdout = (stdout + chunk).slice(-OUTPUT_LIMIT);
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => {
      stderrTruncated ||= stderr.length + chunk.length > OUTPUT_LIMIT;
      stderr = (stderr + chunk).slice(-OUTPUT_LIMIT);
    });
    let error = null;
    child.on('error', (cause) => { error = cause.message; });
    child.on('close', (exitCode, signal) => resolve({
      command, args, status: exitCode === 0 && !error ? 'passed' : 'failed',
      exitCode, signal, error, durationMs: Math.round(performance.now() - started),
      stdout, stderr, stdoutTruncated, stderrTruncated,
    }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const json = process.argv.slice(2).includes('--json');
  const files = process.argv.slice(2).filter((arg) => arg !== '--json');
  const steps = changedCheckSteps(files);
  const results = [];
  let exitCode = 0;
  for (const [command, args] of steps) {
    if (exitCode !== 0) {
      results.push({ command, args, status: 'skipped', reason: 'previous-check-failed' });
      continue;
    }
    if (!json) process.stdout.write(`\n> ${command} ${args.join(' ')}\n`);
    const result = await runStep(command, args, json);
    results.push(result);
    if (!json && result.error) process.stderr.write(`${result.error}\n`);
    if (result.status !== 'passed') exitCode = result.exitCode || 1;
  }
  if (json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: exitCode === 0 ? 'passed' : 'failed', exitCode, steps: results })}\n`);
  process.exitCode = exitCode;
}
