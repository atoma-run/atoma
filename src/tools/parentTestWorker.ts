/** Runs only in the sandboxed child process, never in the control plane. */
import { startVitest } from 'vitest/node';
import { fileURLToPath } from 'node:url';

const root = process.argv[2]!;
const vitest = await startVitest('test', [], {
  root, config: false, watch: false, include: ['atoma.acceptance.test.ts'],
  reporters: ['json'], outputFile: `${root}/atoma.report.json`,
  pool: 'threads', execArgv: process.execArgv.filter(arg => arg !== '--allow-worker' && arg !== '--allow-addons'), maxWorkers: 1, fileParallelism: false,
  allowOnly: false, passWithNoTests: false, testTimeout: 10_000, hookTimeout: 10_000,
  environment: 'node', isolate: true,
}, {
  resolve: { alias: { vitest: fileURLToPath(import.meta.resolve('vitest')) } },
});
await vitest.close();
