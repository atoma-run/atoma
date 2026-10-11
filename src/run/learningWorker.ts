import { executeApprovedLearning, LEARNING_TIMEOUT_MS, LEARNING_QUEUE_WAIT_MS } from './learning.js';

const dbPath = process.env['ATOMA_DB_PATH'];
const runId = process.argv[2];
if (!dbPath || !runId) throw new Error('Learning worker requires a store and an approved job');
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort(new Error('Learning host stopped')));
process.once('SIGINT', () => stop.abort(new Error('Learning host stopped')));
// A transport ignoring abort cannot keep a worker, or its claim, alive forever.
let watchdog = setTimeout(() => process.exit(1), LEARNING_QUEUE_WAIT_MS + 10_000);
try {
  await executeApprovedLearning(dbPath, runId, process.env, {
    signal: stop.signal,
    onClaim: () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => process.exit(1), LEARNING_TIMEOUT_MS + 10_000);
    },
  });
} finally { clearTimeout(watchdog); }
process.exit(0);
