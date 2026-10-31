#!/usr/bin/env node
/**
 * Score a delivered workspace against a HELD-OUT test bundle — mechanically,
 * identically for both arms, and from outside both.
 *
 *   node benchmark/verify-heldout.mjs <workspace-dir> <task-id> [--heldout <dir>]
 *
 * The bundle lives OFF-TREE (default `~/.atoma/benchmark-seeds/<task-id>-heldout`,
 * the Attica corpus is private) and holds test files the arm under test never
 * saw. Each file is copied over the workspace at its own path, the project is
 * rebuilt with its own `npm run build` (the Attica suites exercise the compiled
 * server, so a stale `dist/` would fail a correct source change), and the
 * bundle's files run under the workspace's own vitest. One check per test;
 * a skipped or pending test counts as failed, as the challenge corpus already
 * rules. Installing dependencies is scorer setup, not the arm's work: a
 * workspace without `node_modules` gets `npm ci` before the build.
 *
 * Output: the same JSON shape `verify-tabstat.mjs` prints, which
 * `score-round.mjs` joins onto the driver's CSV.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const dir = process.argv[2];
const spec = process.argv[3];
const heldoutFlag = process.argv.indexOf('--heldout');
const heldout = heldoutFlag > 0 ? process.argv[heldoutFlag + 1] : join(homedir(), '.atoma', 'benchmark-seeds', `${spec}-heldout`);
if (!dir || !spec || !existsSync(dir) || !existsSync(heldout)) {
  console.error('usage: verify-heldout.mjs <workspace-dir> <task-id> [--heldout <dir>]');
  process.exit(2);
}

const checks = [];
const add = (id, ok, detail = '') => checks.push({ id, ok: !!ok, detail: String(detail).slice(0, 300) });
const env = { ...process.env, NO_COLOR: '1', CI: '1', FORCE_COLOR: '0' };
const sh = (cmd, args, timeout) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout, env, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() };
  }
};

/** Every file of the bundle, as workspace-relative paths. */
function walk(root, prefix = '') {
  return readdirSync(join(root, prefix)).flatMap((name) => {
    const rel = prefix ? join(prefix, name) : name;
    return statSync(join(root, rel)).isDirectory() ? walk(root, rel) : [rel];
  });
}
const files = walk(heldout);
const testFiles = files.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
cpSync(heldout, dir, { recursive: true, force: true });

if (!existsSync(join(dir, 'package.json'))) {
  add('B0', false, 'no package.json in the workspace');
} else {
  if (!existsSync(join(dir, 'node_modules'))) {
    const install = sh('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], 300_000);
    if (!install.ok) add('B0', false, `npm ci failed: ${install.out.slice(-250)}`);
  }
  if (checks.length === 0) {
    const build = sh('npm', ['run', '-s', 'build'], 300_000);
    add('B0', build.ok, build.ok ? 'npm run build exit 0' : `npm run build failed: ${build.out.slice(-250)}`);
  }
}

if (checks.every((c) => c.ok)) {
  const scratch = mkdtempSync(join(tmpdir(), 'atoma-heldout-'));
  const report = join(scratch, 'vitest.json');
  const run = sh('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${report}`, ...testFiles], 600_000);
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(report, 'utf8')); } catch {}
  if (!parsed) {
    add('T0', false, `vitest produced no report: ${run.out.slice(-250)}`);
  } else {
    let n = 0;
    for (const file of parsed.testResults ?? []) {
      const rel = relative(dir, file.name);
      if (file.assertionResults.length === 0) add(`T${++n}`, false, `${rel}: no test ran (${file.message ?? file.status})`);
      for (const t of file.assertionResults) {
        const ok = t.status === 'passed';
        add(`T${++n}`, ok, `${rel}: ${t.fullName} — ${t.status}${ok ? '' : ' ' + (t.failureMessages ?? []).join(' ').slice(0, 160)}`);
      }
    }
    for (const f of testFiles) {
      if (!(parsed.testResults ?? []).some((r) => relative(dir, r.name) === f)) add(`T${++n}`, false, `${f}: not reported by vitest`);
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}

const score = checks.filter((c) => c.ok).length;
console.log(JSON.stringify({ dir, spec, heldout, score, total: checks.length, full: score === checks.length, checks }, null, 2));
