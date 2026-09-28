#!/usr/bin/env node
/**
 * `npm run check:changed -- <file>…` — `npm run check` scoped to one change.
 *
 * The mender's harness runs this after a model's fix, inside a disposable
 * container of 2 GiB and one CPU on the 4 GB production host. The full check
 * does not fit there, measured 2026-09-28 at the production revision: the
 * type-aware lint of the whole tree peaks at 3.5 GiB resident and aborted at
 * the container's 1536 MiB heap after 191 s, and the suite alone took 18
 * minutes on its one worker, on a desktop core faster than the host's, of a
 * mend's 30-minute phase. So the docs check and the typecheck run whole, as in
 * `npm run check`, ESLint covers the changed files (three of them peak at
 * 1.1 GiB) and the tests are the changed test files. CI runs the full
 * `npm run check` on the pushed branch and on the pull request, and the
 * ruleset on `main` requires it before any merge.
 *
 * Dependency-free, like every script `docs:check` may run before a build.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LINTABLE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /^tests\/.*\.test\.[cm]?[jt]sx?$/;

/**
 * The commands, in order, for a set of changed repository paths. A deleted
 * path is skipped, since there is nothing left to lint or run; an empty change
 * still gets the whole-tree steps.
 *
 * @param {readonly string[]} files
 * @param {(file: string) => boolean} [exists]
 * @returns {Array<[string, string[]]>}
 */
export function changedCheckSteps(files, exists = existsSync) {
  const present = [...new Set(files)].filter((file) => exists(file));
  const lintable = present.filter((file) => LINTABLE.test(file));
  const tests = present.filter((file) => TEST_FILE.test(file));
  return [
    ['npm', ['run', 'docs:check']],
    ['npm', ['run', 'typecheck']],
    ...(lintable.length > 0 ? [['npx', ['eslint', ...lintable]]] : []),
    ...(tests.length > 0 ? [['npx', ['vitest', 'run', ...tests]]] : []),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [command, args] of changedCheckSteps(process.argv.slice(2))) {
    process.stdout.write(`\n> ${command} ${args.join(' ')}\n`);
    const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
