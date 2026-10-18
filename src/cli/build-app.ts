/**
 * The run entrypoint.
 *
 * This file used to be 541 lines and, despite living in `examples/`, was the
 * product: the burn-in harness spawns it once per task, its stdout is the
 * source of `burnin/results.csv`, and AGENTS.md documents it as load-bearing
 * in a dozen places. Everything generic lives in `src/run/runner.ts` and the
 * technical setup in `src/run/setup.ts`.
 *
 * The path stays put on purpose: `src/cli/burnin.ts` spawns it by literal
 * path, and moving it buys nothing measurable while touching the one thing
 * AGENTS.md has caught poisoning a whole batch.
 */
import { runTask } from '../run/runner.js';
import { COMPUTE_BRIDGE_ENV } from '../contracts/computeBridge.js';
import { computeRunnerOptions } from '../run/computeRunner.js';

async function main() {
  const argv = process.argv.slice(2), configured = process.env[COMPUTE_BRIDGE_ENV];
  delete process.env[COMPUTE_BRIDGE_ENV];
  // Help must remain quota-free and never require a running bridge.
  if (!configured || argv.includes('--help') || argv.includes('-h')) return runTask(argv);
  const runtime = await computeRunnerOptions(JSON.parse(configured) as unknown);
  try { await runTask(argv, runtime); } finally { runtime.close(); }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
