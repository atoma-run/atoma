#!/usr/bin/env node
/**
 * Score a delivered workspace against the attica-challenge-v1 suite, from
 * outside both arms, on the HOST: the same eight cases `benchmark:models`
 * runs through `atoma-verify` in the worker container, so round 15's local
 * runs (both arms on the one driver path) are judged by the calibration's
 * instrument.
 *
 *   node benchmark/verify-challenge.mjs <workspace-dir> <task-id>
 *
 * The suite source is read from the corpus, written into a scratch COPY of
 * the workspace (the archive is evidence and stays untouched; its install is
 * linked in) and run with this repository's vitest, rooted at that copy under
 * one explicit config. One check per case; a skipped case counts as failed.
 * Round 15 found the first version blind to a delivery that is a project
 * rather than one file: its own vite config and its installed dependencies
 * made the suite fail to load (0/1 for five atoma deliveries) — see ROUND15.md. Output: the JSON shape `score-round.mjs`
 * joins onto the driver's CSV.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = process.argv[2];
const spec = process.argv[3] ?? 'attica-challenge';
const corpusPath = join(import.meta.dirname, 'attica-challenge-v1', 'corpus.json');
if (!dir || !existsSync(dir)) {
  console.error('usage: verify-challenge.mjs <workspace-dir> <task-id>');
  process.exit(2);
}
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const vitest = resolve(import.meta.dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');

const checks = [];
const add = (id, ok, detail = '') => checks.push({ id, ok: !!ok, detail: String(detail).slice(0, 300) });

if (!existsSync(join(dir, 'challenge.ts'))) {
  add('artefact', false, 'challenge.ts absent');
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'atoma-challenge-'));
  const copy = join(scratch, 'ws');
  // The copy mirrors what `atoma-verify` snapshots for a parent suite: the
  // project as delivered, its install included. A delivery that imports a
  // dependency it installed (round 15: `node-html-parser`, `linkedom`) must
  // resolve it; the archive stays untouched, so the install is linked, not
  // copied, and Vite's cache is pointed away from it.
  cpSync(dir, copy, { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes('/.atoma-') });
  if (existsSync(join(dir, 'node_modules'))) symlinkSync(join(dir, 'node_modules'), join(copy, 'node_modules'), 'dir');
  writeFileSync(join(copy, 'atoma.acceptance.test.ts'), corpus.suite.source);
  // The delivery's own vite/vitest config is not the instrument: it may
  // `include` only its own test file or import `vite` from an install the
  // copy lacks. Like the product's runner (`config: false`, a fixed `include`,
  // workspace discovery stopped), the suite runs under one explicit config.
  writeFileSync(join(copy, 'pnpm-workspace.yaml'), 'packages: []\n');
  const config = join(scratch, 'atoma.vitest.config.mjs');
  writeFileSync(config, `export default { cacheDir: ${JSON.stringify(join(scratch, 'cache'))}, test: { include: ['atoma.acceptance.test.ts'], environment: 'node', watch: false } };\n`);
  const report = join(scratch, 'vitest.json');
  let out = '';
  try {
    out = execFileSync('node', [vitest, 'run', '--root', copy, '--config', config, '--reporter=json', `--outputFile=${report}`], {
      cwd: copy, encoding: 'utf8', timeout: 180_000, env: { ...process.env, NO_COLOR: '1', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(report, 'utf8')); } catch {}
  if (!parsed) add('T0', false, `vitest produced no report: ${out.trim().slice(-250)}`);
  else {
    const results = (parsed.testResults ?? []).flatMap((f) => f.assertionResults.map((t) => ({ ...t, file: f.name, message: f.message })));
    if (results.length === 0) add('T0', false, `no case ran: ${(parsed.testResults?.[0]?.message ?? out).slice(-250)}`);
    results.forEach((t, i) => add(`T${i + 1}`, t.status === 'passed', `${t.fullName} — ${t.status}${t.status === 'passed' ? '' : ' ' + (t.failureMessages ?? []).join(' ').slice(0, 160)}`));
  }
  rmSync(scratch, { recursive: true, force: true });
}

const score = checks.filter((c) => c.ok).length;
console.log(JSON.stringify({ dir, spec, score, total: checks.length, full: score === checks.length, checks }, null, 2));
